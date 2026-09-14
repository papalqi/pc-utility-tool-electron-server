/**
 * Pure RSS distribute helpers.
 * RSSHub is ingested on this host; clients only fetch /rss/*.
 */

export type RssLane = string

const RESERVED_RSS_PATHS = new Set(['', 'health', 'hub', 'asset', 'index', 'social-sources'])

const DEFAULT_SELF_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export function sanitizeHubRoute(raw: string): string {
  let path = (raw || '').trim()
  if (!path) {
    throw new Error('empty rsshub route')
  }
  if (path.length > 512) {
    throw new Error('rsshub route too long')
  }
  const q = path.indexOf('?')
  if (q >= 0) path = path.slice(0, q)
  try {
    path = decodeURIComponent(path)
  } catch {
    throw new Error('invalid rsshub route encoding')
  }
  if (path.includes('://') || path.startsWith('//')) {
    throw new Error('rsshub route must be a relative path')
  }
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error('rsshub route must not contain . or ..')
  }
  if (!path.startsWith('/')) path = `/${path}`
  if (path === '/') {
    throw new Error('empty rsshub route')
  }
  return path
}

export function looksLikeSelfRssProxy(url: string, extraHosts: string[] = []): boolean {
  try {
    const parsed = new URL(url)
    const hosts = new Set(DEFAULT_SELF_HOSTS)
    for (const host of extraHosts) {
      const trimmed = host.trim().toLowerCase()
      if (trimmed) hosts.add(trimmed)
    }
    return hosts.has(parsed.hostname.toLowerCase()) && parsed.pathname.startsWith('/rss')
  } catch {
    return false
  }
}

function mergeSearch(url: URL, search: string, accessKey?: string): void {
  const extra = search.startsWith('?') ? search.slice(1) : search
  if (extra) {
    const params = new URLSearchParams(extra)
    for (const [key, value] of params.entries()) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value)
    }
  }
  const key = (accessKey || '').trim()
  if (key && !url.searchParams.has('key')) {
    url.searchParams.set('key', key)
  }
}

export function buildHubUpstreamUrl(input: {
  upstream: string
  route: string
  search?: string
  accessKey?: string
  selfHosts?: string[]
}): string {
  const base = stripTrailingSlash((input.upstream || '').trim())
  if (!base) {
    throw new Error('RSSHUB_UPSTREAM_URL is empty')
  }
  const route = sanitizeHubRoute(input.route)
  const url = new URL(`${base}${route}`)
  mergeSearch(url, input.search || '', input.accessKey)
  const href = url.toString()
  if (looksLikeSelfRssProxy(href, input.selfHosts)) {
    throw new Error('refusing to fetch this host /rss (loop)')
  }
  return href
}

export function isReservedRssPath(slug: string): boolean {
  return RESERVED_RSS_PATHS.has((slug || '').trim().toLowerCase())
}

export function mapLaneSlug(slug: string): string {
  return slug === 'wool' ? 'deals' : slug
}

export function buildLanePublicUrl(hubBase: string, slug: string): string {
  return `${stripTrailingSlash(hubBase)}/rss/${mapLaneSlug(slug)}`
}

export function buildLaneUpstreamUrl(lsentryBase: string, lane: RssLane): string {
  const base = stripTrailingSlash((lsentryBase || '').trim())
  if (!base) {
    throw new Error('LSENTRY_BASE_URL is empty')
  }
  const slug = (lane || '').trim().toLowerCase()
  if (!slug || isReservedRssPath(slug)) {
    throw new Error(`unknown rss lane: ${lane}`)
  }
  if (!/^[a-z0-9-]{2,32}$/.test(slug)) {
    throw new Error(`invalid rss lane: ${lane}`)
  }
  return `${base}/feed/${slug}`
}

export function rewriteRssHtmlImages(xml: string, proxyBase: string): string {
  if (!xml || !proxyBase) return xml
  const base = stripTrailingSlash(proxyBase)
  return xml.replace(/<img\b[^>]*>/gi, (tag) => {
    return tag.replace(/\ssrc\s*=\s*(['"])([^'"]*)\1/i, (_all, quote: string, src: string) => {
      const value = (src || '').trim()
      if (!value || value.includes('/rss/asset') || value.includes('/api/asset') || value.startsWith('data:')) {
        return ` src=${quote}${value}${quote}`
      }
      return ` src=${quote}${base}?u=${encodeURIComponent(value)}${quote}`
    })
  })
}

export function isBlockedAssetHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true
  if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) return true
  const m = host.match(/^172\.(\d+)\./)
  return Boolean(m && Number(m[1]) >= 16 && Number(m[1]) <= 31)
}

export function rssCacheKey(kind: 'hub' | 'lane', route: string, search = ''): string {
  const extra = search.startsWith('?') ? search : search ? `?${search}` : ''
  return `${kind}:${route}${extra}`
}
