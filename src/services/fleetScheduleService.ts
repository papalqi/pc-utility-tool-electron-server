import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { config } from '../config'
import { logger } from '../utils/logger'
import { isCronMatch, validateCronExpression } from '../lib/cron'
import {
  FLEET_SCHEDULE_BLOCK_LABELS,
  STALL_QUEUED_MS,
  ONLINE_TTL_MS,
  effectiveScheduleSteps,
  isCompileScheduleStep,
  isDirtyWorkspaceError,
  isFleetScheduleStepId,
  isMhaRepoAlias,
  parseGitStatusDirty,
  type FleetSchedule,
  type FleetScheduleBlockReason,
  type FleetScheduleInput,
  type FleetScheduleRun,
  type FleetScheduleRunStatus,
  type FleetScheduleStepId,
  type FleetScheduleStepState,
  type FleetScheduleUnit,
  type FleetScheduleUnitStatus,
} from '../lib/fleetSchedules'
import { findCatalogMachine } from '../lib/fleetCatalog'
import { normalizeMachineTarget, targetsMatch, type KnotAgentHeartbeat, type KnotJob } from '../lib/knotDispatch'
import { KnotJobService, knotJobService } from './knotJobService'

const log = logger.createScope('FleetScheduleService')
const MAX_SCHEDULES = 40
const MAX_RUNS = 40
const TICK_INTERVAL_MS = 5_000

type Store = {
  schedules: FleetSchedule[]
  runs: FleetScheduleRun[]
}

