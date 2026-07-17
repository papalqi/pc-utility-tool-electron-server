/**
 * Normalize external push payloads (CCH custom webhooks, direct fleet reports, etc.)
 * into the internal fleet alert shape.
 */

import type { FleetHealthStatus } from './fleetMonitorService'

export interface NormalizedFleetReport {
  serviceId: string
  serviceName: string
  status: FleetHealthStatus
  message: string
  severity: 'error' | 'warning' | 'info'
  meta?: Record<string, unknown>
}

function str(v: unknown): string {
  if (v == null) return ''
  const s = String(v).trim()
  // drop unfilled CCH template placeholders
  if (/^\{\{[a-z0-9_]+\}\}$/i.test(s)) return ''
  return s
}

function pick(...vals: unknown[]): string {
  for (const v of vals) {
    const s = str(v)
    if (s) return s
  }
  return ''
}

function mapLevel(levelRaw: string): {
  status: FleetHealthStatus
  severity: 'error' | 'warning' | 'info'
} {
  const level = levelRaw.toLowerCase()
  if (level === 'error' || level === 'critical' || level === 'down') {
    return { status: 'down', severity: 'error' }
  }
  if (level === 'warning' || level === 'warn' || level === 'degraded') {
    return { status: 'degraded', severity: 'warning' }
  }
  if (level === 'info' || level === 'success' || level === 'up' || level === 'ok') {
    return { status: 'up', severity: 'info' }
  }
  // default unknown levels to warning so they still surface
  return { status: 'degraded', severity: 'warning' }
}

/**
 * Accept:
 * 1) Direct: { serviceId, serviceName?, status, message, severity? }
 * 2) CCH custom templates (circuit_breaker / cost_alert / cache / generic)
 * 3) Loose { title, level, content, ... }
 */
