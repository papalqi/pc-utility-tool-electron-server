/**
 * Fleet business insights — Hub-side adapters with TTL cache.
 * Clients only call /api/fleet/insights*; secrets stay on Hub.
 */

import { logger } from '../utils/logger';
import { fleetMonitorService } from './fleetMonitorService';
import { fetchOpenVikingInsight } from './insights/openviking';
import { fetchCchInsight } from './insights/cch';
import { fetchArashiInsight, fetchHapiInsight, fetchUtilityUpdateInsight } from './insights/generic';
import { emptyInsight, type FleetServiceInsight, type InsightAdapter, type InsightAdapterId } from './insights/types';

const log = logger.createScope('FleetInsight');

const REFRESH_MS = Number(process.env.FLEET_INSIGHT_INTERVAL_MS || 90_000);
const DEFAULT_TIMEOUT_MS = Number(process.env.FLEET_INSIGHT_TIMEOUT_MS || 8_000);

interface InsightTarget {
  serviceId: string;
  adapter: InsightAdapterId;
  baseUrl: string;
  openUrl?: string;
  authEnv?: string;
  enabled?: boolean;
}

const DEFAULT_INSIGHT_TARGETS: InsightTarget[] = [
  {
    serviceId: 'openviking',
    adapter: 'openviking',
    // Co-located with Hub on 21.6.70.42
    baseUrl: process.env.OPENVIKING_BASE_URL || 'http://127.0.0.1:1933',
    openUrl: 'http://21.6.70.42:1933/studio/',
    authEnv: 'OPENVIKING_FLEET_API_KEY',
  },
  {
    serviceId: 'cch',
    adapter: 'cch',
    baseUrl: process.env.CCH_BASE_URL || 'http://21.6.92.218:23000',
    openUrl: 'http://21.6.92.218:23000/zh-CN/dashboard',
    authEnv: 'CCH_ADMIN_TOKEN',
  },
  {
    serviceId: 'hapi-hub',
    adapter: 'hapi',
    baseUrl: process.env.HAPI_BASE_URL || 'http://21.6.69.126:3006',
    openUrl: 'http://21.6.69.126:3006/',
  },
  {
    serviceId: 'arashi-shader',
    adapter: 'arashi',
    baseUrl: process.env.ARASHI_BASE_URL || 'http://9.134.68.75:8080',
    openUrl: 'http://9.134.68.75:8080/',
  },
  {
    serviceId: 'utility-update-origin',
    adapter: 'utility-update',
    baseUrl: process.env.UTILITY_HUB_BASE_URL || 'http://127.0.0.1:3000',
    openUrl: 'http://21.6.70.42:3000/updates/latest.yml',
  },
];

const ADAPTERS: Record<Exclude<InsightAdapterId, 'none'>, InsightAdapter> = {
  openviking: fetchOpenVikingInsight,
  cch: fetchCchInsight,
  hapi: fetchHapiInsight,
  arashi: fetchArashiInsight,
  'utility-update': fetchUtilityUpdateInsight,
};

function resolveAuth(envName?: string): string | undefined {
  if (!envName) return undefined;
  const primary = process.env[envName];
  if (primary && primary.trim()) return primary.trim();
  // Fallbacks without documenting secrets in code comments beyond env names
  if (envName === 'OPENVIKING_FLEET_API_KEY') {
    const alt = process.env.OPENVIKING_API_KEY || process.env.OPENVIKING_BEARER_TOKEN;
    return alt?.trim() || undefined;
  }
  if (envName === 'CCH_ADMIN_TOKEN') {
    return process.env.CCH_ADMIN_TOKEN?.trim() || undefined;
  }
  return undefined;
}

function isServiceHealthyEnough(serviceId: string): boolean {
  const snap = fleetMonitorService.getSnapshot();
  const r = snap.results.find(x => x.serviceId === serviceId);
  if (!r) return true; // allow first fetch before probe
  return r.status === 'up' || r.status === 'degraded';
}

