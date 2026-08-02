/**
 * Lightweight insight adapters for HAPI / Arashi / utility update feeds.
 */

import {
  emptyInsight,
  fetchJson,
  fetchText,
  type FleetServiceInsight,
  type InsightAdapterContext,
} from './types'

const TTL_MS = 90_000

export async function fetchHapiInsight(ctx: InsightAdapterContext): Promise<FleetServiceInsight> {
  const base = ctx.baseUrl.replace(/\/+$/, '')
  const deepLinks = [{ label: 'HAPI Hub', url: ctx.openUrl || `${base}/` }]
  try {
    const [health, version] = await Promise.all([
      fetchJson<Record<string, unknown>>(`${base}/health`, { timeoutMs: ctx.timeoutMs }),
      fetchText(`${base}/dist/version`, { timeoutMs: ctx.timeoutMs }),
    ])
    if (!health.ok) {
      return emptyInsight(ctx.serviceId, {
        ok: false,
        error: health.error || `health ${health.status}`,
        deepLinks,
        ttlMs: TTL_MS,
      })
    }
    const ver = version.ok ? version.text.trim().slice(0, 80) : '—'
    const status = String(health.data?.status ?? 'ok')
    return {
      serviceId: ctx.serviceId,
      fetchedAt: Date.now(),
      ttlMs: TTL_MS,
      source: 'api',
      ok: true,
      summary: `status=${status} · ${ver}`,
      metrics: [
        { key: 'status', label: '状态', value: status },
        { key: 'version', label: '版本', value: ver },
        {
          key: 'protocol',
          label: '协议',
          value: String(health.data?.protocolVersion ?? '—'),
        },
      ],
      deepLinks,
    }
  } catch (err) {
    return emptyInsight(ctx.serviceId, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      deepLinks,
      ttlMs: TTL_MS,
    })
  }
}

export async function fetchArashiInsight(ctx: InsightAdapterContext): Promise<FleetServiceInsight> {
  const base = ctx.baseUrl.replace(/\/+$/, '')
  const deepLinks = [{ label: 'Arashi Shader', url: ctx.openUrl || `${base}/` }]
  try {
    const r = await fetchJson<unknown>(`${base}/api/pipelines`, { timeoutMs: ctx.timeoutMs })
    if (!r.ok) {
      return emptyInsight(ctx.serviceId, {
        ok: false,
        error: r.error || `pipelines ${r.status}`,
        deepLinks,
        ttlMs: TTL_MS,
      })
    }
    let count = 0
    const data = r.data
    if (Array.isArray(data)) count = data.length
    else if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>
      if (Array.isArray(obj.items)) count = obj.items.length
      else if (Array.isArray(obj.pipelines)) count = obj.pipelines.length
      else count = Object.keys(obj).length
    }
    return {
      serviceId: ctx.serviceId,
      fetchedAt: Date.now(),
      ttlMs: TTL_MS,
      source: 'api',
      ok: true,
      summary: `pipelines ≈ ${count}`,
      metrics: [
        { key: 'pipelines', label: '流水线条目', value: count },
        { key: 'api', label: 'API', value: 'ok' },
      ],
      deepLinks,
    }
  } catch (err) {
    return emptyInsight(ctx.serviceId, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      deepLinks,
      ttlMs: TTL_MS,
    })
  }
}

export async function fetchUtilityUpdateInsight(
  ctx: InsightAdapterContext
): Promise<FleetServiceInsight> {
  const base = ctx.baseUrl.replace(/\/+$/, '')
  const deepLinks = [
    { label: 'latest.yml', url: `${base}/updates/latest.yml` },
    { label: '下载门户', url: `${base}/download/` },
  ]
  try {
    const [yml, hot, health] = await Promise.all([
      fetchText(`${base}/updates/latest.yml`, { timeoutMs: ctx.timeoutMs }),
      fetchJson<{ version?: string; releaseDate?: string }>(`${base}/updates/latest-hot.json`, {
        timeoutMs: ctx.timeoutMs,
      }),
      fetchJson<Record<string, unknown>>(`${base}/health`, { timeoutMs: ctx.timeoutMs }),
    ])

    const versionMatch = yml.ok ? yml.text.match(/version:\s*['"]?([^\s'"]+)/i) : null
    const fullVersion = versionMatch?.[1] || '—'
    const pathMatch = yml.ok ? yml.text.match(/path:\s*([^\s]+)/i) : null
    const hotVersion = hot.ok && hot.data?.version ? String(hot.data.version) : '—'

    return {
      serviceId: ctx.serviceId,
      fetchedAt: Date.now(),
      ttlMs: TTL_MS,
      source: 'api',
      ok: yml.ok || hot.ok,
      summary: `全量 ${fullVersion} · 热更 ${hotVersion}`,
      metrics: [
        { key: 'full_version', label: '全量版本', value: fullVersion },
        { key: 'hot_version', label: '热更版本', value: hotVersion },
        {
          key: 'health',
          label: '服务',
          value: health.ok ? 'ok' : `HTTP ${health.status}`,
        },
        {
          key: 'path',
          label: '产物',
          value: pathMatch?.[1]?.slice(0, 40) || '—',
        },
      ],
      deepLinks,
      error: yml.ok ? undefined : yml.text.slice(0, 120),
    }
  } catch (err) {
    return emptyInsight(ctx.serviceId, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      deepLinks,
      ttlMs: TTL_MS,
    })
  }
}
