/**
 * Fleet monitor — probes peer services FROM this hub host
 * and exposes a snapshot + alert ring for utility-tool clients.
 *
 * Clients should only hit this host; they do not probe peers directly.
 */

import net from 'net'
import origins from '../data/internal-origins.json'
import rawTargets from '../data/service-targets.json'
import { logger } from '../utils/logger'

const log = logger.createScope('FleetMonitor')

export type FleetHealthStatus = 'up' | 'down' | 'degraded' | 'unknown'

export interface FleetCheckDef {
  id: string
  label: string
  kind: 'http' | 'tcp'
  url?: string
  host?: string
  port?: number
  expectStatus?: number[]
  timeoutMs?: number
}

export interface FleetTargetDef {
  id: string
  name: string
  group: string
  host: string
  description?: string
  openUrl?: string
  docsHint?: string
  ssh?: { user: string; port: number; identityHint?: string }
  checks: FleetCheckDef[]
}

export interface FleetCheckResult {
  checkId: string
  label: string
  kind: 'http' | 'tcp'
  status: 'up' | 'down' | 'unknown'
  evidence: string
  latencyMs?: number
  checkedAt: number
}

export interface FleetServiceResult {
  serviceId: string
  name: string
  group: string
  host: string
  description?: string
  openUrl?: string
  docsHint?: string
  ssh?: FleetTargetDef['ssh']
  status: FleetHealthStatus
  evidence: string
  latencyMs?: number
  checks: FleetCheckResult[]
  checkedAt: number
}

export interface FleetAlert {
  id: string
  serviceId: string
  serviceName: string
  severity: 'error' | 'warning' | 'info'
  status: FleetHealthStatus
  message: string
  at: number
}

export interface FleetSnapshot {
  hub: {
    host: string
    role: string
    version: string
  }
  results: FleetServiceResult[]
  alerts: FleetAlert[]
  summary: { up: number; down: number; degraded: number; unknown: number; total: number }
  checkedAt: number
  probeIntervalMs: number
}

function originHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url.replace(/^https?:\/\//i, '').split('/')[0] || url
  }
}

type OriginKey = keyof typeof origins

type RawServiceTarget = {
  id: string
  name: string
  group: string
  originKey: OriginKey
  hostOriginKey?: OriginKey
  description?: string
  docsHint?: string
  ssh?: FleetTargetDef['ssh']
  probeChecks?: FleetCheckDef[]
}

/** Services probed from this hub. Use loopback for co-located processes. */
const DEFAULT_TARGETS: FleetTargetDef[] = (rawTargets as RawServiceTarget[]).map((item) => {
  const openUrl = origins[item.originKey]
  const hostSource = origins[item.hostOriginKey || item.originKey]
  return {
    id: item.id,
    name: item.name,
    group: item.group,
    host: originHost(hostSource || openUrl),
    description: item.description,
    openUrl: openUrl || undefined,
    docsHint: item.docsHint,
    ssh: item.ssh,
    checks: item.probeChecks || [],
  }
})


const PROBE_INTERVAL_MS = Number(process.env.FLEET_PROBE_INTERVAL_MS || 30_000)
const MAX_ALERTS = 100

function truncate(text: string, max = 140): string {
  const t = (text || '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}…`
}

function summarize(checks: FleetCheckResult[]): FleetHealthStatus {
  if (checks.length === 0) return 'unknown'
  const ups = checks.filter((c) => c.status === 'up').length
  const downs = checks.filter((c) => c.status === 'down').length
  const unknowns = checks.filter((c) => c.status === 'unknown').length
  if (ups === checks.length) return 'up'
  if (downs === checks.length) return 'down'
  if (ups > 0 && (downs > 0 || unknowns > 0)) return 'degraded'
  if (unknowns === checks.length) return 'unknown'
  return downs > 0 ? 'down' : 'unknown'
}

function statusRank(s: FleetHealthStatus): number {
  switch (s) {
    case 'up':
      return 0
    case 'unknown':
      return 1
    case 'degraded':
      return 2
    case 'down':
      return 3
    default:
      return 1
  }
}

async function probeTcp(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ ok: boolean; evidence: string; latencyMs: number }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (ok: boolean, evidence: string) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      resolve({ ok, evidence, latencyMs: Date.now() - started })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true, `端口 ${port} 可达`))
    socket.once('timeout', () => finish(false, `TCP ${host}:${port} timeout`))
    socket.once('error', (err) => finish(false, `TCP ${host}:${port} ${err.message}`))
    try {
      socket.connect(port, host)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      finish(false, message)
    }
  })
}

