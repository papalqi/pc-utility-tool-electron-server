/**
 * Fleet MCP for utility-tool server.
 * Agents on DevCloud / other machines call these tools; jobs are claimed by desktop PCs.
 */

import { Router, Request, Response } from 'express'
import { authenticateToken } from '../middleware/auth'
import type { AuthRequest } from '../types'
import { config } from '../config'
import { knotJobService } from '../services/knotJobService'
import { cchProfileService } from '../services/cchProfileService'
import { logger } from '../utils/logger'
import {
  inferMachineJobKind,
  listFleetScriptIds,
  targetsMatch,
  type KnotJobCreateRequest,
  type MachineJobKind,
} from '../lib/knotDispatch'
import { FLEET_CATALOG, FLEET_CONTROLLER, findCatalogMachine } from '../lib/fleetCatalog'
import origins from '../data/internal-origins.json'

const log = logger.createScope('FleetMcp')
const router = Router()
const SERVER_NAME = 'utility-tool-fleet'
const PROTOCOL_VERSION = '2024-11-05'

type JsonRpcRequest = {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

function dispatchToken(): string {
  return (process.env.KNOT_DISPATCH_TOKEN || config.admin.password || '').trim()
}

function hasDispatchToken(req: Request): boolean {
  const expected = dispatchToken()
  if (!expected) return false
  const header = String(req.headers['x-knot-dispatch-token'] || req.headers['x-mcp-token'] || '')
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  return header === expected || bearer === expected
}

function requireMcpAuth(req: AuthRequest, res: Response, next: () => void): void {
  if (hasDispatchToken(req)) {
    next()
    return
  }
  authenticateToken(req, res, next)
}

const tools = [
  {
    name: 'fleet_list_machines',
    title: 'List machines',
    description: 'List desktop agents that recently heartbeated, including registered git repos',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'fleet_list_repos',
    title: 'List repos',
    description: 'List git checkouts reported by one machine or every online machine',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Hostname or alias such as PC5' },
      },
    },
  },
  {
    name: 'fleet_list_jobs',
    title: 'List jobs',
    description: 'List recent machine jobs (knot chat or existing scripts)',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
        kind: { type: 'string', enum: ['knot', 'script'] },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'fleet_get_job',
    title: 'Get job',
    description: 'Get one machine job by id, including output after it finishes',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'fleet_dispatch_knot',
    title: 'Dispatch knot',
    description:
      'Queue a knot-cli chat job on a desktop. Prefer repo alias (control / profile / renderdoc / utility-tool) over a raw cwd.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        prompt: { type: 'string' },
        repo: { type: 'string', description: 'Fleet alias such as control or utility-tool' },
        cwd: { type: 'string', description: 'Absolute path override on the target machine' },
        model: { type: 'string', description: 'knot-cli --model' },
        agentId: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['target', 'prompt'],
    },
  },
  {
    name: 'fleet_list_scripts',
    title: 'List scripts',
    description:
      'List basic machine scripts. These reuse project-tools / githubService / HAPI skill commands and never go through knot-cli.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fleet_dispatch_script',
    title: 'Dispatch script',
    description:
      'Queue an existing desktop script: git-status/fetch/pull, compile-typescript, build-unreal, sync-perforce, check-android-config, configure-project, hapi-skill-*.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        scriptId: {
          type: 'string',
          enum: [
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
          ],
        },
        repo: { type: 'string' },
        cwd: { type: 'string' },
        project: { type: 'string' },
        buildConfig: { type: 'string' },
        platform: { type: 'string' },
        skillName: { type: 'string' },
        skillDirectory: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['target', 'scriptId'],
    },
  },
  {
    name: 'fleet_get_cch_profile',
    title: 'Get CCH profile',
    description: 'Read the server CCH client template (URL only, no API key)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fleet_update_app',
    title: 'Update PC Utility Tool',
    description:
      'Update PC Utility Tool on a machine and optionally restart it. Online machines get app-update; offline machines are installed over SSH from the controller.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Hostname or alias such as PC6' },
        restart: { type: 'boolean', description: 'Also queue app-restart after a live update' },
      },
      required: ['target'],
    },
  },
  {
    name: 'fleet_ensure_ssh',
    title: 'Ensure SSH listener',
    description:
      'Queue ssh-ensure on an online desktop so it starts its documented SSH listener (PC0 relayd :22225, others sshd). Offline machines cannot be started from here.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    },
  },
  {
    name: 'fleet_restart_app',
    title: 'Restart PC Utility Tool',
    description: 'Queue a relaunch of PC Utility Tool on an online machine',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
      },
      required: ['target'],
    },
  },
  {
    name: 'fleet_save_cch_profile',
    title: 'Save CCH profile',
    description: 'Update the server CCH template. Empty apiKey leaves the existing key unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string' },
        apiKey: { type: 'string' },
        claudePath: { type: 'string' },
        codexPath: { type: 'string' },
        grokPath: { type: 'string' },
      },
    },
  },
] as const

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function createJobFromArgs(args: Record<string, unknown>, kind?: MachineJobKind) {
  const request: KnotJobCreateRequest = {
    target: asString(args.target),
    kind: kind || (asString(args.kind) as MachineJobKind) || undefined,
    scriptId: asString(args.scriptId) || undefined,
    repo: asString(args.repo) || undefined,
    cwd: asString(args.cwd) || undefined,
    prompt: asString(args.prompt) || undefined,
    model: asString(args.model) || undefined,
    agentId: asString(args.agentId) || undefined,
    gitAction: (asString(args.gitAction) || undefined) as KnotJobCreateRequest['gitAction'],
    script: asString(args.script) || undefined,
    project: asString(args.project) || undefined,
    buildConfig: asString(args.buildConfig) || undefined,
    platform: asString(args.platform) || undefined,
    skillAction: (asString(args.skillAction) || undefined) as KnotJobCreateRequest['skillAction'],
    skillName: asString(args.skillName) || undefined,
    skillDirectory: asString(args.skillDirectory) || undefined,
    timeoutMs: asNumber(args.timeoutMs),
  }
  if (kind) request.kind = kind
  else request.kind = inferMachineJobKind(request)
  return knotJobService.createJob(request)
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  log.info('tool call', { name, target: args.target, kind: args.kind || args.script || args.skillAction })
  if (name === 'fleet_list_machines') {
    return { machines: knotJobService.listAgents(), catalog: FLEET_CATALOG }
  }
  if (name === 'fleet_list_repos') {
    return { machines: knotJobService.listRepos(asString(args.target) || undefined) }
  }
  if (name === 'fleet_list_jobs') {
    return {
      jobs: knotJobService.listJobs(asNumber(args.limit) || 50, {
        target: asString(args.target) || undefined,
        status: (asString(args.status) || undefined) as
          | 'queued'
          | 'running'
          | 'succeeded'
          | 'failed'
          | 'cancelled'
          | undefined,
        kind: (asString(args.kind) || undefined) as MachineJobKind | undefined,
      }),
    }
  }
  if (name === 'fleet_get_job') {
    const id = asString(args.id)
    if (!id) throw new Error('id required')
    const job = knotJobService.getJob(id)
    if (!job) throw new Error(`job not found: ${id}`)
    return { job }
  }
  if (name === 'fleet_list_scripts') {
    return { scripts: listFleetScriptIds() }
  }
  if (name === 'fleet_dispatch_knot') return { job: createJobFromArgs(args, 'knot') }
  if (name === 'fleet_dispatch_script') return { job: createJobFromArgs(args, 'script') }
  if (name === 'fleet_update_app') {
    const target = asString(args.target)
    if (!target) throw new Error('target required')
    const restart = args.restart !== false
    const online = knotJobService.listAgents().find(
      (agent) => targetsMatch(target, agent.hostname) && Date.now() - (agent.seenAt || 0) < 180_000
    )
    if (online) {
      const jobs = [createJobFromArgs({ target, scriptId: 'app-update' }, 'script')]
      if (restart) jobs.push(createJobFromArgs({ target, scriptId: 'app-restart' }, 'script'))
      return { mode: 'live', jobs }
    }
    const remoteTarget = findCatalogMachine(target)?.hostname || target
    return {
      mode: 'ssh',
      jobs: [
        createJobFromArgs(
          { target: FLEET_CONTROLLER, scriptId: 'app-remote-update', project: remoteTarget },
          'script'
        ),
      ],
    }
  }
  if (name === 'fleet_ensure_ssh') {
    const target = asString(args.target)
    if (!target) throw new Error('target required')
    return { job: createJobFromArgs({ target, scriptId: 'ssh-ensure' }, 'script') }
  }
  if (name === 'fleet_restart_app') {
    const target = asString(args.target)
    if (!target) throw new Error('target required')
    return { job: createJobFromArgs({ target, scriptId: 'app-restart' }, 'script') }
  }
  if (name === 'fleet_get_cch_profile') {
    return { profile: cchProfileService.get(false) }
  }
  if (name === 'fleet_save_cch_profile') {
    return {
      profile: cchProfileService.save({
        baseUrl: asString(args.baseUrl) || undefined,
        apiKey: asString(args.apiKey) || undefined,
        claudePath: asString(args.claudePath) || undefined,
        codexPath: asString(args.codexPath) || undefined,
        grokPath: asString(args.grokPath) || undefined,
      }),
    }
  }
  throw new Error(`Unknown tool: ${name}`)
}

