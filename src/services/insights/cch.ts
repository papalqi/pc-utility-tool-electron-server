/**
 * CCH insight adapter — overview KPIs + today cost leaderboards.
 * Rankings come from GET /api/v1/dashboard/realtime (user / provider / model).
 * Auth: CCH_ADMIN_TOKEN (Hub env).
 */

import {
  emptyInsight,
  fetchJson,
  formatCompactNumber,
  type FleetInsightMetric,
  type FleetInsightRankingRow,
  type FleetInsightRankings,
  type FleetInsightSeries,
  type FleetServiceInsight,
  type InsightAdapterContext,
} from './types';

const TTL_MS = 60_000;
const HISTORY_MAX = 48;
const RANK_TOP_N = 8;

interface Overview {
  concurrentSessions?: number;
  todayRequests?: number;
  todayCost?: number;
  avgResponseTime?: number;
  todayErrorRate?: number;
  yesterdaySamePeriodRequests?: number;
  yesterdaySamePeriodCost?: number;
  yesterdaySamePeriodAvgResponseTime?: number;
  recentMinuteRequests?: number;
}

interface ProviderHealthEntry {
  circuitState?: string;
  failureCount?: number;
}

interface RealtimeUserRank {
  userId?: number | string;
  userName?: string;
  name?: string;
  totalRequests?: number;
  totalCost?: number;
  totalTokens?: number;
}

interface RealtimeProviderRank {
  providerId?: number | string;
  providerName?: string;
  name?: string;
  totalRequests?: number;
  totalCost?: number;
  totalTokens?: number;
  successRate?: number;
}

interface RealtimeModelRank {
  model?: string;
  name?: string;
  totalRequests?: number;
  totalCost?: number;
  totalTokens?: number;
  successRate?: number;
}

interface RealtimePayload {
  metrics?: Overview;
  userRankings?: RealtimeUserRank[];
  providerRankings?: RealtimeProviderRank[];
  modelDistribution?: RealtimeModelRank[];
  modelRankings?: RealtimeModelRank[];
}

/** Process-local overview history for sparklines (resets on Hub restart). */
const overviewHistory: Array<{ t: number; requests: number; cost: number; sessions: number }> = [];

function pushHistory(o: Overview): void {
  overviewHistory.push({
    t: Date.now(),
    requests: Number(o.todayRequests || 0),
    cost: Number(o.todayCost || 0),
    sessions: Number(o.concurrentSessions || 0),
  });
  if (overviewHistory.length > HISTORY_MAX) {
    overviewHistory.splice(0, overviewHistory.length - HISTORY_MAX);
  }
}

function trendFromYesterday(today: number, yesterday: number): 'up' | 'down' | 'flat' {
  if (!Number.isFinite(today) || !Number.isFinite(yesterday) || yesterday === 0) return 'flat';
  const delta = (today - yesterday) / Math.abs(yesterday);
  if (delta > 0.05) return 'up';
  if (delta < -0.05) return 'down';
  return 'flat';
}

function finite(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapRow(
  id: string | number | undefined,
  name: string | undefined,
  fallbackId: string,
  requests: unknown,
  cost: unknown,
  tokens: unknown,
  successRate?: unknown
): FleetInsightRankingRow {
  const row: FleetInsightRankingRow = {
    id: id != null && String(id).trim() ? String(id) : fallbackId,
    name: (name && String(name).trim()) || fallbackId,
    cost: finite(cost),
    requests: Math.round(finite(requests)),
    tokens: Math.round(finite(tokens)),
  };
  const rate = finite(successRate);
  if (rate > 0) {
    // API may return 0-1 ratio or 0-100 percent.
    row.successRate = rate > 1 ? rate : rate * 100;
  }
  return row;
}

/** Pure parser — unit-tested. */
export function parseCchRealtimeRankings(payload: unknown, topN = RANK_TOP_N): FleetInsightRankings {
  const root =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as RealtimePayload)
      : {};

  const users = (root.userRankings || [])
    .map((item, index) =>
      mapRow(
        item.userId,
        item.userName || item.name,
        `user-${index + 1}`,
        item.totalRequests,
        item.totalCost,
        item.totalTokens
      )
    )
    .sort((a, b) => b.cost - a.cost)
    .slice(0, topN);

  const providers = (root.providerRankings || [])
    .map((item, index) =>
      mapRow(
        item.providerId,
        item.providerName || item.name,
        `provider-${index + 1}`,
        item.totalRequests,
        item.totalCost,
        item.totalTokens,
        item.successRate
      )
    )
    .sort((a, b) => b.cost - a.cost)
    .slice(0, topN);

  const modelSource = root.modelRankings || root.modelDistribution || [];
  const models = modelSource
    .map((item, index) =>
      mapRow(
        item.model || item.name,
        item.model || item.name,
        `model-${index + 1}`,
        item.totalRequests,
        item.totalCost,
        item.totalTokens,
        item.successRate
      )
    )
    .sort((a, b) => b.cost - a.cost)
    .slice(0, topN);

  return { users, providers, models };
}

