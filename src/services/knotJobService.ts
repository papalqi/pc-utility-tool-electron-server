import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { config } from '../config'
import { logger } from '../utils/logger'
import {
  defaultTimeoutForKind,
  inferMachineJobKind,
  isInternalFleetScriptId,
  isKnownFleetScriptId,
  isFleetScriptId,
  normalizeMachineTarget,
  resolveFleetScriptId,
  targetsMatch,
  validateMachineJobCreate,
  type KnotAgentHeartbeat,
  type KnotJob,
  type KnotJobCreateRequest,
  type KnotJobStatus,
  type InternalFleetScriptId,
  type MachineJobKind,
} from '../lib/knotDispatch'
import { mergeCatalogAgents } from '../lib/fleetCatalog'

const log = logger.createScope('KnotJobService')
const MAX_JOBS = 200
const AGENT_TTL_MS = 2 * 60_000

type JobStore = {
  jobs: KnotJob[]
  agents: Record<string, KnotAgentHeartbeat>
  retirements: Record<string, HapiSkillRetirement>
}

export type HapiSkillRetirementStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export type HapiSkillRetirement = {
  id: string
  skillName: string
  targets: string[]
  registryTarget: string
  localJobIds: Record<string, string>
  registryJobId?: string
  status: HapiSkillRetirementStatus
  createdAt: number
  updatedAt: number
  error?: string
}

export type HapiSkillRetirementRequest = {
  skillName: string
  targets: string[]
  registryTarget: string
}

const HAPI_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RETIREMENT_AGENT_TTL_MS = 180_000

export class KnotJobService {
  private filePath: string
  private store: JobStore = { jobs: [], agents: {}, retirements: {} }

  constructor(filePath = path.join(config.updates.dir, '..', 'knot-jobs.json')) {
    this.filePath = filePath
    this.load()
    if (Object.keys(this.store.retirements).length > 0) {
      this.recoverRetirements()
      this.save()
    }
  }

  listJobs(limit = 50, filter?: { target?: string; status?: KnotJobStatus; kind?: MachineJobKind }): KnotJob[] {
    let jobs = this.store.jobs
    if (filter?.target) {
      const target = normalizeMachineTarget(filter.target)
      jobs = jobs.filter((job) => job.targetNormalized === target)
    }
    if (filter?.status) jobs = jobs.filter((job) => job.status === filter.status)
    if (filter?.kind) jobs = jobs.filter((job) => (job.kind || 'knot') === filter.kind)
    return jobs.slice(0, Math.max(1, Math.min(limit, 200)))
  }

  listRepos(target?: string): Array<KnotAgentHeartbeat & { repos: NonNullable<KnotAgentHeartbeat['repos']> }> {
    const agents = this.listAgents().filter((agent) => (agent.repos || []).length > 0)
    const filtered = target
      ? agents.filter((agent) => targetsMatch(target, agent.hostname))
      : agents
    return filtered.map((agent) => ({ ...agent, repos: agent.repos || [] }))
  }

  getJob(id: string): KnotJob | undefined {
    return this.store.jobs.find((job) => job.id === id)
  }

