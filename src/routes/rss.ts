/**
 * RSS distribute API — clients only talk to this host.
 *
 * GET  /rss/              index
 * GET  /rss/health        ingest status
 * GET  /rss/reading       L哨入选（筛后）
 * GET  /rss/deals         L哨羊毛
 * GET  /rss/hub/*         RSSHub 缓存代理（LSentry 拉取入口）
 */

import { Router, Request, Response } from 'express'
import socialSources from '../data/rss-social-sources.json'
import origins from '../data/internal-origins.json'
import { rssFeedService, type RssCachedBody } from '../services/rssFeedService'
import { logger } from '../utils/logger'
import { isBlockedAssetHost, isReservedRssPath, type RssLane } from '../lib/rssFeed'

const log = logger.createScope('RssRoute')
const router = Router()

function requestSearch(req: Request): string {
  const url = req.originalUrl || req.url || ''
  const q = url.indexOf('?')
  return q >= 0 ? url.slice(q) : ''
}

function sendCached(res: Response, cached: RssCachedBody): void {
  res.status(cached.status >= 400 ? cached.status : 200)
  res.setHeader('Content-Type', cached.contentType || 'application/rss+xml; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=60')
  res.setHeader('X-Rss-Cache', cached.stale ? 'stale' : 'fresh')
  res.setHeader('X-Rss-Fetched-At', String(cached.fetchedAt))
  res.send(cached.body)
}

function sendError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const status = Number((error as { status?: number })?.status) || 502
  const code = status >= 400 && status < 600 ? status : 502
  log.warn('rss serve failed', { error: message, status: code })
  res.status(code).json({
    success: false,
    error: message,
  })
}

router.get('/', (_req: Request, res: Response) => {
  res.json({
    success: true,
    ...rssFeedService.health(),
  })
})

router.get('/health', (_req: Request, res: Response) => {
  const health = rssFeedService.health()
  res.json({ success: true, ...health })
})

router.get('/social-sources', (_req: Request, res: Response) => {
  const hub = String(origins.hub || '').replace(/\/+$/, '')
  const sources = (socialSources as { title: string; path: string }[]).map((item) => {
    const path = item.path.startsWith('/') ? item.path : `/${item.path}`
    return {
      title: item.title,
      path,
      url: `${hub}/rss/hub${path}`,
    }
  })
  res.json({ success: true, sources })
})

async function serveLane(lane: RssLane, res: Response): Promise<void> {
  try {
    const cached = await rssFeedService.serveLane(lane)
    sendCached(res, cached)
  } catch (error) {
    sendError(res, error)
  }
}

router.get('/reading', (_req: Request, res: Response) => {
  void serveLane('reading', res)
})

router.get('/deals', (_req: Request, res: Response) => {
  void serveLane('deals', res)
})

router.get('/wool', (_req: Request, res: Response) => {
  void serveLane('wool', res)
})

router.get('/asset', (req: Request, res: Response) => {
  void (async () => {
    const raw = typeof req.query.u === 'string' ? req.query.u : ''
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      res.status(400).json({ success: false, error: 'bad url' })
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ success: false, error: 'bad protocol' })
      return
    }
    if (isBlockedAssetHost(parsed.hostname)) {
      res.status(400).json({ success: false, error: 'blocked host' })
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    try {
      const upstream = await fetch(parsed.href, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          Accept: 'image/*,*/*',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      })
      const type = upstream.headers.get('content-type') || 'application/octet-stream'
      if (!upstream.ok) {
        res.status(502).json({ success: false, error: `upstream ${upstream.status}` })
        return
      }
      if (!type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
        res.status(415).json({ success: false, error: 'not an image' })
        return
      }
      res.status(200)
      res.setHeader('Content-Type', type)
      res.setHeader('Cache-Control', 'public, max-age=86400')
      const buf = Buffer.from(await upstream.arrayBuffer())
      res.send(buf)
    } catch (error) {
      sendError(res, error)
    } finally {
      clearTimeout(timer)
    }
  })()
})

router.use('/hub', (req: Request, res: Response) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ success: false, error: 'method not allowed' })
    return
  }
  void (async () => {
    try {
      const cached = await rssFeedService.serveHub(req.path || '/', requestSearch(req))
      sendCached(res, cached)
    } catch (error) {
      sendError(res, error)
    }
  })()
})

router.get('/:slug', (req: Request, res: Response) => {
  const slug = String(req.params.slug || '')
  if (isReservedRssPath(slug)) {
    res.status(404).json({ success: false, error: 'not found' })
    return
  }
  void serveLane(slug as RssLane, res)
})

export default router