async function probeHttp(
  check: FleetCheckDef
): Promise<{ ok: boolean; evidence: string; latencyMs: number }> {
  const url = check.url
  if (!url) return { ok: false, evidence: 'missing url', latencyMs: 0 }
  const timeoutMs = check.timeoutMs ?? 5000
  const expect = check.expectStatus?.length ? check.expectStatus : [200]
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: '*/*', 'User-Agent': 'FleetMonitor/1.0' },
    })
    const latencyMs = Date.now() - started
    let body = ''
    try {
      body = truncate(await resp.text())
    } catch {
      body = ''
    }
    const ok = expect.includes(resp.status)
    // Healthy probes: keep UI clean — no "HTTP 200 · {...}" noise on cards.
    if (ok) {
      return { ok: true, evidence: '正常', latencyMs }
    }
    return {
      ok: false,
      evidence: `HTTP ${resp.status} (expect ${expect.join('/')})${body ? ` · ${body}` : ''}`,
      latencyMs,
    }
  } catch (err) {
    const latencyMs = Date.now() - started
    const name = err instanceof Error ? err.name : ''
    const message = err instanceof Error ? err.message : String(err)
    if (name === 'AbortError') return { ok: false, evidence: `timeout ${timeoutMs}ms`, latencyMs }
    return { ok: false, evidence: message || 'request failed', latencyMs }
  } finally {
    clearTimeout(timer)
  }
}

class FleetMonitorService {
  private targets = DEFAULT_TARGETS
  private lastResults: FleetServiceResult[] = []
  private lastCheckedAt = 0
  private alerts: FleetAlert[] = []
  private previousStatus = new Map<string, FleetHealthStatus>()
  private timer: NodeJS.Timeout | null = null
  private probing = false