  listAgents(): KnotAgentHeartbeat[] {
    const now = Date.now()
    const live = Object.values(this.store.agents)
      .filter((agent) => now - (agent.seenAt || 0) < AGENT_TTL_MS * 3)
      .sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0))
    return mergeCatalogAgents(live)
  }

  createJob(input: KnotJobCreateRequest): KnotJob {
    const error = validateMachineJobCreate(input)
    if (error) throw new Error(error)
    const target = (input.target || '').trim()
    const kind = inferMachineJobKind(input)
    const scriptIdRaw = resolveFleetScriptId(input)
    const scriptId = isFleetScriptId(scriptIdRaw) ? scriptIdRaw : undefined
    if (this.isHapiSkillMutation(scriptId)) {
      const directName = this.validateHapiSkillName(input.skillName || '')
      const directoryName = this.skillNameFromDirectory(input.skillDirectory)
      if (directName && directoryName && directName !== directoryName) {
        throw new Error('skillName must match skillDirectory basename for HAPI skill mutations')
      }
      const skillName = this.skillNameFromJobInput(input)
      if (skillName && this.hasRetirementTombstone(skillName)) {
        throw new Error(`HAPI skill ${skillName} has a retirement record and cannot be ${scriptId}`)
      }
    }
    const job: KnotJob = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      target,
      targetNormalized: normalizeMachineTarget(target),
      kind,
      scriptId,
      repo: input.repo?.trim() || undefined,
      cwd: (input.cwd || '').trim(),
      prompt: (input.prompt || '').trim(),
      model: input.model?.trim() || undefined,
      agentId: input.agentId?.trim() || undefined,
      gitAction: input.gitAction,
      script: input.script,
      project: input.project?.trim() || undefined,
      buildConfig: input.buildConfig?.trim() || undefined,
      platform: input.platform?.trim() || undefined,
      skillAction: input.skillAction,
      skillName: input.skillName?.trim() || undefined,
      skillDirectory: input.skillDirectory?.trim() || undefined,
      timeoutMs:
        typeof input.timeoutMs === 'number' && input.timeoutMs > 0
          ? input.timeoutMs
          : defaultTimeoutForKind(kind, scriptId),
      status: 'queued',
      createdAt: Date.now(),
    }
    this.store.jobs.unshift(job)
    if (this.store.jobs.length > MAX_JOBS) this.store.jobs.length = MAX_JOBS
    this.save()
    log.info('job created', { id: job.id, target: job.targetNormalized, kind: job.kind })
    return job
  }

  heartbeat(input: Omit<KnotAgentHeartbeat, 'hostnameNormalized' | 'seenAt'> & { hostname: string }): KnotAgentHeartbeat {
    const hostname = (input.hostname || '').trim()
    if (!hostname) throw new Error('hostname required')
    const record: KnotAgentHeartbeat = {
      hostname,
      hostnameNormalized: normalizeMachineTarget(hostname),
      knotFound: Boolean(input.knotFound),
      knotPath: input.knotPath,
      knotVersion: input.knotVersion,
      knotSource: input.knotSource,
      repos: Array.isArray(input.repos) ? input.repos : [],
      projects: Array.isArray(input.projects) ? input.projects : [],
      skills: Array.isArray(input.skills) ? input.skills : [],
      skillRoots: Array.isArray(input.skillRoots) ? input.skillRoots : [],
      cch: input.cch,
      seenAt: Date.now(),
    }
    this.store.agents[record.hostnameNormalized] = record
    this.save()
    return record
  }

  claimNext(hostname: string): KnotJob | null {
    const now = Date.now()
    const job = this.store.jobs.find((item) => {
      if (item.status !== 'queued') return false
      return targetsMatch(item.target, hostname)
    })
    if (!job) return null
    job.status = 'running'
    job.claimedAt = now
    job.claimedBy = hostname
    this.updateRetirementForJob(job)
    this.save()
    return job
  }

  finishJob(
    id: string,
    hostname: string,
    result: { status: Extract<KnotJobStatus, 'succeeded' | 'failed' | 'cancelled'>; output?: string; error?: string; exitCode?: number | null }
  ): KnotJob {
    const job = this.getJob(id)
    if (!job) throw new Error('job not found')
    if (job.status !== 'running') {
      throw new Error(`job already ${job.status}`)
    }
    if (!job.claimedBy || !targetsMatch(job.target, hostname) || !targetsMatch(job.claimedBy, hostname)) {
      throw new Error('hostname does not own this job')
    }
    if (result.status === 'succeeded' && isInternalFleetScriptId(job.scriptId)) {
      const receiptError = validateRetirementReceipt(job, result.output)
      if (receiptError) throw new Error(receiptError)
    }
    job.status = result.status
    job.output = clip(result.output, 200_000)
    job.error = clip(result.error, 20_000)
    job.exitCode = result.exitCode ?? null
    job.finishedAt = Date.now()
    this.updateRetirementForJob(job)
    this.save()
    return job
  }

  createHapiSkillRetirement(input: HapiSkillRetirementRequest): HapiSkillRetirement {
    const skillName = this.validateHapiSkillName(input.skillName)
    const { targets, registryTarget } = this.resolveRetirementTargets(input.targets, input.registryTarget)
    const existing = Object.values(this.store.retirements).find(
      (operation) => operation.skillName === skillName && this.isRetirementUnresolved(operation)
    )
    if (existing) {
      const sameTargets =
        existing.targets.length === targets.length &&
        existing.targets.every((target) => targets.includes(target))
      if (!sameTargets || existing.registryTarget !== registryTarget) {
        throw new Error(`an unresolved retirement for ${skillName} already has a different target set`)
      }
      return existing
    }
    if (this.hasActiveHapiSkillMutation(skillName)) {
      throw new Error(`HAPI skill ${skillName} has a queued or running sync, publish, or install job`)
    }
    this.requireOnlineTargets(targets)
    const now = Date.now()
    const operation: HapiSkillRetirement = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      skillName,
      targets,
      registryTarget,
      localJobIds: {},
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    }
    for (const target of targets) {
      operation.localJobIds[target] = this.createInternalScriptJob(target, 'hapi-skill-retire-local', skillName).id
    }
    this.store.retirements[operation.id] = operation
    this.save()
    log.info('HAPI skill retirement created', { id: operation.id, skillName, targets })
    return operation
  }

  getHapiSkillRetirement(id: string): HapiSkillRetirement | undefined {
    return this.store.retirements[id]
  }

  getHapiSkillRetirementResult(id: string):
    | { operation: HapiSkillRetirement; localJobs: KnotJob[]; registryJob?: KnotJob }
    | undefined {
    const operation = this.getHapiSkillRetirement(id)
    if (!operation) return undefined
    const localJobs = Object.values(operation.localJobIds)
      .map((jobId) => this.getJob(jobId))
      .filter((job): job is KnotJob => Boolean(job))
    return {
      operation,
      localJobs,
      registryJob: operation.registryJobId ? this.getJob(operation.registryJobId) : undefined,
    }
  }

  retryHapiSkillRetirement(id: string): HapiSkillRetirement {
    const operation = this.getHapiSkillRetirement(id)
    if (!operation) throw new Error(`HAPI skill retirement not found: ${id}`)
    if (operation.status === 'succeeded') return operation
    let requeued = false
    const retryTargets: string[] = []
    const now = Date.now()
    for (const target of operation.targets) {
      const current = this.getJob(operation.localJobIds[target])
      if (current?.status === 'running' && this.isTimedOut(current, now)) {
        current.status = 'cancelled'
        current.error = 'cancelled by retirement retry after timeout'
        current.finishedAt = now
      }
      if (!current || current.status === 'failed' || current.status === 'cancelled') {
        retryTargets.push(target)
      }
    }
    const requiredOnline = [...new Set([...retryTargets, operation.registryTarget])]
    this.requireOnlineTargets(requiredOnline)
    for (const target of retryTargets) {
      operation.localJobIds[target] = this.createInternalScriptJob(
        target,
        'hapi-skill-retire-local',
        operation.skillName
      ).id
      requeued = true
    }
    const localJobs = operation.targets.map((target) => this.getJob(operation.localJobIds[target]))
    const localComplete = localJobs.every((job) => job?.status === 'succeeded')
    const registryJob = operation.registryJobId ? this.getJob(operation.registryJobId) : undefined
    if (registryJob?.status === 'running' && this.isTimedOut(registryJob, now)) {
      registryJob.status = 'cancelled'
      registryJob.error = 'cancelled by retirement retry after timeout'
      registryJob.finishedAt = now
    }
    if (localComplete && (!registryJob || registryJob.status === 'failed' || registryJob.status === 'cancelled')) {
      operation.registryJobId = this.createInternalScriptJob(
        operation.registryTarget,
        'hapi-skill-retire-registry',
        operation.skillName
      ).id
      requeued = true
    }
    if (requeued) {
      operation.status = 'queued'
      operation.error = undefined
      operation.updatedAt = Date.now()
      this.save()
    }
    return operation
  }

  private validateHapiSkillName(value: string): string {
    const skillName = (value || '').trim()
    if (skillName.length < 1 || skillName.length > 64 || !HAPI_SKILL_NAME.test(skillName)) {
      throw new Error('skillName must be 1-64 lowercase letters/numbers joined by single hyphens')
    }
    return skillName
  }

  private resolveRetirementTargets(rawTargets: string[], rawRegistryTarget: string): { targets: string[]; registryTarget: string } {
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) throw new Error('targets required')
    const normalized = new Map<string, string>()
    for (const rawTarget of rawTargets) {
      const target = (rawTarget || '').trim()
      const key = normalizeMachineTarget(target)
      if (!target || !key) throw new Error('targets must contain non-empty machine names')
      if (!normalized.has(key)) normalized.set(key, key)
    }
    const registryKey = normalizeMachineTarget((rawRegistryTarget || '').trim())
    const registryTarget = normalized.get(registryKey)
    if (!registryTarget) throw new Error('registryTarget must be included in targets')
    return { targets: [...normalized.values()], registryTarget }
  }

  private requireOnlineTargets(targets: string[]): void {
    const now = Date.now()
    const offline = targets.filter((target) => {
      const agent = Object.values(this.store.agents).find((item) => targetsMatch(target, item.hostname))
      return !agent || now - (agent.seenAt || 0) >= RETIREMENT_AGENT_TTL_MS
    })
    if (offline.length > 0) throw new Error(`all retirement targets must be online (seen within 180s): ${offline.join(', ')}`)
  }

  private createInternalScriptJob(target: string, scriptId: InternalFleetScriptId, skillName: string): KnotJob {
    if (!isInternalFleetScriptId(scriptId)) throw new Error('invalid internal retirement script')
    const job: KnotJob = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      target,
      targetNormalized: normalizeMachineTarget(target),
      kind: 'script',
      scriptId,
      cwd: '',
      prompt: '',
      skillName,
      timeoutMs: defaultTimeoutForKind('script', scriptId),
      status: 'queued',
      createdAt: Date.now(),
    }
    this.store.jobs.unshift(job)
    if (this.store.jobs.length > MAX_JOBS) this.store.jobs.length = MAX_JOBS
    return job
  }

  private updateRetirementForJob(job: KnotJob): void {
    const operation = Object.values(this.store.retirements).find(
      (item) => item.registryJobId === job.id || Object.values(item.localJobIds).includes(job.id)
    )
    if (!operation) return
    this.advanceRetirement(operation)
  }

  private advanceRetirement(operation: HapiSkillRetirement): void {
    const localJobs = operation.targets.map((target) => this.getJob(operation.localJobIds[target]))
    if (!localJobs.every((job): job is KnotJob => Boolean(job))) {
      operation.status = 'failed'
      operation.error = 'a local skill retirement job is missing'
      operation.updatedAt = Date.now()
      return
    }
    if (localJobs.some((job) => job.status === 'failed' || job.status === 'cancelled')) {
      operation.status = 'failed'
      operation.error = 'a local skill retirement job failed or was cancelled'
      operation.updatedAt = Date.now()
      return
    }
    if (!localJobs.every((job) => job.status === 'succeeded')) {
      operation.status = localJobs.some((job) => job.status === 'running') ? 'running' : 'queued'
      operation.updatedAt = Date.now()
      return
    }
    let registryJob = operation.registryJobId ? this.getJob(operation.registryJobId) : undefined
    if (!registryJob) {
      registryJob = this.createInternalScriptJob(operation.registryTarget, 'hapi-skill-retire-registry', operation.skillName)
      operation.registryJobId = registryJob.id
      operation.status = 'queued'
      operation.updatedAt = Date.now()
      return
    }
    if (registryJob.status === 'succeeded') {
      operation.status = 'succeeded'
      operation.error = undefined
    } else if (registryJob.status === 'failed' || registryJob.status === 'cancelled') {
      operation.status = 'failed'
      operation.error = 'registry skill retirement job failed or was cancelled'
    } else {
      operation.status = registryJob.status === 'running' ? 'running' : 'queued'
    }
    operation.updatedAt = Date.now()
  }

  private isRetirementUnresolved(operation: HapiSkillRetirement): boolean {
    return operation.status !== 'succeeded'
  }

  private isHapiSkillMutation(scriptId: string | undefined): boolean {
    return scriptId === 'hapi-skill-sync' || scriptId === 'hapi-skill-publish' || scriptId === 'hapi-skill-install'
  }

  private skillNameFromJobInput(input: KnotJobCreateRequest): string | undefined {
    const direct = input.skillName?.trim()
    if (direct) return direct.toLowerCase()
    return this.skillNameFromDirectory(input.skillDirectory)
  }

  private skillNameFromDirectory(value: string | undefined): string | undefined {
    const directory = value?.trim()
    if (!directory) return undefined
    const normalized = directory.replace(/\\/g, '/').replace(/\/+$/, '')
    return normalized.split('/').pop()?.toLowerCase() || undefined
  }

  private hasRetirementTombstone(skillName: string): boolean {
    return Object.values(this.store.retirements).some((operation) => operation.skillName === skillName)
  }

  private hasActiveHapiSkillMutation(skillName: string): boolean {
    return this.store.jobs.some(
      (job) =>
        (job.status === 'queued' || job.status === 'running') &&
        this.isHapiSkillMutation(job.scriptId) &&
        this.skillNameMatches(job, skillName)
    )
  }

  private skillNameMatches(job: KnotJob, skillName: string): boolean {
    if (job.skillName?.trim().toLowerCase() === skillName) return true
    return this.skillNameFromDirectory(job.skillDirectory) === skillName
  }

  private isTimedOut(job: KnotJob, now: number): boolean {
    const startedAt = job.claimedAt || job.createdAt
    return now - startedAt > job.timeoutMs
  }

  private recoverRetirements(): void {
    for (const operation of Object.values(this.store.retirements)) this.advanceRetirement(operation)
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<JobStore>
      this.store = {
        jobs: Array.isArray(parsed.jobs)
          ? parsed.jobs.map((job) => {
              const scriptIdRaw = job.scriptId || resolveFleetScriptId(job)
              const scriptId = isKnownFleetScriptId(scriptIdRaw) ? scriptIdRaw : undefined
              const kind: MachineJobKind =
                job.kind === 'knot' || (!job.kind && !scriptId) ? 'knot' : 'script'
              return { ...job, kind, scriptId, cwd: job.cwd || '' }
            })
          : [],
        agents: parsed.agents && typeof parsed.agents === 'object' ? parsed.agents : {},
        retirements: parsed.retirements && typeof parsed.retirements === 'object' ? parsed.retirements : {},
      }
    } catch {
      this.store = { jobs: [], agents: {}, retirements: {} }
    }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), 'utf8')
    } catch (error) {
      log.warn('failed to persist knot jobs', error)
    }
  }
}