export function normalizeFleetReportBody(body: Record<string, unknown>): NormalizedFleetReport | null {
  if (!body || typeof body !== 'object') return null

  // Prefer rich CCH fields over bare serviceId/title so custom templates keep detail.
  // ── 1) CCH circuit breaker template fields ───────────────────
  const provider = pick(body.provider, body.provider_name, body.providerName)
  const failureCount = pick(body.failureCount, body.failure_count)
  const lastError = pick(body.error, body.lastError, body.last_error)
  if (provider || failureCount || str(body.title).includes('熔断')) {
    const parts = [
      pick(body.title) || '熔断器告警',
      provider ? `供应商 ${provider}` : '',
      failureCount ? `连续失败 ${failureCount}` : '',
      pick(body.retryAt, body.retry_at) ? `恢复 ${pick(body.retryAt, body.retry_at)}` : '',
      lastError ? `错误: ${lastError}` : '',
      pick(body.endpoint_url, body.endpointUrl) ? `端点 ${pick(body.endpoint_url, body.endpointUrl)}` : '',
    ].filter(Boolean)
    return {
      serviceId: pick(body.serviceId) || 'cch',
      serviceName: pick(body.serviceName) || 'CCH',
      status: 'down',
      severity: 'error',
      message: parts.join(' · '),
      meta: { source: 'cch', type: 'circuit_breaker', ...body },
    }
  }

  // ── 1b) Explicit fleet format ────────────────────────────────
  if (body.serviceId && (body.message || body.title)) {
    const statusRaw = str(body.status) || str(body.level) || 'down'
    const mapped = mapLevel(statusRaw)
    // honor explicit status enums
    let status: FleetHealthStatus = mapped.status
    if (statusRaw === 'up' || statusRaw === 'down' || statusRaw === 'degraded' || statusRaw === 'unknown') {
      status = statusRaw as FleetHealthStatus
    }
    const severity =
      (body.severity as 'error' | 'warning' | 'info') ||
      (status === 'down' ? 'error' : status === 'degraded' ? 'warning' : mapped.severity)
    const extras = [
      pick(body.provider, body.provider_name),
      pick(body.error, body.lastError),
      pick(body.content, body.sections),
    ].filter(Boolean)
    const base = pick(body.message, body.title) || 'external report'
    return {
      serviceId: str(body.serviceId),
      serviceName: pick(body.serviceName, body.serviceId),
      status,
      message: extras.length ? `${base} · ${extras.join(' · ')}` : base,
      severity,
      meta: body,
    }
  }

  // ── 3) CCH cost alert ────────────────────────────────────────
  // targetType/targetName/currentCost/quotaLimit/usagePercent
  if (pick(body.targetType, body.target_type) || pick(body.usagePercent, body.usage_percent)) {
    const parts = [
      pick(body.title) || '成本预警',
      pick(body.targetType, body.target_type)
        ? `${pick(body.targetType, body.target_type)} ${pick(body.targetName, body.target_name)}`
        : pick(body.targetName, body.target_name),
      pick(body.currentCost, body.current_cost)
        ? `消费 ${pick(body.currentCost, body.current_cost)}/${pick(body.quotaLimit, body.quota_limit)}`
        : '',
      pick(body.usagePercent, body.usage_percent)
        ? `使用率 ${pick(body.usagePercent, body.usage_percent)}%`
        : '',
    ].filter(Boolean)
    return {
      serviceId: 'cch',
      serviceName: 'CCH',
      status: 'degraded',
      severity: 'warning',
      message: parts.join(' · '),
      meta: { source: 'cch', type: 'cost_alert', ...body },
    }
  }

  // ── 4) CCH cache hit rate ────────────────────────────────────
  if (pick(body.anomalyCount, body.anomaly_count) || pick(body.anomalies, body.anomalies_json)) {
    const parts = [
      pick(body.title) || '缓存命中率异常',
      pick(body.anomalyCount, body.anomaly_count)
        ? `异常 ${pick(body.anomalyCount, body.anomaly_count)} 条`
        : '',
      pick(body.windowMode, body.window_mode)
        ? `窗口 ${pick(body.windowMode, body.window_mode)}`
        : '',
    ].filter(Boolean)
    return {
      serviceId: 'cch',
      serviceName: 'CCH',
      status: 'degraded',
      severity: 'warning',
      message: parts.join(' · '),
      meta: { source: 'cch', type: 'cache_hit_rate_alert', ...body },
    }
  }

  // ── 5) CCH daily leaderboard (info only) ─────────────────────
  if (pick(body.entries, body.entries_json) || str(body.title).includes('排行')) {
    return {
      serviceId: 'cch',
      serviceName: 'CCH',
      status: 'up',
      severity: 'info',
      message: pick(body.title, body.content) || '每日消费排行榜',
      meta: { source: 'cch', type: 'daily_leaderboard', ...body },
    }
  }

  // ── 6) Arashi Shader / generic push: title/level/message/source ──
  const source = pick(body.source, body.from)
  if (source === 'arashi-shader' || pick(body.serviceId) === 'arashi-shader') {
    const mapped = mapLevel(pick(body.level, body.severity, body.status) || 'info')
    const title = pick(body.title) || 'Arashi Shader 通知'
    const msg = pick(body.message, body.content, body.sections) || title
    return {
      serviceId: 'arashi-shader',
      serviceName: pick(body.serviceName) || 'Arashi Shader',
      status: mapped.status === 'down' ? 'down' : mapped.status === 'degraded' ? 'degraded' : 'up',
      severity: mapped.severity,
      message: msg.startsWith(title) ? msg : `${title} · ${msg}`,
      meta: { source: 'arashi-shader', event: pick(body.event), openUrl: pick(body.openUrl), ...body },
    }
  }

  // ── 7) CCH generic custom template: title/level/content ──────
  if (body.title || body.level || body.content) {
    const mapped = mapLevel(pick(body.level) || 'warning')
    // info/recovery titles shouldn't mark CCH down
    const title = pick(body.title)
    const parts = [title, pick(body.content, body.sections, body.message)].filter(Boolean)
    const sid = pick(body.serviceId) || (source === 'cch' ? 'cch' : 'cch')
    return {
      serviceId: sid,
      serviceName: pick(body.serviceName) || (sid === 'cch' ? 'CCH' : sid),
      status: mapped.status,
      severity: mapped.severity,
      message: parts.join(' · ') || '服务通知',
      meta: { source: source || 'cch', type: 'generic', ...body },
    }
  }

  // ── 7) source-tagged freeform ────────────────────────────────
  if (pick(body.source) === 'cch' || pick(body.from) === 'cch') {
    return {
      serviceId: 'cch',
      serviceName: 'CCH',
      status: 'degraded',
      severity: 'warning',
      message: pick(body.message, body.title, JSON.stringify(body).slice(0, 200)),
      meta: body,
    }
  }

  return null
}
