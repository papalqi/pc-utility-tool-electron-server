export type KnotJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type MachineJobKind = 'knot' | 'script'
export type MachineGitAction = 'status' | 'fetch' | 'pull'
export type MachineHapiSkillAction = 'status' | 'sync' | 'publish' | 'install'

/** Coordinator-only scripts. They are intentionally excluded from the public
 * Fleet script catalog and can only be created by the retirement coordinator. */
const INTERNAL_FLEET_SCRIPT_IDS = ['hapi-skill-retire-local', 'hapi-skill-retire-registry'] as const

const FLEET_SCRIPT_IDS = [
  'git-status',
  'git-fetch',
  'git-pull',
  'compile-typescript',
  'build-unreal',
  'sync-perforce',
  'check-android-config',
  'configure-project',
  'hapi-skill-status',
  'hapi-skill-sync',
  'hapi-skill-publish',
  'hapi-skill-install',
  'cch-status',
  'cch-apply-claude',
  'cch-apply-codex',
  'cch-apply-grok',
  'cch-apply-all',
  'cch-upload',
  'cch-upload-claude',
  'cch-upload-codex',
  'cch-upload-grok',
  'app-update',
  'app-restart',
  'app-remote-update',
  'ssh-status',
  'ssh-ensure',
] as const

export type FleetScriptId = (typeof FLEET_SCRIPT_IDS)[number]
export type InternalFleetScriptId = (typeof INTERNAL_FLEET_SCRIPT_IDS)[number]
export type AnyFleetScriptId = FleetScriptId | InternalFleetScriptId

export interface KnotJobCreateRequest {
  target: string
  kind?: MachineJobKind | 'git' | 'compile' | 'hapi-skill'
  scriptId?: string
  repo?: string
  cwd?: string
  prompt?: string
  model?: string
  agentId?: string
  gitAction?: MachineGitAction
  script?: string
  project?: string
  buildConfig?: string
  platform?: string
  skillAction?: MachineHapiSkillAction
  skillName?: string
  skillDirectory?: string
  timeoutMs?: number
}

export interface MachineRepoInventory {
  alias: string
  name: string
  path: string
  source: 'config' | 'github' | 'probed' | 'project'
  exists: boolean
  remoteUrl?: string
  branch?: string
  ahead?: number
  behind?: number
  modified?: number
}

export interface MachineProjectInventory {
  name: string
  path: string
  platform?: string
  buildConfig?: string
  p4Server?: string
  p4User?: string
  p4Charset?: string
  p4Workspace?: string
}

export interface MachineSkillInventory {
  name: string
  directory: string
  root?: string
}

export interface KnotJob {
  id: string
  target: string
  targetNormalized: string
  kind: MachineJobKind
  scriptId?: AnyFleetScriptId
  repo?: string
  cwd: string
  prompt: string
  model?: string
  agentId?: string
  gitAction?: MachineGitAction
  script?: string
  project?: string
  buildConfig?: string
  platform?: string
  skillAction?: MachineHapiSkillAction
  skillName?: string
  skillDirectory?: string
  timeoutMs: number
  status: KnotJobStatus
  createdAt: number
  claimedAt?: number
  finishedAt?: number
  claimedBy?: string
  output?: string
  error?: string
  exitCode?: number | null
}

export interface KnotAgentHeartbeat {
  hostname: string
  hostnameNormalized: string
  knotFound: boolean
  knotPath?: string | null
  knotVersion?: string | null
  knotSource?: string | null
  repos?: MachineRepoInventory[]
  projects?: MachineProjectInventory[]
  skills?: MachineSkillInventory[]
  skillRoots?: string[]
  cch?: {
    origin: string
    keyEnvSet: boolean
    checkedAt: number
    clients: Array<{
      id: string
      configured: boolean
      file: string
      exists: boolean
      baseUrl?: string
      keySet: boolean
      matchesProfile: boolean
    }>
  }
  ssh?: {
    listening: boolean
    port: number
    listener: string
    detail: string
    checkedAt: number
  }
  seenAt: number
}

export { normalizeMachineTarget, targetsMatch } from './machineId'

export const DEFAULT_KNOT_JOB_TIMEOUT_MS = 30 * 60_000