const REQUIRED_HAPI_SKILL_ROOT_SUFFIXES = [
  '.grok/skills',
  '.codex/skills',
  '.claude/skills',
  '.cursor/skills',
  '.copilot/skills',
] as const

function validateRetirementReceipt(job: KnotJob, output: string | undefined): string | null {
  if (!output) return 'retirement succeeded without a JSON receipt'
  let receipt: unknown
  try {
    receipt = JSON.parse(output)
  } catch {
    return 'retirement succeeded with invalid JSON receipt'
  }
  if (!isRecord(receipt) || typeof job.skillName !== 'string' || receipt.skillName !== job.skillName) {
    return 'retirement receipt skillName mismatch'
  }
  if (job.scriptId === 'hapi-skill-retire-registry') {
    return receipt.state === 'absent' && receipt.verifiedAbsent === true
      ? null
      : 'registry retirement receipt does not prove absence'
  }
  if (job.scriptId !== 'hapi-skill-retire-local') return 'unknown retirement receipt type'
  if (receipt.verifiedAbsent !== true || !Array.isArray(receipt.roots) || receipt.roots.length < 5) {
    return 'local retirement receipt does not prove every root absent'
  }
  const roots = new Set<string>()
  const covered = new Set<string>()
  for (const rootResult of receipt.roots) {
    if (!isRecord(rootResult) || typeof rootResult.root !== 'string') return 'local retirement receipt has invalid root'
    if (rootResult.verifiedAbsent !== true || (rootResult.state !== 'removed' && rootResult.state !== 'absent')) {
      return 'local retirement receipt has an unverified root'
    }
    const normalizedRoot = normalizeReceiptRoot(rootResult.root)
    if (!normalizedRoot || roots.has(normalizedRoot)) return 'local retirement receipt has duplicate roots'
    roots.add(normalizedRoot)
    for (const suffix of REQUIRED_HAPI_SKILL_ROOT_SUFFIXES) {
      if (normalizedRoot.endsWith(suffix)) covered.add(suffix)
    }
  }
  return covered.size === REQUIRED_HAPI_SKILL_ROOT_SUFFIXES.length
    ? null
    : 'local retirement receipt does not cover every supported skill root'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeReceiptRoot(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function clip(value: string | undefined, max: number): string | undefined {
  if (value == null) return undefined
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`
}

export const knotJobService = new KnotJobService()