export async function fetchCchInsight(ctx: InsightAdapterContext): Promise<FleetServiceInsight> {
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const token = ctx.authToken;
  const deepLinks = [
    { label: 'CCH Dashboard', url: `${base}/zh-CN/dashboard` },
    { label: 'Leaderboard', url: `${base}/zh-CN/leaderboard` },
    { label: 'Login', url: `${base}/zh-CN/login` },
  ];

  if (!token) {
    return emptyInsight(ctx.serviceId, {
      ok: false,
      source: 'api',
      error: '缺少 CCH_ADMIN_TOKEN（Hub env）',
      summary: '探活可正常，排行需要 Admin Token',
      deepLinks,
      ttlMs: TTL_MS,
    });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  const timeoutMs = ctx.timeoutMs;

  try {
    const [overviewRes, healthRes, providersRes, realtimeRes] = await Promise.all([
      fetchJson<Overview>(`${base}/api/v1/dashboard/overview`, { timeoutMs, headers }),
      fetchJson<Record<string, ProviderHealthEntry>>(`${base}/api/v1/providers/health`, {
        timeoutMs,
        headers,
      }),
      fetchJson<{ items?: Array<{ id?: number; name?: string; isEnabled?: boolean }> }>(
        `${base}/api/v1/providers`,
        {
          timeoutMs,
          headers,
        }
      ),
      fetchJson<RealtimePayload>(`${base}/api/v1/dashboard/realtime`, { timeoutMs, headers }),
    ]);

    if (!overviewRes.ok || !overviewRes.data) {
      return emptyInsight(ctx.serviceId, {
        ok: false,
        source: 'api',
        error: overviewRes.error || `overview HTTP ${overviewRes.status}`,
        deepLinks,
        ttlMs: TTL_MS,
      });
    }

    const o = overviewRes.data;
    pushHistory(o);

    let circuitsOpen = 0;
    if (healthRes.ok && healthRes.data) {
      for (const v of Object.values(healthRes.data)) {
        if ((v.circuitState || '').toLowerCase() === 'open') circuitsOpen += 1;
      }
    }

    const providersEnabled = (providersRes.data?.items || []).filter(p => p.isEnabled !== false)
      .length;
    const providersTotal = (providersRes.data?.items || []).length;

    const todayReq = Number(o.todayRequests || 0);
    const yReq = Number(o.yesterdaySamePeriodRequests || 0);
    const todayCost = Number(o.todayCost || 0);
    const yCost = Number(o.yesterdaySamePeriodCost || 0);
    const rawErrorRate = Number(o.todayErrorRate || 0);
    const errorRatePercent = rawErrorRate >= 0 && rawErrorRate <= 1 ? rawErrorRate * 100 : rawErrorRate;

    const rankings =
      realtimeRes.ok && realtimeRes.data
        ? parseCchRealtimeRankings(realtimeRes.data)
        : { users: [], providers: [], models: [] };

    const metrics: FleetInsightMetric[] = [
      {
        key: 'today_requests',
        label: '今日请求',
        value: todayReq,
        unit: '次',
        trend: trendFromYesterday(todayReq, yReq),
      },
      {
        key: 'today_cost',
        label: '今日成本',
        value: Number(todayCost.toFixed(3)),
        unit: 'USD',
        trend: trendFromYesterday(todayCost, yCost),
      },
      {
        key: 'avg_response_ms',
        label: '均响',
        value: Math.round(Number(o.avgResponseTime || 0)),
        unit: 'ms',
      },
      {
        key: 'error_rate',
        label: '错误率',
        value: Number(errorRatePercent.toFixed(1)),
        unit: '%',
      },
      {
        key: 'providers',
        label: '供应商',
        value: providersTotal ? `${providersEnabled}/${providersTotal}` : '—',
      },
      {
        key: 'circuits_open',
        label: '熔断打开',
        value: circuitsOpen,
      },
    ];

    const series: FleetInsightSeries[] = [
      {
        key: 'today_cost_history',
        label: '今日成本（采样）',
        points: overviewHistory.map(h => ({ t: h.t, v: Number(h.cost.toFixed(4)) })),
      },
      {
        key: 'today_requests_history',
        label: '今日请求（采样）',
        points: overviewHistory.map(h => ({ t: h.t, v: h.requests })),
      },
    ];

    const topUser = rankings.users[0];
    const summary = [
      `今日 ${formatCompactNumber(todayReq)} 请求`,
      `$${todayCost.toFixed(2)}`,
      topUser ? `Top ${topUser.name} $${topUser.cost.toFixed(2)}` : null,
      circuitsOpen > 0 ? `熔断 ${circuitsOpen}` : '熔断正常',
    ]
      .filter(Boolean)
      .join(' · ');

    return {
      serviceId: ctx.serviceId,
      fetchedAt: Date.now(),
      ttlMs: TTL_MS,
      source: 'api',
      ok: true,
      summary,
      metrics,
      series,
      rankings,
      deepLinks,
      error:
        realtimeRes.ok
          ? undefined
          : realtimeRes.error || `realtime HTTP ${realtimeRes.status}（排行可能为空）`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return emptyInsight(ctx.serviceId, {
      ok: false,
      source: 'api',
      error: message,
      deepLinks,
      ttlMs: TTL_MS,
    });
  }
}