export function resolveFleetScriptId(input: KnotJobCreateRequest): string | undefined {
  if (input.scriptId?.trim()) return input.scriptId.trim()
  if (input.kind === 'git') return `git-${input.gitAction || 'status'}`
  if (input.kind === 'hapi-skill') return `hapi-skill-${input.skillAction || 'status'}`
  if (input.kind === 'compile' && input.script) return input.script
  if (input.script?.trim()) return input.script.trim()
  if (input.gitAction) return `git-${input.gitAction}`
  if (input.skillAction) return `hapi-skill-${input.skillAction}`
  return undefined
}

export function isFleetScriptId(value: string | undefined): value is FleetScriptId {
  return Boolean(value && (FLEET_SCRIPT_IDS as readonly string[]).includes(value))
}

export function isInternalFleetScriptId(value: string | undefined): value is InternalFleetScriptId {
  return Boolean(value && (INTERNAL_FLEET_SCRIPT_IDS as readonly string[]).includes(value))
}

export function isKnownFleetScriptId(value: string | undefined): value is AnyFleetScriptId {
  return isFleetScriptId(value) || isInternalFleetScriptId(value)
}

export function inferMachineJobKind(input: KnotJobCreateRequest): MachineJobKind {
  const scriptId = resolveFleetScriptId(input)
  if (input.kind === 'knot' || (!input.kind && (input.prompt || '').trim() && !scriptId)) {
    return 'knot'
  }
  if (scriptId && isFleetScriptId(scriptId)) return 'script'
  if (input.kind === 'script') return 'script'
  return 'knot'
}

export function defaultTimeoutForKind(kind: MachineJobKind, scriptId?: string): number {
  if (kind !== 'script') return DEFAULT_KNOT_JOB_TIMEOUT_MS
  if (scriptId === 'build-unreal') return 90 * 60_000
  if (scriptId === 'compile-typescript' || scriptId === 'sync-perforce') return 60 * 60_000
  if (scriptId === 'app-remote-update' || scriptId === 'app-update') return 30 * 60_000
  if (scriptId?.startsWith('git-')) return 10 * 60_000
  if (scriptId?.startsWith('cch-') || scriptId === 'app-restart') return 2 * 60_000
  return 15 * 60_000
}

export function validateMachineJobCreate(input: KnotJobCreateRequest): string | null {
  const target = (input.target || '').trim()
  if (!target) return 'target required'
  const kind = inferMachineJobKind(input)
  const repo = (input.repo || '').trim()
  const cwd = (input.cwd || '').trim()
  if (kind === 'knot') {
    if (!(input.prompt || '').trim()) return 'prompt required for knot jobs'
    if (!repo && !cwd) return 'repo or cwd required for knot jobs'
    return null
  }
  const scriptId = resolveFleetScriptId(input)
  if (isInternalFleetScriptId(scriptId)) {
    return `scriptId is internal and may only be created by the HAPI skill retirement coordinator: ${scriptId}`
  }
  if (!isFleetScriptId(scriptId)) {
    return `scriptId must be a known fleet script, got ${scriptId || '(empty)'}`
  }
  if (scriptId.startsWith('git-') || scriptId === 'compile-typescript' || scriptId === 'build-unreal' || scriptId === 'sync-perforce' || scriptId === 'check-android-config') {
    if (!repo && !cwd && !(input.project || '').trim()) {
      return `repo, cwd, or project required for ${scriptId}`
    }
  }
  if (scriptId.startsWith('hapi-skill-')) {
    if (scriptId === 'hapi-skill-install' && !(input.skillName || '').trim()) {
      return 'skillName required for hapi-skill-install'
    }
    if (!(input.skillName || '').trim() && !(input.skillDirectory || '').trim()) {
      return 'skillName or skillDirectory required'
    }
  }
  if (
    (scriptId === 'configure-project' || scriptId === 'app-remote-update') &&
    !(input.project || '').trim() &&
    !repo &&
    !cwd
  ) {
    return `project, repo, or cwd required for ${scriptId}`
  }
  return null
}

export function listFleetScriptIds(): FleetScriptId[] {
  return [...FLEET_SCRIPT_IDS]
}
