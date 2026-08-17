import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { config } from '../config'
import { logger } from '../utils/logger'

const log = logger.createScope('CchProfile')

export type CchCliProfileEntry = {
  baseUrl?: string
  path?: string
  apiKey?: string
  updatedAt?: number
}

export type CchProfileStore = {
  claude?: CchCliProfileEntry
  codex?: CchCliProfileEntry
  grok?: CchCliProfileEntry
  updatedAt?: number
}

const CCH_CLIS = ['claude', 'codex', 'grok'] as const

/**
 * Local mirror of the client-side normalize logic (electron-server cannot
 * import src/shared — rootDir is ./src). Accepts both the per-CLI model and
 * the legacy flat shape (`baseUrl` / `apiKey` / `claudePath` / `codexPath` /
 * `grokPath`); legacy fields fan out into every CLI section, explicit
 * sections win. Sections with no content at all are dropped.
 */
function normalizeStore(raw: Record<string, unknown>): CchProfileStore {
  const legacyBaseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : ''
  const legacyApiKey = typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : undefined
  const profile: CchProfileStore = {}
  if (typeof raw.updatedAt === 'number') profile.updatedAt = raw.updatedAt
  for (const cli of CCH_CLIS) {
    const rawSection = raw[cli]
    const section =
      rawSection && typeof rawSection === 'object' && !Array.isArray(rawSection)
        ? (rawSection as CchCliProfileEntry)
        : undefined
    const legacyPath = typeof raw[`${cli}Path`] === 'string' ? String(raw[`${cli}Path`]).trim() : ''
    const baseUrl = (section?.baseUrl?.trim() || legacyBaseUrl).replace(/\/+$/, '')
    const sectionPath = section?.path?.trim() || legacyPath || undefined
    const apiKey = section?.apiKey?.trim() || legacyApiKey
    const updatedAt = typeof section?.updatedAt === 'number' ? section.updatedAt : undefined
    if (!baseUrl && !sectionPath && !apiKey) continue
    profile[cli] = {
      ...(baseUrl ? { baseUrl } : {}),
      ...(sectionPath ? { path: sectionPath } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    }
  }
  return profile
}

class CchProfileService {
  private filePath: string
  private profile: CchProfileStore = {}

  constructor() {
    this.filePath = path.join(config.updates.dir, '..', 'cch-profile.json')
    this.load()
  }

  get(includeKey = false): CchProfileStore {
    if (includeKey) return { ...this.profile }
    const out: CchProfileStore = {}
    if (typeof this.profile.updatedAt === 'number') out.updatedAt = this.profile.updatedAt
    for (const cli of CCH_CLIS) {
      const section = this.profile[cli]
      if (!section) continue
      const { apiKey: _omitted, ...rest } = section
      out[cli] = rest
    }
    return out
  }

  getForApply(): CchProfileStore {
    return { ...this.profile }
  }

  /**
   * Merge per CLI section: only sections present in input are touched, and
   * within a section only the provided fields (baseUrl / path / apiKey) are
   * overwritten — one machine's upload never clobbers another CLI's config.
   */
  save(input: Record<string, unknown>): CchProfileStore {
    const incoming = normalizeStore(input && typeof input === 'object' ? input : {})
    const now = Date.now()
    const next: CchProfileStore = { ...this.profile, updatedAt: now }
    for (const cli of CCH_CLIS) {
      const section = incoming[cli]
      if (!section) continue
      const current = this.profile[cli] || {}
      const baseUrl = section.baseUrl || current.baseUrl
      const sectionPath = section.path !== undefined ? section.path : current.path
      const apiKey = section.apiKey || current.apiKey
      next[cli] = {
        ...(baseUrl ? { baseUrl } : {}),
        ...(sectionPath !== undefined ? { path: sectionPath } : {}),
        ...(apiKey ? { apiKey } : {}),
        updatedAt: now,
      }
    }
    this.profile = next
    this.persist()
    log.info('CCH profile saved', {
      sections: CCH_CLIS.filter((cli) => next[cli]).map((cli) => {
        const section = next[cli]
        return `${cli}:${section?.baseUrl || '-'}${section?.path || ''}${section?.apiKey ? ' key' : ''}`
      }),
    })
    return this.get(false)
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.profile = normalizeStore(parsed as Record<string, unknown>)
      }
    } catch {
      this.profile = {}
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.profile, null, 2), 'utf8')
  }
}

export const cchProfileService = new CchProfileService()
