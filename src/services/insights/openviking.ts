/**
 * OpenViking insight adapter — audit counts + observer queue/index.
 * Auth: OPENVIKING_FLEET_API_KEY or OPENVIKING_API_KEY (Hub env only).
 */

import {
  emptyInsight,
  fetchJson,
  formatCompactNumber,
  type FleetInsightMetric,
  type FleetInsightRecentRow,
  type FleetInsightSeries,
  type FleetServiceInsight,
  type InsightAdapterContext,
} from './types'

const DAY_MS = 24 * 60 * 60 * 1000
const TTL_MS = 90_000

interface AuditItem {
  request_id?: string
  route?: string
  api_type?: string
  status_code?: number
  duration_ms?: number
  created_at?: string
}

interface AuditResult {
  total?: number
  success_rate?: number
  items?: AuditItem[]
}

interface OvEnvelope<T> {
  status?: string
  result?: T
  error?: { message?: string }
}

function parseTime(iso?: string): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

function countSince(items: AuditItem[], sinceMs: number): number {
  let n = 0
  for (const it of items) {
    const t = parseTime(it.created_at)
    if (t >= sinceMs) n += 1
  }
  return n
}

function hourlySeries(items: AuditItem[], key: string, label: string, hours = 12): FleetInsightSeries {
  const now = Date.now()
  const buckets = new Map<number, number>()
  for (let i = hours - 1; i >= 0; i--) {
    const hourStart = Math.floor((now - i * 3600_000) / 3600_000) * 3600_000
    buckets.set(hourStart, 0)
  }
  for (const it of items) {
    const t = parseTime(it.created_at)
    if (!t) continue
    const hourStart = Math.floor(t / 3600_000) * 3600_000
    if (buckets.has(hourStart)) {
      buckets.set(hourStart, (buckets.get(hourStart) || 0) + 1)
    }
  }
  return {
    key,
    label,
    points: Array.from(buckets.entries()).map(([t, v]) => ({ t, v })),
  }
}

function parseQueuePending(statusText: string): { embeddingPending: number; embeddingProcessed: number } {
  // ASCII table from observer/queue
  const emb = statusText.match(/Embedding\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/i)
  return {
    embeddingPending: emb ? Number(emb[1]) : 0,
    embeddingProcessed: emb ? Number(emb[3]) : 0,
  }
}

function parseVectorCount(statusText: string): number {
  const m = statusText.match(/TOTAL\s*\|\s*\d+\s*\|\s*(\d+)/i)
  if (m) return Number(m[1])
  const m2 = statusText.match(/context\s*\|\s*\d+\s*\|\s*(\d+)/i)
  return m2 ? Number(m2[1]) : 0
}

async function fetchAudit(
  base: string,
  token: string,
  apiType: string,
  pageSize: number,
  timeoutMs: number
): Promise<{ total: number; successRate: number; items: AuditItem[]; error?: string }> {
  const url = `${base}/api/v1/console/audit?page=1&page_size=${pageSize}&api_type=${encodeURIComponent(apiType)}`
  const r = await fetchJson<OvEnvelope<AuditResult>>(url, {
    timeoutMs,
    headers: {
      'X-API-Key': token,
      'X-OpenViking-Account': process.env.OPENVIKING_ACCOUNT || 'default',
      'X-OpenViking-User': process.env.OPENVIKING_USER || 'admin',
      Accept: 'application/json',
    },
  })
  if (!r.ok || !r.data?.result) {
    return { total: 0, successRate: 0, items: [], error: r.error || `HTTP ${r.status}` }
  }
  const result = r.data.result
  return {
    total: Number(result.total || 0),
    successRate: Number(result.success_rate || 0),
    items: Array.isArray(result.items) ? result.items : [],
  }
}

