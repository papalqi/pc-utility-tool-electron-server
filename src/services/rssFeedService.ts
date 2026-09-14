/**
 * Ingest RSSHub + LSentry filtered lanes, then serve them from this host.
 *
 * Desktop and LSentry must not talk to rss.papalqi.top or :8080 directly.
 * LSentry pulls RSSHub via http://127.0.0.1:3000/rss/hub/* ;
 * desktop pulls http://<hub>/rss/reading and /rss/deals.
 */

import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import origins from '../data/internal-origins.json'
import { config } from '../config'
import {
  buildHubUpstreamUrl,
  buildLanePublicUrl,
  buildLaneUpstreamUrl,
  mapLaneSlug,
  rewriteRssHtmlImages,
  rssCacheKey,
  sanitizeHubRoute,
  type RssLane,
} from '../lib/rssFeed'
import { logger } from '../utils/logger'

const log = logger.createScope('RssFeed')

const MAX_BODY_BYTES = 8 * 1024 * 1024
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 PC-Utility-Tool-RSS/1.0'

export interface RssCachedBody {
  status: number
  contentType: string
  body: string
  fetchedAt: number
  upstream: string
  stale: boolean
}

interface RssCacheRecord {
  status: number
  contentType: string
  body: string
  fetchedAt: number
  upstream: string
}

type FetchResult =
  | { ok: true; record: RssCacheRecord }
  | { ok: false; error: string; status: number }

function originHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function selfHosts(): string[] {
  const extra = (process.env.RSS_PUBLIC_BASE || '').trim()
  const hosts = [originHost(origins.hub), originHost(extra)]
  return [...new Set(hosts.filter(Boolean))]
}

function now(): number {
  return Date.now()
}

function isFresh(fetchedAt: number): boolean {
  return now() - fetchedAt < config.rss.cacheTtlMs
}

function isUsable(fetchedAt: number): boolean {
  return now() - fetchedAt < config.rss.cacheStaleMs
}

function fileForKey(key: string): string {
  const hash = createHash('sha1').update(key).digest('hex')
  return path.join(config.rss.cacheDir, `${hash}.json`)
}

async function readDisk(key: string): Promise<RssCacheRecord | null> {
  try {
    const raw = await fs.readFile(fileForKey(key), 'utf8')
    const parsed = JSON.parse(raw) as Partial<RssCacheRecord>
    if (!parsed || typeof parsed.body !== 'string' || typeof parsed.fetchedAt !== 'number') {
      return null
    }
    return {
      status: Number(parsed.status) || 200,
      contentType: parsed.contentType || 'application/rss+xml; charset=utf-8',
      body: parsed.body,
      fetchedAt: parsed.fetchedAt,
      upstream: parsed.upstream || '',
    }
  } catch {
    return null
  }
}

async function writeDisk(key: string, record: RssCacheRecord): Promise<void> {
  try {
    await fs.mkdir(config.rss.cacheDir, { recursive: true })
    await fs.writeFile(fileForKey(key), JSON.stringify(record), 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('rss disk cache write failed', { key, error: message })
  }
}

async function fetchUpstream(url: string): Promise<FetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.rss.timeoutMs)
  const started = Date.now()
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept:
          'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, */*',
        'User-Agent': USER_AGENT,
      },
    })
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > MAX_BODY_BYTES) {
      log.warn('rss upstream body too large', { url, bytes: buf.length })
      return { ok: false, error: `upstream body ${buf.length} exceeds ${MAX_BODY_BYTES}`, status: 502 }
    }
    const contentType =
      resp.headers.get('content-type') ||
      (url.includes('format=json') ? 'application/feed+json; charset=utf-8' : 'application/rss+xml; charset=utf-8')
    const record: RssCacheRecord = {
      status: resp.status,
      contentType,
      body: buf.toString('utf8'),
      fetchedAt: Date.now(),
      upstream: url,
    }
    log.info('rss upstream fetched', {
      url,
      status: resp.status,
      bytes: buf.length,
      latencyMs: Date.now() - started,
    })
    if (!resp.ok) {
      return { ok: false, error: `upstream HTTP ${resp.status}`, status: resp.status }
    }
    return { ok: true, record }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const message = error instanceof Error ? error.message : String(error)
    const text = name === 'AbortError' ? `timeout ${config.rss.timeoutMs}ms` : message || 'request failed'
    log.warn('rss upstream failed', { url, error: text, latencyMs: Date.now() - started })
    return { ok: false, error: text, status: 502 }
  } finally {
    clearTimeout(timer)
  }
}

function toBody(record: RssCacheRecord, stale: boolean): RssCachedBody {
  return { ...record, stale }
}

function withStatus(error: unknown, status: number): Error {
  const err = error instanceof Error ? error : new Error(String(error))
  if ((err as Error & { status?: number }).status) return err
  ;(err as Error & { status?: number }).status = status
  return err
}

class RssFeedService {
  private memory = new Map<string, RssCacheRecord>()
  private inflight = new Map<string, Promise<FetchResult>>()
  private timer: NodeJS.Timeout | null = null
  private lastPrefetchAt = 0
  private lastPrefetchError: string | null = null
  private prefetching = false
  private lastLanes: { slug: string; name: string; url: string }[] = [
    { slug: 'reading', name: '入选', url: buildLanePublicUrl(origins.hub, 'reading') },
    { slug: 'wool', name: '羊毛', url: buildLanePublicUrl(origins.hub, 'wool') },
  ]

