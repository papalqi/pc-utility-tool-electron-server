import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { config } from '../config'
import { logger } from '../utils/logger'
import {
  defaultTimeoutForKind,
  inferMachineJobKind,
  isFleetScriptId,
  normalizeMachineTarget,
  resolveFleetScriptId,
  targetsMatch,
  validateMachineJobCreate,
  type KnotAgentHeartbeat,
  type KnotJob,
  type KnotJobCreateRequest,
  type KnotJobStatus,
  type MachineJobKind,
} from '../lib/knotDispatch'
import { mergeCatalogAgents } from '../lib/fleetCatalog'

const log = logger.createScope('KnotJobService')
const MAX_JOBS = 200
const AGENT_TTL_MS = 2 * 60_000

type JobStore = {
  jobs: KnotJob[]
  agents: Record<string, KnotAgentHeartbeat>
}

class KnotJobService {
  private filePath: string
  private store: JobStore = { jobs: [], agents: {} }

  constructor() {
    this.filePath = path.join(config.updates.dir, '..', 'knot-jobs.json')
    this.load()
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
    if (job.status !== 'running' && job.status !== 'queued') {
      throw new Error(`job already ${job.status}`)
    }
    if (job.claimedBy && !targetsMatch(job.claimedBy, hostname) && !targetsMatch(job.target, hostname)) {
      throw new Error('hostname does not own this job')
    }
    job.status = result.status
    job.output = clip(result.output, 200_000)
    job.error = clip(result.error, 20_000)
    job.exitCode = result.exitCode ?? null
    job.finishedAt = Date.now()
    this.save()
    return job
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as JobStore
      this.store = {
        jobs: Array.isArray(parsed.jobs)
          ? parsed.jobs.map((job) => {
              const scriptIdRaw = job.scriptId || resolveFleetScriptId(job)
              const scriptId = isFleetScriptId(scriptIdRaw) ? scriptIdRaw : undefined
              const kind: MachineJobKind =
                job.kind === 'knot' || (!job.kind && !scriptId) ? 'knot' : 'script'
              return { ...job, kind, scriptId, cwd: job.cwd || '' }
            })
          : [],
        agents: parsed.agents && typeof parsed.agents === 'object' ? parsed.agents : {},
      }
    } catch {
      this.store = { jobs: [], agents: {} }
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

function clip(value: string | undefined, max: number): string | undefined {
  if (value == null) return undefined
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`
}

export const knotJobService = new KnotJobService()