function clip(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function minuteKey(timestamp: number): number {
  return Math.floor(timestamp / 60_000)
}

function newId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function uniqueTrimmed(values: string[] | undefined): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of values || []) {
    const value = raw.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function terminalUnit(status: FleetScheduleUnitStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'blocked'
}

function terminalStep(step: FleetScheduleStepState): boolean {
  return (
    step.status === 'succeeded' ||
    step.status === 'failed' ||
    step.status === 'blocked' ||
    step.status === 'skipped'
  )
}

function inFlightStep(step: FleetScheduleStepState): boolean {
  return step.status === 'queued' || step.status === 'running'
}

function blockUnit(unit: FleetScheduleUnit, reason: FleetScheduleBlockReason, message?: string, fromIndex = 0): void {
  unit.status = 'blocked'
  unit.blockedReason = reason
  unit.blockedMessage = message || FLEET_SCHEDULE_BLOCK_LABELS[reason]
  for (let i = fromIndex; i < unit.steps.length; i += 1) {
    const step = unit.steps[i]
    if (terminalStep(step) && step.status !== 'pending') continue
    if (step.status === 'pending' || inFlightStep(step)) {
      step.status = 'blocked'
      step.blockedReason = i === fromIndex ? reason : 'prev-failed'
      step.finishedAt = Date.now()
    }
  }
}

function failUnit(unit: FleetScheduleUnit, message: string, fromIndex: number): void {
  unit.status = 'failed'
  unit.blockedMessage = message
  const current = unit.steps[fromIndex]
  if (current) {
    current.status = 'failed'
    current.error = message
    current.finishedAt = Date.now()
  }
  for (let i = fromIndex + 1; i < unit.steps.length; i += 1) {
    const step = unit.steps[i]
    if (step.status === 'pending') {
      step.status = 'blocked'
      step.blockedReason = 'prev-failed'
    }
  }
}

export class FleetScheduleService {
  private store: Store = { schedules: [], runs: [] }
  private filePath: string
  private tickTimer: NodeJS.Timeout | null = null
  private lastScheduledMinute = new Map<string, number>()

  constructor(
    private readonly jobs: KnotJobService,
    filePath = path.join(config.updates.dir, '..', 'fleet-schedules.json'),
    private readonly clock: () => number = Date.now
  ) {
    this.filePath = filePath
    this.load()
  }

  start(): void {
    if (this.tickTimer) return
    this.tickTimer = setInterval(() => {
      try {
        this.tick()
      } catch (error) {
        log.error('tick failed', error)
      }
    }, TICK_INTERVAL_MS)
    this.tick()
    log.info('scheduler started', { intervalMs: TICK_INTERVAL_MS })
  }

  stop(): void {
    if (!this.tickTimer) return
    clearInterval(this.tickTimer)
    this.tickTimer = null
  }

  listSchedules(): FleetSchedule[] {
    return this.store.schedules.map((item) => ({ ...item, targets: [...item.targets], repos: [...item.repos], steps: [...item.steps] }))
  }

  getSchedule(id: string): FleetSchedule | undefined {
    return this.store.schedules.find((item) => item.id === id)
  }

  listRuns(limit = 20, scheduleId?: string): FleetScheduleRun[] {
    const runs = scheduleId
      ? this.store.runs.filter((run) => run.scheduleId === scheduleId)
      : this.store.runs
    return runs.slice(0, Math.max(1, Math.min(limit, MAX_RUNS))).map((run) => this.cloneRun(run))
  }

  getRun(id: string): FleetScheduleRun | undefined {
    const run = this.store.runs.find((item) => item.id === id)
    return run ? this.cloneRun(run) : undefined
  }

  snapshot(): { schedules: FleetSchedule[]; runs: FleetScheduleRun[] } {
    this.syncRunningRuns()
    return {
      schedules: this.listSchedules(),
      runs: this.listRuns(30),
    }
  }

  saveSchedule(input: FleetScheduleInput): FleetSchedule {
    const name = (input.name || '').trim()
    if (!name) throw new Error('name required')
    const cron = (input.cron || '').trim()
    const cronCheck = validateCronExpression(cron)
    if (!cronCheck.ok) throw new Error(cronCheck.error)
    const targets = uniqueTrimmed(input.targets)
    if (targets.length !== 1) throw new Error('exactly one machine required')
    const repos = uniqueTrimmed(input.repos)
    if (repos.length !== 1) throw new Error('exactly one repo alias required')
    const steps = uniqueTrimmed(input.steps).filter(isFleetScheduleStepId)
    if (steps.length === 0) throw new Error('at least one step required')
    const now = this.clock()
    const existing = input.id ? this.getSchedule(input.id) : undefined
    const schedule: FleetSchedule = {
      id: existing?.id || input.id || newId(),
      name,
      enabled: Boolean(input.enabled),
      cron,
      targets,
      repos,
      steps,
      skipIfDirty: input.skipIfDirty !== false,
      skipOffline: input.skipOffline !== false,
      buildConfig: (input.buildConfig || '').trim() || undefined,
      platform: (input.platform || '').trim() || undefined,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    if (existing) {
      this.store.schedules = this.store.schedules.map((item) => (item.id === existing.id ? schedule : item))
    } else {
      if (this.store.schedules.length >= MAX_SCHEDULES) {
        throw new Error(`at most ${MAX_SCHEDULES} schedules`)
      }
      this.store.schedules.unshift(schedule)
    }
    this.save()
    log.info('schedule saved', { id: schedule.id, name: schedule.name, cron: schedule.cron, enabled: schedule.enabled })
    return schedule
  }

  deleteSchedule(id: string): boolean {
    const before = this.store.schedules.length
    this.store.schedules = this.store.schedules.filter((item) => item.id !== id)
    this.lastScheduledMinute.delete(id)
    if (this.store.schedules.length === before) return false
    this.save()
    return true
  }

  setEnabled(id: string, enabled: boolean): FleetSchedule {
    const schedule = this.getSchedule(id)
    if (!schedule) throw new Error('schedule not found')
    schedule.enabled = enabled
    schedule.updatedAt = this.clock()
    this.save()
    return schedule
  }

  runNow(id: string): FleetScheduleRun {
    const schedule = this.getSchedule(id)
    if (!schedule) throw new Error('schedule not found')
    return this.startRun(schedule, 'manual')
  }

  tick(): void {
    const now = this.clock()
    const date = new Date(now)
    const key = minuteKey(now)

    for (const schedule of this.store.schedules) {
      if (!schedule.enabled) continue
      if (this.lastScheduledMinute.get(schedule.id) === key) continue
      if (this.hasActiveRun(schedule.id)) continue
      const match = isCronMatch(schedule.cron, date)
      if (!match.ok) {
        log.error('invalid cron', { id: schedule.id, cron: schedule.cron, error: match.error })
        continue
      }
      if (!match.matches) continue
      this.lastScheduledMinute.set(schedule.id, key)
      try {
        this.startRun(schedule, 'scheduled')
      } catch (error) {
        log.error('scheduled run failed to start', { id: schedule.id, error })
      }
    }

    this.syncRunningRuns()
    this.advanceRunningRuns()
    this.save()
  }

  private hasActiveRun(scheduleId: string): boolean {
    return this.store.runs.some((run) => run.scheduleId === scheduleId && run.status === 'running')
  }

  private startRun(schedule: FleetSchedule, reason: 'scheduled' | 'manual'): FleetScheduleRun {
    if (schedule.targets.length !== 1 || schedule.repos.length !== 1) {
      throw new Error('exactly one machine and one repo required')
    }
    if (this.hasActiveRun(schedule.id)) {
      throw new Error('schedule already has a running run')
    }
    const now = this.clock()
    const steps = effectiveScheduleSteps(schedule.steps, schedule.skipIfDirty)
    const units = this.buildUnits(schedule, steps)
    if (units.length === 0) {
      throw new Error('no matching machine/repo units to run')
    }
    const run: FleetScheduleRun = {
      id: newId(),
      scheduleId: schedule.id,
      name: schedule.name,
      startedAt: now,
      status: 'running',
      reason,
      skipIfDirty: schedule.skipIfDirty,
      skipOffline: schedule.skipOffline,
      buildConfig: schedule.buildConfig,
      platform: schedule.platform,
      blockedCount: 0,
      failedCount: 0,
      succeededCount: 0,
      units,
    }
    this.recount(run)
    this.store.runs.unshift(run)
    if (this.store.runs.length > MAX_RUNS) this.store.runs.length = MAX_RUNS
    this.advanceRun(run)
    this.recount(run)
    this.save()
    log.info('run started', { id: run.id, scheduleId: schedule.id, reason, units: units.length })
    return this.cloneRun(run)
  }

  private buildUnits(schedule: FleetSchedule, steps: FleetScheduleStepId[]): FleetScheduleUnit[] {
    const now = this.clock()
    const agents = this.jobs.listAgents()
    const selectedTargets = schedule.targets.length
      ? schedule.targets
      : agents
          .filter((agent) => now - (agent.seenAt || 0) < ONLINE_TTL_MS)
          .map((agent) => agent.hostname)

    const units: FleetScheduleUnit[] = []
    const seen = new Set<string>()

    for (const rawTarget of selectedTargets) {
      const spec = findCatalogMachine(rawTarget)
      const hostname = spec?.hostname || rawTarget
      const normalized = normalizeMachineTarget(hostname)
      const agent = agents.find((item) => targetsMatch(hostname, item.hostname))
      const online = Boolean(agent && now - (agent.seenAt || 0) < ONLINE_TTL_MS)

      for (const repo of schedule.repos) {
        const key = `${normalized}::${repo}`
        if (seen.has(key)) continue
        seen.add(key)

        const resolved = this.resolveRepo(hostname, repo, agent, spec)
        const unit: FleetScheduleUnit = {
          id: newId(),
          target: hostname,
          targetNormalized: normalized,
          repo,
          cwd: resolved?.path,
          status: 'pending',
          steps: steps.map((scriptId) => ({ scriptId, status: 'pending' })),
        }

        if (!online && schedule.skipOffline) {
          blockUnit(unit, 'offline')
        } else if (!resolved) {
          blockUnit(unit, 'missing-repo', `该机器没有仓库 ${repo}`)
        }
        units.push(unit)
      }
    }

    return units
  }

  private resolveRepo(
    hostname: string,
    alias: string,
    agent: KnotAgentHeartbeat | undefined,
    spec: ReturnType<typeof findCatalogMachine>
  ): { path: string; exists: boolean } | undefined {
    const wanted = alias.trim().toLowerCase()
    const live = (agent?.repos || []).find((repo) => (repo.alias || '').trim().toLowerCase() === wanted)
    if (live?.path) {
      if (live.exists === false) return undefined
      return { path: live.path, exists: true }
    }
    const expected = spec?.expectedRepos.find((repo) => repo.alias.toLowerCase() === wanted)
    if (expected?.path) return { path: expected.path, exists: true }
    void hostname
    return undefined
  }

  private syncRunningRuns(): void {
    for (const run of this.store.runs) {
      if (run.status !== 'running') continue
      this.syncRunFromJobs(run)
      this.detectStalls(run)
      this.recount(run)
    }
  }

  private advanceRunningRuns(): void {
    for (const run of this.store.runs) {
      if (run.status !== 'running') continue
      this.advanceRun(run)
      this.recount(run)
    }
  }

  private syncRunFromJobs(run: FleetScheduleRun): void {
    for (const unit of run.units) {
      if (terminalUnit(unit.status)) continue
      for (const step of unit.steps) {
        if (!step.jobId) continue
        const job = this.jobs.getJob(step.jobId)
        if (!job) continue
        this.applyJobToStep(unit, step, job)
      }
    }
  }

  private applyJobToStep(unit: FleetScheduleUnit, step: FleetScheduleStepState, job: KnotJob): void {
    if (job.status === 'queued') {
      step.status = 'queued'
      return
    }
    if (job.status === 'running') {
      step.status = 'running'
      step.startedAt = job.claimedAt || step.startedAt
      unit.status = 'running'
      return
    }
    step.finishedAt = job.finishedAt || this.clock()
    if (job.status === 'succeeded') {
      step.status = 'succeeded'
      return
    }
    const error = clip(job.error || job.output, 2000) || `job ${job.status}`
    step.error = error
    const index = unit.steps.indexOf(step)
    if (isDirtyWorkspaceError(job.error, job.output)) {
      blockUnit(unit, 'dirty', undefined, index)
      return
    }
    failUnit(unit, error, index)
  }

  private detectStalls(run: FleetScheduleRun): void {
    const now = this.clock()
    for (const unit of run.units) {
      if (terminalUnit(unit.status)) continue
      for (let i = 0; i < unit.steps.length; i += 1) {
        const step = unit.steps[i]
        if (!step.jobId) continue
        const job = this.jobs.getJob(step.jobId)
        if (!job) continue
        if (job.status === 'queued' && run.skipOffline && now - job.createdAt >= STALL_QUEUED_MS) {
          blockUnit(unit, 'not-claimed', undefined, i)
          break
        }
        if (job.status === 'running' && job.claimedAt && now - job.claimedAt >= job.timeoutMs) {
          blockUnit(unit, 'timeout', `执行超过 ${Math.round(job.timeoutMs / 60000)} 分钟仍未结束`, i)
          break
        }
      }
    }
  }

  private advanceRun(run: FleetScheduleRun): void {
    const busy = new Set<string>()
    for (const unit of run.units) {
      if (unit.steps.some(inFlightStep)) busy.add(unit.targetNormalized)
    }

    for (const unit of run.units) {
      if (terminalUnit(unit.status)) continue
      this.advanceUnit(run, unit, busy)
    }
  }

  private advanceUnit(run: FleetScheduleRun, unit: FleetScheduleUnit, busy: Set<string>): void {
    for (let guard = 0; guard < unit.steps.length + 2; guard += 1) {
      if (terminalUnit(unit.status)) return
      this.syncDirtyAfterStatus(run, unit)
      if (terminalUnit(unit.status)) return

      const current = unit.steps.find((step) => !terminalStep(step))
      if (!current) {
        unit.status = 'succeeded'
        return
      }

      if (inFlightStep(current)) {
        unit.status = 'running'
        busy.add(unit.targetNormalized)
        return
      }

      if (current.status !== 'pending') return
      if (busy.has(unit.targetNormalized)) return

      if (isCompileScheduleStep(current.scriptId) && !isMhaRepoAlias(unit.repo)) {
        current.status = 'skipped'
        current.skipReason = 'compile-typescript / build-unreal 只适用于 mha-* 仓库'
        current.finishedAt = this.clock()
        continue
      }

      try {
        const job = this.jobs.createJob({
          target: unit.target,
          kind: 'script',
          scriptId: current.scriptId,
          repo: unit.repo,
          cwd: unit.cwd,
          project: unit.repo,
          buildConfig: run.buildConfig,
          platform: run.platform,
        })
        current.jobId = job.id
        current.status = 'queued'
        current.startedAt = this.clock()
        unit.status = 'running'
        busy.add(unit.targetNormalized)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failUnit(unit, message, unit.steps.indexOf(current))
      }
      return
    }
  }

  private syncDirtyAfterStatus(run: FleetScheduleRun, unit: FleetScheduleUnit): void {
    if (!run.skipIfDirty) return
    const statusStep = unit.steps.find((step) => step.scriptId === 'git-status' && step.status === 'succeeded' && step.jobId)
    if (!statusStep?.jobId) return
    if (unit.status === 'blocked') return
    const job = this.jobs.getJob(statusStep.jobId)
    const parsed = parseGitStatusDirty(job?.output)
    if (!parsed.dirty) return
    const index = unit.steps.indexOf(statusStep)
    blockUnit(unit, 'dirty', parsed.summary, index + 1)
    statusStep.status = 'succeeded'
  }

  private recount(run: FleetScheduleRun): void {
    let blocked = 0
    let failed = 0
    let succeeded = 0
    let pending = 0
    for (const unit of run.units) {
      if (!terminalUnit(unit.status)) {
        const current = unit.steps.find((step) => !terminalStep(step))
        if (!current) unit.status = 'succeeded'
      }
      if (unit.status === 'blocked') blocked += 1
      else if (unit.status === 'failed') failed += 1
      else if (unit.status === 'succeeded') succeeded += 1
      else pending += 1
    }
    run.blockedCount = blocked
    run.failedCount = failed
    run.succeededCount = succeeded
    if (pending === 0) {
      run.finishedAt = run.finishedAt || this.clock()
      const status: FleetScheduleRunStatus = failed > 0 ? 'failed' : blocked > 0 ? 'blocked' : 'succeeded'
      run.status = status
    } else {
      run.status = 'running'
      run.finishedAt = undefined
    }
  }

  private cloneRun(run: FleetScheduleRun): FleetScheduleRun {
    return JSON.parse(JSON.stringify(run)) as FleetScheduleRun
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = asRecord(JSON.parse(raw))
      if (!parsed) return
      const schedules = Array.isArray(parsed.schedules) ? parsed.schedules : []
      const runs = Array.isArray(parsed.runs) ? parsed.runs : []
      this.store = {
        schedules: schedules.filter((item): item is FleetSchedule => Boolean(asRecord(item)?.id)),
        runs: runs.filter((item): item is FleetScheduleRun => Boolean(asRecord(item)?.id)),
      }
    } catch {
      this.store = { schedules: [], runs: [] }
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), 'utf8')
  }
}

export const fleetScheduleService = new FleetScheduleService(knotJobService)
