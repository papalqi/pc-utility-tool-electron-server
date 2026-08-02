/**
 * CCH insight adapter — dashboard overview + provider health + user today totals.
 * Auth: CCH_ADMIN_TOKEN (Hub env). Chart series built from in-process overview history.
 */

import {
  emptyInsight,
  fetchJson,
  formatCompactNumber,
  type FleetInsightMetric,
  type FleetInsightSeries,
  type FleetServiceInsight,
  type InsightAdapterContext,
} from './types';

const TTL_MS = 60_000;
const HISTORY_MAX = 48;

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

interface UserKey {
  todayUsage?: number;
  todayTokens?: number;
  todayCallCount?: number;
}

interface UserItem {
  keys?: UserKey[];
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

export async function fetchCchInsight(ctx: InsightAdapterContext): Promise<FleetServiceInsight> {
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const token = ctx.authToken;
  const deepLinks = [
    { label: 'CCH Dashboard', url: `${base}/zh-CN/dashboard` },
    { label: 'Login', url: `${base}/zh-CN/login` },
  ];

  if (!token) {
    return emptyInsight(ctx.serviceId, {
      ok: false,
      source: 'api',
      error: '缺少 CCH_ADMIN_TOKEN（Hub env）',
      summary: '探活可正常，图表需要 Admin Token',
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
    const [overviewRes, healthRes, usersRes, providersRes] = await Promise.all([
      fetchJson<Overview>(`${base}/api/v1/dashboard/overview`, { timeoutMs, headers }),
      fetchJson<Record<string, ProviderHealthEntry>>(`${base}/api/v1/providers/health`, {
        timeoutMs,
        headers,
      }),
      fetchJson<{ items?: UserItem[] }>(`${base}/api/v1/users`, { timeoutMs, headers }),
      fetchJson<{ items?: Array<{ id?: number; name?: string; isEnabled?: boolean }> }>(`${base}/api/v1/providers`, {
        timeoutMs,
        headers,
      }),
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

    let todayTokens = 0;
    let todayCallsFromKeys = 0;
    let todayUsageSum = 0;
    for (const u of usersRes.data?.items || []) {
      for (const k of u.keys || []) {
        todayTokens += Number(k.todayTokens || 0);
        todayCallsFromKeys += Number(k.todayCallCount || 0);
        todayUsageSum += Number(k.todayUsage || 0);
      }
    }

    let circuitsOpen = 0;
    if (healthRes.ok && healthRes.data) {
      for (const v of Object.values(healthRes.data)) {
        if ((v.circuitState || '').toLowerCase() === 'open') circuitsOpen += 1;
      }
    }

    const providersEnabled = (providersRes.data?.items || []).filter(p => p.isEnabled !== false).length;
    const providersTotal = (providersRes.data?.items || []).length;

    const todayReq = Number(o.todayRequests || 0);
    const yReq = Number(o.yesterdaySamePeriodRequests || 0);
    const todayCost = Number(o.todayCost || 0);
    const yCost = Number(o.yesterdaySamePeriodCost || 0);
    const rawErrorRate = Number(o.todayErrorRate || 0);
    const errorRatePercent = rawErrorRate >= 0 && rawErrorRate <= 1 ? rawErrorRate * 100 : rawErrorRate;

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
        key: 'concurrent_sessions',
        label: '并发会话',
        value: Number(o.concurrentSessions || 0),
      },
      {
        key: 'error_rate',
        label: '错误率',
        value: Number(errorRatePercent.toFixed(1)),
        unit: '%',
      },
      {
        key: 'recent_minute',
        label: '近1分钟',
        value: Number(o.recentMinuteRequests || 0),
        unit: '次',
      },
      {
        key: 'today_tokens_keys',
        label: '今日 Token',
        value: todayTokens,
        unit: 'tok',
      },
      {
        key: 'today_calls_keys',
        label: 'Key 调用',
        value: todayCallsFromKeys || todayUsageSum,
        unit: '次',
      },
      {
        key: 'circuits_open',
        label: '熔断打开',
        value: circuitsOpen,
      },
      {
        key: 'providers',
        label: '供应商',
        value: providersTotal ? `${providersEnabled}/${providersTotal}` : '—',
      },
    ];

    const series: FleetInsightSeries[] = [
      {
        key: 'today_requests_history',
        label: '今日请求（采样）',
        points: overviewHistory.map(h => ({ t: h.t, v: h.requests })),
      },
      {
        key: 'today_cost_history',
        label: '今日成本（采样）',
        points: overviewHistory.map(h => ({ t: h.t, v: Number(h.cost.toFixed(4)) })),
      },
      {
        key: 'sessions_history',
        label: '并发会话（采样）',
        points: overviewHistory.map(h => ({ t: h.t, v: h.sessions })),
      },
    ];

    const summary = [
      `今日 ${formatCompactNumber(todayReq)} 请求`,
      `$${todayCost.toFixed(2)}`,
      `均响 ${Math.round(Number(o.avgResponseTime || 0))}ms`,
      circuitsOpen > 0 ? `熔断 ${circuitsOpen}` : '熔断正常',
    ].join(' · ');

    return {
      serviceId: ctx.serviceId,
      fetchedAt: Date.now(),
      ttlMs: TTL_MS,
      source: 'api',
      ok: true,
      summary,
      metrics,
      series,
      deepLinks,
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