export async function fetchOpenVikingInsight(ctx: InsightAdapterContext): Promise<FleetServiceInsight> {
  const base = ctx.baseUrl.replace(/\/+$/, '')
  const token = ctx.authToken
  const deepLinks = [
    { label: 'Studio', url: `${base}/studio/` },
    { label: 'Request logs', url: `${base}/studio/request-logs` },
  ]

  if (!token) {
    return emptyInsight(ctx.serviceId, {
      ok: false,
      source: 'api',
      error: '缺少 OPENVIKING_FLEET_API_KEY（Hub env）',
      summary: '探活可正常，但业务指标需要 API Key',
      deepLinks,
      ttlMs: TTL_MS,
    })
  }

  const since = Date.now() - DAY_MS
  const timeoutMs = ctx.timeoutMs

  try {
    const [find, search, sessions, recallBucket, queue, vikingdb] = await Promise.all([
      fetchAudit(base, token, 'search.find', 50, timeoutMs),
      fetchAudit(base, token, 'search.search', 50, timeoutMs),
      fetchAudit(base, token, 'sessions', 50, timeoutMs),
      // recall is stored under api_type=search with route .../recall
      fetchAudit(base, token, 'search', 50, timeoutMs),
      fetchJson<OvEnvelope<{ status?: string; is_healthy?: boolean }>>(`${base}/api/v1/observer/queue`, {
        timeoutMs,
        headers: {
          'X-API-Key': token,
          'X-OpenViking-Account': process.env.OPENVIKING_ACCOUNT || 'default',
          'X-OpenViking-User': process.env.OPENVIKING_USER || 'admin',
        },
      }),
      fetchJson<OvEnvelope<{ status?: string; is_healthy?: boolean }>>(
        `${base}/api/v1/observer/vikingdb`,
        {
          timeoutMs,
          headers: {
            'X-API-Key': token,
            'X-OpenViking-Account': process.env.OPENVIKING_ACCOUNT || 'default',
            'X-OpenViking-User': process.env.OPENVIKING_USER || 'admin',
          },
        }
      ),
    ])

    if (find.error && search.error && sessions.error) {
      return emptyInsight(ctx.serviceId, {
        ok: false,
        source: 'api',
        error: find.error || search.error,
        summary: '审计 API 不可用',
        deepLinks,
        ttlMs: TTL_MS,
      })
    }

    const recallItems = (recallBucket.items || []).filter((it) =>
      (it.route || '').includes('recall')
    )
    const find24 = countSince(find.items, since)
    const search24 = countSince(search.items, since)
    const recall24 = countSince(recallItems, since)
    const commitItems = (sessions.items || []).filter((it) =>
      (it.route || '').includes('commit')
    )
    const commit24 = countSince(commitItems, since)

    const queueStatus = queue.data?.result?.status || ''
    const { embeddingPending, embeddingProcessed } = parseQueuePending(queueStatus)
    const vectorCount = parseVectorCount(vikingdb.data?.result?.status || '')

    const metrics: FleetInsightMetric[] = [
      {
        key: 'find_total',
        label: 'find 累计',
        value: find.total,
        unit: '次',
      },
      {
        key: 'find_24h_sample',
        label: 'find 近样',
        value: find24,
        unit: '次',
      },
      {
        key: 'search_total',
        label: 'search 累计',
        value: search.total,
        unit: '次',
      },
      {
        key: 'search_24h_sample',
        label: 'search 近样',
        value: search24,
        unit: '次',
      },
      {
        key: 'recall_24h_sample',
        label: 'recall 近样',
        value: recall24,
        unit: '次',
      },
      {
        key: 'commit_24h_sample',
        label: 'commit 近样',
        value: commit24,
        unit: '次',
      },
      {
        key: 'vectors',
        label: '向量条数',
        value: vectorCount || '—',
      },
      {
        key: 'embed_pending',
        label: 'Embedding 排队',
        value: embeddingPending,
      },
      {
        key: 'embed_processed',
        label: 'Embedding 已处理',
        value: embeddingProcessed,
      },
      {
        key: 'find_success_rate',
        label: 'find 成功率',
        value: find.successRate ? `${(find.successRate * 100).toFixed(1)}%` : '—',
      },
    ]

    const series: FleetInsightSeries[] = [
      hourlySeries(find.items, 'find_hourly', 'find / 小时'),
      hourlySeries(search.items, 'search_hourly', 'search / 小时'),
    ]

    const recentSource = [...find.items, ...search.items, ...recallItems]
      .map((it) => ({
        it,
        when: parseTime(it.created_at),
      }))
      .filter((x) => x.when > 0)
      .sort((a, b) => b.when - a.when)
      .slice(0, 8)

    const recent: FleetInsightRecentRow[] = recentSource.map(({ it, when }) => ({
      id: it.request_id || `${when}`,
      when,
      title: it.api_type || it.route || 'request',
      detail:
        typeof it.duration_ms === 'number'
          ? `${Math.round(it.duration_ms)}ms · HTTP ${it.status_code ?? '?'}`
          : `HTTP ${it.status_code ?? '?'}`,
      ok: (it.status_code || 0) >= 200 && (it.status_code || 0) < 400,
    }))

    const summary = [
      `find ${formatCompactNumber(find.total)}`,
      `search ${formatCompactNumber(search.total)}`,
      recall24 ? `recall≈${recall24}` : null,
      vectorCount ? `vectors ${formatCompactNumber(vectorCount)}` : null,
      embeddingPending > 0 ? `embed排队 ${embeddingPending}` : null,
    ]
      .filter(Boolean)
      .join(' · ')

    return {
      serviceId: ctx.serviceId,
      fetchedAt: Date.now(),
      ttlMs: TTL_MS,
      source: 'api',
      ok: true,
      summary,
      metrics,
      series,
      recent,
      deepLinks,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return emptyInsight(ctx.serviceId, {
      ok: false,
      source: 'api',
      error: message,
      deepLinks,
      ttlMs: TTL_MS,
    })
  }
}