  start(): void {
    if (this.timer) return
    log.info('RSS distribute starting', {
      upstream: config.rss.rsshubUpstream,
      lsentry: config.rss.lsentryBase,
      cacheDir: config.rss.cacheDir,
      ttlMs: config.rss.cacheTtlMs,
      prefetchMs: config.rss.prefetchMs,
    })
    void this.prefetchLanes()
    this.timer = setInterval(() => {
      void this.prefetchLanes()
    }, config.rss.prefetchMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  health(): {
    ok: boolean
    upstream: string
    lsentry: string
    cacheEntries: number
    lastPrefetchAt: number | null
    lastPrefetchError: string | null
    reading: string
    deals: string
    hub: string
    lanes: { slug: string; name: string; url: string }[]
  } {
    const reading = this.memory.get(rssCacheKey('lane', 'reading'))
    const deals = this.memory.get(rssCacheKey('lane', 'deals'))
    return {
      ok: Boolean(reading || deals),
      upstream: config.rss.rsshubUpstream,
      lsentry: config.rss.lsentryBase,
      cacheEntries: this.memory.size,
      lastPrefetchAt: this.lastPrefetchAt || null,
      lastPrefetchError: this.lastPrefetchError,
      reading: '/rss/reading',
      deals: '/rss/deals',
      hub: '/rss/hub/*',
      lanes: this.lastLanes,
    }
  }

  async serveHub(route: string, search = ''): Promise<RssCachedBody> {
    try {
      const safe = sanitizeHubRoute(route)
      const upstream = buildHubUpstreamUrl({
        upstream: config.rss.rsshubUpstream,
        route: safe,
        search,
        accessKey: config.rss.rsshubAccessKey,
        selfHosts: selfHosts(),
      })
      return this.serve(rssCacheKey('hub', safe, search), upstream)
    } catch (error) {
      throw withStatus(error, 400)
    }
  }

  async serveLane(lane: RssLane): Promise<RssCachedBody> {
    try {
      const upstream = buildLaneUpstreamUrl(config.rss.lsentryBase, lane)
      const cached = await this.serve(rssCacheKey('lane', lane), upstream)
      const proxy = `${origins.hub.replace(/\/+$/, '')}/rss/asset`
      return { ...cached, body: rewriteRssHtmlImages(cached.body, proxy) }
    } catch (error) {
      throw withStatus(error, 400)
    }
  }

  private async listLaneSlugs(): Promise<string[]> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(`${config.rss.lsentryBase}/api/lanes`, { signal: controller.signal })
      clearTimeout(timer)
      const json = (await res.json()) as { lanes?: { slug: string; name: string }[] }
      if (!Array.isArray(json.lanes) || json.lanes.length === 0) return ['reading', 'deals']
      this.lastLanes = json.lanes.map((lane) => ({
        slug: lane.slug,
        name: lane.name,
        url: buildLanePublicUrl(origins.hub, lane.slug),
      }))
      return this.lastLanes.map((lane) => mapLaneSlug(lane.slug))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('rss lane catalog failed', { error: message })
      return ['reading', 'deals']
    }
  }

  private async prefetchLanes(): Promise<void> {
    if (this.prefetching) return
    this.prefetching = true
    try {
      const slugs = await this.listLaneSlugs()
      await Promise.all(slugs.map((lane) => this.serveLane(lane)))
      this.lastPrefetchAt = now()
      this.lastPrefetchError = null
      log.info('rss lanes prefetched', {
        slugs,
        readingBytes: this.memory.get(rssCacheKey('lane', 'reading'))?.body.length || 0,
        dealsBytes: this.memory.get(rssCacheKey('lane', 'deals'))?.body.length || 0,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastPrefetchError = message
      log.warn('rss lane prefetch failed', { error: message })
    } finally {
      this.prefetching = false
    }
  }

  private async serve(key: string, upstream: string): Promise<RssCachedBody> {
    const mem = this.memory.get(key)
    if (mem && isFresh(mem.fetchedAt)) {
      return toBody(mem, false)
    }
    if (mem && isUsable(mem.fetchedAt)) {
      void this.refresh(key, upstream)
      return toBody(mem, true)
    }

    const disk = mem ? null : await readDisk(key)
    if (disk) {
      this.memory.set(key, disk)
      if (isFresh(disk.fetchedAt)) return toBody(disk, false)
      if (isUsable(disk.fetchedAt)) {
        void this.refresh(key, upstream)
        return toBody(disk, true)
      }
    }

    const fetched = await this.refresh(key, upstream)
    if (fetched.ok) return toBody(fetched.record, false)
    const stale = this.memory.get(key)
    if (stale) return toBody(stale, true)
    const err = new Error(fetched.error)
    ;(err as Error & { status?: number }).status = fetched.status
    throw err
  }

  private refresh(key: string, upstream: string): Promise<FetchResult> {
    const existing = this.inflight.get(key)
    if (existing) return existing
    const pending = (async () => {
      const result = await fetchUpstream(upstream)
      if (result.ok) {
        this.memory.set(key, result.record)
        void writeDisk(key, result.record)
      }
      return result
    })()
    this.inflight.set(key, pending)
    void pending.finally(() => {
      this.inflight.delete(key)
    })
    return pending
  }
}

export const rssFeedService = new RssFeedService()
