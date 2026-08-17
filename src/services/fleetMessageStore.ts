/**
 * Fleet message inbox — external POST /report 推送的持久化收件箱。
 *
 * 与内存告警 ring（fleetMonitorService.alerts，100 条上限、message 截断、丢弃 meta）
 * 不同，这里保留完整 message 与 meta（含 openUrl 等），供桌面端「收件箱」页面阅读。
 * 只收外部 POST /report 的报告；探测状态迁移不进收件箱。
 *
 * 持久化方式照 knotJobService：JSON 文件放在 updates.dir 同级目录，
 * load on boot + write-through。
 */

import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { config } from '../config'
import { logger } from '../utils/logger'
import type { FleetHealthStatus } from './fleetMonitorService'

const log = logger.createScope('FleetMessageStore')
const MAX_MESSAGES = 500
const TITLE_MAX = 60

export interface FleetMessage {
  id: string
  serviceId: string
  serviceName: string
  severity: 'error' | 'warning' | 'info'
  status: FleetHealthStatus
  title: string
  /** 完整正文，不截断 */
  message: string
  /** 原始 meta（含 arashi openUrl 等），可能较大但不丢弃 */
  meta?: Record<string, unknown>
  at: number
  readAt: number | null
}

type MessageStore = {
  messages: FleetMessage[]
}

/** meta.title 优先，否则取 message 第一行截断。 */
function deriveTitle(message: string, meta?: Record<string, unknown>): string {
  const metaTitle = meta && typeof meta.title === 'string' ? meta.title.trim() : ''
  const base = metaTitle || (message.split('\n')[0] || '').trim() || '外部报告'
  return base.length > TITLE_MAX ? `${base.slice(0, TITLE_MAX)}…` : base
}

class FleetMessageStore {
  private filePath: string
  private store: MessageStore = { messages: [] }

  constructor() {
    this.filePath = path.join(config.updates.dir, '..', 'fleet-messages.json')
    this.load()
  }

  list(limit = 100, before?: number): { items: FleetMessage[]; unreadCount: number } {
    const capped = Math.max(1, Math.min(limit, MAX_MESSAGES))
    let items = this.store.messages
    if (typeof before === 'number' && before > 0) {
      items = items.filter((msg) => msg.at < before)
    }
    return { items: items.slice(0, capped), unreadCount: this.unreadCount() }
  }

  unreadCount(): number {
    return this.store.messages.reduce((n, msg) => n + (msg.readAt ? 0 : 1), 0)
  }

  add(input: {
    serviceId: string
    serviceName: string
    severity: 'error' | 'warning' | 'info'
    status: FleetHealthStatus
    message: string
    meta?: Record<string, unknown>
  }): FleetMessage {
    const msg: FleetMessage = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      serviceId: input.serviceId,
      serviceName: input.serviceName,
      severity: input.severity,
      status: input.status,
      title: deriveTitle(input.message, input.meta),
      message: input.message,
      meta: input.meta,
      at: Date.now(),
      readAt: null,
    }
    this.store.messages.unshift(msg)
    if (this.store.messages.length > MAX_MESSAGES) this.store.messages.length = MAX_MESSAGES
    this.save()
    return msg
  }

  markRead(id: string): FleetMessage | undefined {
    const msg = this.store.messages.find((item) => item.id === id)
    if (!msg) return undefined
    if (!msg.readAt) {
      msg.readAt = Date.now()
      this.save()
    }
    return msg
  }

  markAllRead(): number {
    const now = Date.now()
    let changed = 0
    for (const msg of this.store.messages) {
      if (!msg.readAt) {
        msg.readAt = now
        changed += 1
      }
    }
    if (changed > 0) this.save()
    return changed
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as MessageStore
      this.store = {
        messages: Array.isArray(parsed.messages)
          ? parsed.messages.map((msg) => ({ ...msg, readAt: msg.readAt ?? null }))
          : [],
      }
    } catch {
      this.store = { messages: [] }
    }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), 'utf8')
    } catch (error) {
      log.warn('failed to persist fleet messages', error)
    }
  }
}

export const fleetMessageStore = new FleetMessageStore()