function mcpInfo() {
  return {
    enabled: true,
    url: '/mcp',
    serverName: SERVER_NAME,
    tools: tools.map(({ name, title, description }) => ({ name, title, description })),
    copyConfig: JSON.stringify(
      {
        mcpServers: {
          [SERVER_NAME]: {
            url: origins.hubMcp,
            headers: {
              Authorization: 'Bearer <KNOT_DISPATCH_TOKEN>',
            },
          },
        },
      },
      null,
      2
    ),
  }
}

router.use(requireMcpAuth)

router.get('/health', (_req, res) => {
  res.json({ ok: true, ...mcpInfo() })
})

router.get('/', (_req, res) => {
  res.json(mcpInfo())
})

router.post('/', async (req, res) => {
  const payload = (req.body || {}) as JsonRpcRequest
  const id = payload.id ?? null
  if (!id && payload.method?.startsWith('notifications/')) {
    res.status(204).end()
    return
  }
  try {
    if (payload.method === 'initialize') {
      res.json(
        rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: '1.0.0' },
        })
      )
      return
    }
    if (payload.method === 'tools/list') {
      res.json(rpcResult(id, { tools }))
      return
    }
    if (payload.method === 'tools/call') {
      const name = String(payload.params?.name || '')
      const args = (payload.params?.arguments || {}) as Record<string, unknown>
      const result = await callTool(name, args)
      res.json(
        rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        })
      )
      return
    }
    res.json(rpcError(id, -32601, `Unsupported method: ${payload.method || 'unknown'}`))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('mcp call failed', { method: payload.method, message })
    res.json(rpcError(id, -32603, message))
  }
})

export default router
export { callTool, tools }
