export const FLEET_SCHEDULE_STEPS = [
  'git-status',
  'git-fetch',
  'git-pull',
  'sync-perforce',
  'compile-typescript',
  'build-unreal',
] as const

export type FleetScheduleStepId = (typeof FLEET_SCHEDULE_STEPS)[number]

export type FleetScheduleBlockReason =
  | 'offline'
  | 'not-claimed'
  | 'timeout'
  | 'dirty'
  | 'missing-repo'
  | 'job-failed'
  | 'prev-failed'

export type FleetScheduleStepStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'skipped'

export type FleetScheduleUnitStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked'
export type FleetScheduleRunStatus = 'running' | 'succeeded' | 'failed' | 'blocked'

export interface FleetSchedule {
  id: string
  name: string
  enabled: boolean
  cron: string
  targets: string[]
  repos: string[]
  steps: FleetScheduleStepId[]
  skipIfDirty: boolean
  skipOffline: boolean
  buildConfig?: string
  platform?: string
  createdAt: number
  updatedAt: number
}

export interface FleetScheduleInput {
  id?: string
  name: string
  enabled?: boolean
  cron: string
  targets?: string[]
  repos: string[]
  steps: FleetScheduleStepId[]
  skipIfDirty?: boolean
  skipOffline?: boolean
  buildConfig?: string
  platform?: string
}

export interface FleetScheduleStepState {
  scriptId: FleetScheduleStepId
  status: FleetScheduleStepStatus
  jobId?: string
  blockedReason?: FleetScheduleBlockReason
  skipReason?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}

export interface FleetScheduleUnit {
  id: string
  target: string
  targetNormalized: string
  repo: string
  cwd?: string
  status: FleetScheduleUnitStatus
  blockedReason?: FleetScheduleBlockReason
  blockedMessage?: string
  steps: FleetScheduleStepState[]
}

export interface FleetScheduleRun {
  id: string
  scheduleId: string
  name: string
  startedAt: number
  finishedAt?: number
  status: FleetScheduleRunStatus
  reason: 'scheduled' | 'manual'
  skipIfDirty: boolean
  skipOffline: boolean
  buildConfig?: string
  platform?: string
  blockedCount: number
  failedCount: number
  succeededCount: number
  units: FleetScheduleUnit[]
}

export const FLEET_SCHEDULE_BLOCK_LABELS: Record<FleetScheduleBlockReason, string> = {
  offline: '目标机离线，未入队',
  'not-claimed': '已入队超过 3 分钟仍未被领取（Utility 未开或心跳中断）',
  timeout: '执行超过超时时间仍未结束',
  dirty: '工作区有未提交改动，已跳过更新/编译',
  'missing-repo': '该机器没有这个仓库',
  'job-failed': '步骤失败',
  'prev-failed': '前序步骤失败或阻塞，后续未执行',
}

export function isFleetScheduleStepId(value: string | undefined): value is FleetScheduleStepId {
  return Boolean(value && (FLEET_SCHEDULE_STEPS as readonly string[]).includes(value))
}

export function isMhaRepoAlias(alias: string): boolean {
  return alias.trim().toLowerCase().startsWith('mha-')
}

export function isCompileScheduleStep(step: FleetScheduleStepId): boolean {
  return step === 'compile-typescript' || step === 'build-unreal'
}

export function effectiveScheduleSteps(
  steps: FleetScheduleStepId[],
  skipIfDirty: boolean
): FleetScheduleStepId[] {
  const cleaned = steps.filter((step, index) => steps.indexOf(step) === index)
  if (!skipIfDirty) return cleaned
  if (cleaned[0] === 'git-status') return cleaned
  return ['git-status', ...cleaned.filter((step) => step !== 'git-status')]
}

export function parseGitStatusDirty(output?: string): { dirty: boolean; summary: string } {
  if (!output) return { dirty: false, summary: '' }
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>
    const count = (key: string) => {
      const value = parsed[key]
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }
    const modified = count('modified')
    const created = count('created')
    const deleted = count('deleted')
    const renamed = count('renamed')
    const conflicted = count('conflicted')
    const total = modified + created + deleted + renamed + conflicted
    if (total <= 0) return { dirty: false, summary: '' }
    return {
      dirty: true,
      summary: `工作区有未提交改动（modified=${modified} created=${created} deleted=${deleted} conflicted=${conflicted}），已跳过更新/编译`,
    }
  } catch {
    return { dirty: false, summary: '' }
  }
}

export function isDirtyWorkspaceError(error?: string, output?: string): boolean {
  const text = `${error || ''}\n${output || ''}`
  return /local changes|would be overwritten|Please commit|unmerged|Your local changes/i.test(text)
}

export const ONLINE_TTL_MS = 180_000
export const STALL_QUEUED_MS = 180_000