  start(): void {
    if (this.timer) return
    log.info('Fleet monitor starting', { intervalMs: PROBE_INTERVAL_MS, targets: this.targets.length })
    void this.probeAll()
    this.timer = setInterval(() => {
      void this.probeAll()
    }, PROBE_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getSnapshot(): FleetSnapshot {
    const summary = { up: 0, down: 0, degraded: 0, unknown: 0, total: this.lastResults.length }
    for (const r of this.lastResults) {
      summary[r.status] = (summary[r.status] || 0) + 1
    }
    return {
      hub: {
        host: process.env.FLEET_HUB_HOST || originHost(origins.hub),
        role: 'fleet-aggregator',
        version: '1.0.0',
      },
      results: this.lastResults,
      alerts: this.alerts.slice(0, 50),
      summary,
      checkedAt: this.lastCheckedAt,
      probeIntervalMs: PROBE_INTERVAL_MS,
    }
  }

  getAlerts(limit = 30): FleetAlert[] {
    return this.alerts.slice(0, limit)
  }

  /** External service report (optional push). */
  reportExternal(input: {
    serviceId: string
    serviceName?: string
    status: FleetHealthStatus
    message: string
    severity?: 'error' | 'warning' | 'info'
  }): FleetAlert {
    const alert: FleetAlert = {
      id: `${input.serviceId}-${Date.now()}`,
      serviceId: input.serviceId,
      serviceName: input.serviceName || input.serviceId,
      severity: input.severity || (input.status === 'down' ? 'error' : 'warning'),
      status: input.status,
      message: input.message,
      at: Date.now(),
    }
    this.alerts.unshift(alert)
    if (this.alerts.length > MAX_ALERTS) this.alerts.length = MAX_ALERTS
    log.warn('External fleet report', alert)
    return alert
  }

  async probeAll(): Promise<FleetSnapshot> {
    if (this.probing) return this.getSnapshot()
    this.probing = true
    try {
      const results = await Promise.all(this.targets.map((t) => this.probeTarget(t)))
      this.lastResults = results
      this.lastCheckedAt = Date.now()
      this.detectTransitions(results)
      return this.getSnapshot()
    } finally {
      this.probing = false
    }
  }

  private async probeTarget(target: FleetTargetDef): Promise<FleetServiceResult> {
    const started = Date.now()
    const checks: FleetCheckResult[] = []
    for (const check of target.checks) {
      checks.push(await this.runCheck(target, check))
    }
    const status = summarize(checks)
    const evidence =
      status === 'up'
        ? '正常'
        : checks
            .filter((c) => c.status !== 'up')
            .map((c) => `${c.label}: ${c.evidence}`)
            .join(' · ') || checks[0]?.evidence || 'no checks'

    return {
      serviceId: target.id,
      name: target.name,
      group: target.group,
      host: target.host,
      description: target.description,
      openUrl: target.openUrl,
      docsHint: target.docsHint,
      ssh: target.ssh,
      status,
      evidence,
      latencyMs: Date.now() - started,
      checks,
      checkedAt: Date.now(),
    }
  }

  private async runCheck(target: FleetTargetDef, check: FleetCheckDef): Promise<FleetCheckResult> {
    const checkedAt = Date.now()
    try {
      if (check.kind === 'tcp') {
        const host = check.host || target.host
        const port = check.port
        if (!port) {
          return {
            checkId: check.id,
            label: check.label,
            kind: 'tcp',
            status: 'unknown',
            evidence: 'missing port',
            checkedAt,
          }
        }
        const r = await probeTcp(host, port, check.timeoutMs ?? 4000)
        return {
          checkId: check.id,
          label: check.label,
          kind: 'tcp',
          status: r.ok ? 'up' : 'down',
          evidence: r.evidence,
          latencyMs: r.latencyMs,
          checkedAt,
        }
      }
      const r = await probeHttp(check)
      return {
        checkId: check.id,
        label: check.label,
        kind: 'http',
        status: r.ok ? 'up' : 'down',
        evidence: r.evidence,
        latencyMs: r.latencyMs,
        checkedAt,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        checkId: check.id,
        label: check.label,
        kind: check.kind,
        status: 'unknown',
        evidence: message,
        checkedAt,
      }
    }
  }

  private detectTransitions(results: FleetServiceResult[]): void {
    for (const r of results) {
      const prev = this.previousStatus.get(r.serviceId)
      this.previousStatus.set(r.serviceId, r.status)
      if (prev === undefined) {
        // first sample: only alert if already bad
        if (r.status === 'down' || r.status === 'degraded') {
          this.pushAlert(r, r.status === 'down' ? 'error' : 'warning')
        }
        continue
      }
      if (statusRank(r.status) > statusRank(prev)) {
        this.pushAlert(r, r.status === 'down' ? 'error' : 'warning')
      } else if (prev !== 'up' && r.status === 'up') {
        this.pushAlert(r, 'info', `已恢复正常`)
      }
    }
  }

  private pushAlert(
    r: FleetServiceResult,
    severity: FleetAlert['severity'],
    overrideMessage?: string
  ): void {
    const alert: FleetAlert = {
      id: `${r.serviceId}-${Date.now()}`,
      serviceId: r.serviceId,
      serviceName: r.name,
      severity,
      status: r.status,
      message: overrideMessage || r.evidence,
      at: Date.now(),
    }
    this.alerts.unshift(alert)
    if (this.alerts.length > MAX_ALERTS) this.alerts.length = MAX_ALERTS
    log.warn('Fleet alert', {
      serviceId: alert.serviceId,
      severity: alert.severity,
      status: alert.status,
      message: alert.message,
    })
  }
}

export const fleetMonitorService = new FleetMonitorService()