class FleetInsightService {
  private cache = new Map<string, FleetServiceInsight>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private targets = DEFAULT_INSIGHT_TARGETS;

  start(): void {
    if (this.timer) return;
    log.info('Fleet insight service starting', {
      intervalMs: REFRESH_MS,
      targets: this.targets.filter(t => t.enabled !== false).map(t => t.serviceId),
    });
    void this.refreshAll();
    this.timer = setInterval(() => {
      void this.refreshAll();
    }, REFRESH_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getAll(): FleetServiceInsight[] {
    return this.targets
      .filter(t => t.enabled !== false)
      .map(t => this.cache.get(t.serviceId) || this.placeholder(t.serviceId, '尚未拉取'));
  }

  getOne(serviceId: string): FleetServiceInsight | null {
    const cached = this.cache.get(serviceId);
    if (cached) return cached;
    const known = this.targets.some(t => t.serviceId === serviceId && t.enabled !== false);
    if (!known) return null;
    return this.placeholder(serviceId, '尚未拉取');
  }

  getMap(): Record<string, FleetServiceInsight> {
    const out: Record<string, FleetServiceInsight> = {};
    for (const insight of this.getAll()) {
      out[insight.serviceId] = insight;
    }
    return out;
  }

  async refreshAll(): Promise<FleetServiceInsight[]> {
    if (this.refreshing) return this.getAll();
    this.refreshing = true;
    try {
      const enabled = this.targets.filter(t => t.enabled !== false);
      await Promise.all(enabled.map(t => this.refreshOne(t)));
      return this.getAll();
    } finally {
      this.refreshing = false;
    }
  }

  async refreshService(serviceId: string): Promise<FleetServiceInsight> {
    const target = this.targets.find(t => t.serviceId === serviceId);
    if (!target || target.enabled === false) {
      return emptyInsight(serviceId, {
        ok: false,
        error: 'no insight adapter for service',
        source: 'none',
      });
    }
    return this.refreshOne(target);
  }

  private placeholder(serviceId: string, error: string): FleetServiceInsight {
    return emptyInsight(serviceId, {
      ok: false,
      error,
      source: 'none',
      ttlMs: REFRESH_MS,
    });
  }

  private async refreshOne(target: InsightTarget): Promise<FleetServiceInsight> {
    if (!isServiceHealthyEnough(target.serviceId)) {
      const downInsight = emptyInsight(target.serviceId, {
        ok: false,
        error: '服务探活非 up/degraded，跳过业务指标',
        source: 'none',
        summary: '等待服务恢复',
        deepLinks: target.openUrl ? [{ label: '打开', url: target.openUrl }] : undefined,
        ttlMs: REFRESH_MS,
      });
      this.cache.set(target.serviceId, downInsight);
      return downInsight;
    }

    if (target.adapter === 'none') {
      const none = emptyInsight(target.serviceId, { ok: true, source: 'none', summary: '无业务 adapter' });
      this.cache.set(target.serviceId, none);
      return none;
    }

    const adapter = ADAPTERS[target.adapter];
    const authToken = resolveAuth(target.authEnv);
    try {
      const insight = await adapter({
        serviceId: target.serviceId,
        baseUrl: target.baseUrl,
        openUrl: target.openUrl,
        authToken,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      this.cache.set(target.serviceId, insight);
      if (!insight.ok) {
        log.warn('Insight adapter soft-fail', { serviceId: target.serviceId, error: insight.error });
      }
      return insight;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Insight adapter failed', { serviceId: target.serviceId, message });
      const failed = emptyInsight(target.serviceId, {
        ok: false,
        error: message,
        source: 'api',
        ttlMs: REFRESH_MS,
      });
      this.cache.set(target.serviceId, failed);
      return failed;
    }
  }
}

export const fleetInsightService = new FleetInsightService();
