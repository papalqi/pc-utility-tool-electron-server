/**
 * Control-plane auth backed by PostgreSQL (users + refresh sessions + devices).
 */

import { createHash, randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { query } from '../db/pool'
import { generateToken } from '../middleware/auth'
import { logger } from '../utils/logger'

const log = logger.createScope('ControlPlaneAuth')

const REFRESH_DAYS = Number(process.env.REFRESH_TOKEN_DAYS || 30)
const BCRYPT_ROUNDS = 12

export type ControlUser = {
  id: string
  username: string
  displayName: string | null
  status: string
  createdAt: Date
  updatedAt: Date
}

export type AuthTokens = {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: { id: string; username: string; displayName: string | null }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function newRefreshToken(): string {
  return randomBytes(48).toString('base64url')
}

export async function registerUser(input: {
  username: string
  password: string
  displayName?: string
}): Promise<ControlUser> {
  const username = input.username.trim()
  if (username.length < 3) throw new Error('Username must be at least 3 characters')
  if (input.password.length < 6) throw new Error('Password must be at least 6 characters')

  const existing = await query<{ id: string }>(
    'SELECT id FROM users WHERE lower(username) = lower($1) LIMIT 1',
    [username]
  )
  if (existing.rowCount && existing.rows[0]) {
    throw new Error('Username already exists')
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS)
  const id = uuidv4()
  const res = await query<{
    id: string
    username: string
    display_name: string | null
    status: string
    created_at: Date
    updated_at: Date
  }>(
    `INSERT INTO users (id, username, password_hash, display_name, status)
     VALUES ($1, $2, $3, $4, 'active')
     RETURNING id, username, display_name, status, created_at, updated_at`,
    [id, username, passwordHash, input.displayName?.trim() || null]
  )
  const row = res.rows[0]
  log.info('User registered', { username })
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function loginUser(input: {
  username: string
  password: string
  deviceId: string
  deviceName?: string
  userAgent?: string
  ip?: string
  hostname?: string
  platform?: string
}): Promise<AuthTokens> {
  const res = await query<{
    id: string
    username: string
    password_hash: string
    display_name: string | null
    status: string
  }>('SELECT id, username, password_hash, display_name, status FROM users WHERE lower(username) = lower($1) LIMIT 1', [
    input.username.trim(),
  ])
  const row = res.rows[0]
  if (!row) throw new Error('Invalid username or password')
  if (row.status !== 'active') throw new Error('User is disabled')

  const ok = await bcrypt.compare(input.password, row.password_hash)
  if (!ok) throw new Error('Invalid username or password')

  const accessToken = generateToken({ userId: row.id, username: row.username })
  const refreshToken = newRefreshToken()
  const refreshHash = hashToken(refreshToken)
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000)

  await query(
    `INSERT INTO sessions (user_id, refresh_token_hash, device_id, device_name, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      row.id,
      refreshHash,
      input.deviceId,
      input.deviceName || null,
      input.userAgent || null,
      input.ip || null,
      expiresAt,
    ]
  )

  await query(
    `INSERT INTO devices (id, user_id, hostname, platform, last_seen_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id, id) DO UPDATE SET
       hostname = COALESCE(EXCLUDED.hostname, devices.hostname),
       platform = COALESCE(EXCLUDED.platform, devices.platform),
       last_seen_at = now()`,
    [input.deviceId, row.id, input.hostname || null, input.platform || null]
  )

  await query(
    `INSERT INTO config_audit_log (user_id, action, device_id, detail)
     VALUES ($1, 'login', $2, $3::jsonb)`,
    [row.id, input.deviceId, JSON.stringify({ hostname: input.hostname, platform: input.platform })]
  )

  return {
    accessToken,
    refreshToken,
    expiresIn: 60 * 60,
    user: { id: row.id, username: row.username, displayName: row.display_name },
  }
}

export async function refreshSession(input: {
  refreshToken: string
  deviceId: string
}): Promise<AuthTokens> {
  const hash = hashToken(input.refreshToken)
  const res = await query<{
    id: string
    user_id: string
    device_id: string
    expires_at: Date
    revoked_at: Date | null
    username: string
    display_name: string | null
    status: string
  }>(
    `SELECT s.id, s.user_id, s.device_id, s.expires_at, s.revoked_at,
            u.username, u.display_name, u.status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.refresh_token_hash = $1
     LIMIT 1`,
    [hash]
  )
  const row = res.rows[0]
  if (!row) throw new Error('Invalid refresh token')
  if (row.revoked_at) throw new Error('Refresh token revoked')
  if (new Date(row.expires_at).getTime() < Date.now()) throw new Error('Refresh token expired')
  if (row.status !== 'active') throw new Error('User is disabled')
  if (row.device_id !== input.deviceId) throw new Error('Device mismatch')

  // rotate refresh token
  await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [row.id])
  const newRefresh = newRefreshToken()
  const newHash = hashToken(newRefresh)
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000)
  await query(
    `INSERT INTO sessions (user_id, refresh_token_hash, device_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [row.user_id, newHash, input.deviceId, expiresAt]
  )
  await query(
    `UPDATE devices SET last_seen_at = now() WHERE user_id = $1 AND id = $2`,
    [row.user_id, input.deviceId]
  )

  const accessToken = generateToken({ userId: row.user_id, username: row.username })
  return {
    accessToken,
    refreshToken: newRefresh,
    expiresIn: 60 * 60,
    user: { id: row.user_id, username: row.username, displayName: row.display_name },
  }
}

export async function logoutSession(refreshToken: string): Promise<void> {
  const hash = hashToken(refreshToken)
  await query('UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL', [
    hash,
  ])
}

export async function listDevices(userId: string) {
  const res = await query<{
    id: string
    hostname: string | null
    platform: string | null
    last_seen_at: Date
    created_at: Date
  }>(
    `SELECT id, hostname, platform, last_seen_at, created_at
     FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC`,
    [userId]
  )
  return res.rows.map((r) => ({
    id: r.id,
    hostname: r.hostname,
    platform: r.platform,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
  }))
}

export async function getUserPublic(userId: string) {
  const res = await query<{
    id: string
    username: string
    display_name: string | null
    status: string
    created_at: Date
  }>('SELECT id, username, display_name, status, created_at FROM users WHERE id = $1', [userId])
  const row = res.rows[0]
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
  }
}
