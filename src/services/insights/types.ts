/**
 * Fleet business-insight types (Hub side).
 * Mirror of client `@shared/service-monitor` insight shapes — keep fields in sync.
 */

export interface FleetInsightMetric {
  key: string;
  label: string;
  value: number | string;
  unit?: string;
  trend?: 'up' | 'down' | 'flat';
}

export interface FleetInsightSeries {
  key: string;
  label: string;
  points: Array<{ t: number; v: number }>;
}

export interface FleetInsightLink {
  label: string;
  url: string;
}

export interface FleetInsightRecentRow {
  id: string;
  when: number;
  title: string;
  detail?: string;
  ok?: boolean;
}

/** Cost leaderboard row shared by users / providers / models. */
export interface FleetInsightRankingRow {
  id: string;
  name: string;
  cost: number;
  requests: number;
  tokens: number;
  successRate?: number;
}

export interface FleetInsightRankings {
  users: FleetInsightRankingRow[];
  providers: FleetInsightRankingRow[];
  models: FleetInsightRankingRow[];
}

export interface FleetServiceInsight {
  serviceId: string;
  fetchedAt: number;
  ttlMs: number;
  source: 'api' | 'sqlite' | 'proxy' | 'none' | 'mixed';
  ok: boolean;
  error?: string;
  summary?: string;
  metrics: FleetInsightMetric[];
  series?: FleetInsightSeries[];
  recent?: FleetInsightRecentRow[];
  deepLinks?: FleetInsightLink[];
  /** CCH cost leaderboards (today). */
  rankings?: FleetInsightRankings;
}

export type InsightAdapterId = 'openviking' | 'cch' | 'hapi' | 'arashi' | 'utility-update' | 'none';

export interface InsightAdapterContext {
  serviceId: string;
  /** Prefer loopback for co-located services */
  baseUrl: string;
  openUrl?: string;
  /** Resolved secret from env (never log) */
  authToken?: string;
  timeoutMs: number;
}

export type InsightAdapter = (ctx: InsightAdapterContext) => Promise<FleetServiceInsight>;

export function emptyInsight(
  serviceId: string,
  partial: Partial<FleetServiceInsight> & { error?: string; ok?: boolean }
): FleetServiceInsight {
  return {
    serviceId,
    fetchedAt: Date.now(),
    ttlMs: partial.ttlMs ?? 90_000,
    source: partial.source ?? 'none',
    ok: partial.ok ?? false,
    error: partial.error,
    summary: partial.summary,
    metrics: partial.metrics ?? [],
    series: partial.series,
    recent: partial.recent,
    deepLinks: partial.deepLinks,
    rankings: partial.rankings,
  };
}

export async function fetchText(
  url: string,
  opts: {
    timeoutMs: number;
    headers?: Record<string, string>;
    method?: string;
  }
): Promise<{ ok: boolean; status: number; text: string; latencyMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const resp = await fetch(url, {
      method: opts.method || 'GET',
      signal: controller.signal,
      headers: {
        Accept: '*/*',
        'User-Agent': 'FleetInsight/1.0',
        ...(opts.headers || {}),
      },
    });
    const text = await resp.text();
    return {
      ok: resp.ok,
      status: resp.status,
      text,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, text: message, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  opts: {
    timeoutMs: number;
    headers?: Record<string, string>;
  }
): Promise<{ ok: boolean; status: number; data?: T; error?: string; latencyMs: number }> {
  const r = await fetchText(url, opts);
  if (!r.ok) {
    return { ok: false, status: r.status, error: r.text.slice(0, 200), latencyMs: r.latencyMs };
  }
  try {
    return {
      ok: true,
      status: r.status,
      data: JSON.parse(r.text) as T,
      latencyMs: r.latencyMs,
    };
  } catch {
    return { ok: false, status: r.status, error: 'invalid json', latencyMs: r.latencyMs };
  }
}

export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}
