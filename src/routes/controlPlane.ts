/**
 * Control plane API: /api/v1/auth/* and /api/v1/config/*
 * Requires DATABASE_URL. Returns 503 if control plane DB is offline.
 */

import { Router, Response, NextFunction } from 'express'
import { authenticateToken } from '../middleware/auth'
import type { AuthRequest, ApiResponse } from '../types'
import { isControlPlaneDbEnabled, checkDbHealth } from '../db/pool'
import * as auth from '../services/controlPlaneAuth'
import {
  ConfigConflictError,
  MissingBaseRevisionError,
  batchSync,
  getDocument,
  listDocumentMeta,
  putDocument,
} from '../services/configDocumentService'
import { logger } from '../utils/logger'

const log = logger.createScope('ControlPlaneRoutes')
const router = Router()

function requireDb(_req: AuthRequest, res: Response, next: NextFunction): void {
  if (!isControlPlaneDbEnabled()) {
    res.status(503).json({
      success: false,
      error: 'Control plane database not configured (DATABASE_URL)',
    })
    return
  }
  next()
}

router.use(requireDb)

// ── Auth ──────────────────────────────────────────────────────────

router.post('/auth/register', async (req, res: Response<ApiResponse>) => {
  try {
    if (process.env.CONTROL_PLANE_ALLOW_REGISTER === 'false') {
      res.status(403).json({ success: false, error: 'Registration disabled' })
      return
    }
    const { username, password, displayName } = req.body || {}
    const user = await auth.registerUser({ username, password, displayName })
    res.status(201).json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
        },
      },
    })
  } catch (error) {
    log.warn('register failed', error)
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Registration failed',
    })
  }
})

router.post('/auth/login', async (req, res: Response<ApiResponse>) => {
  try {
    const { username, password, deviceId, deviceName, hostname, platform } = req.body || {}
    if (!username || !password || !deviceId) {
      res.status(400).json({
        success: false,
        error: 'username, password, deviceId required',
      })
      return
    }
    const tokens = await auth.loginUser({
      username,
      password,
      deviceId: String(deviceId),
      deviceName: deviceName ? String(deviceName) : undefined,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      hostname: hostname ? String(hostname) : undefined,
      platform: platform ? String(platform) : undefined,
    })
    res.json({ success: true, data: tokens })
  } catch (error) {
    log.warn('login failed', error)
    res.status(401).json({
      success: false,
      error: error instanceof Error ? error.message : 'Login failed',
    })
  }
})

router.post('/auth/refresh', async (req, res: Response<ApiResponse>) => {
  try {
    const { refreshToken, deviceId } = req.body || {}
    if (!refreshToken || !deviceId) {
      res.status(400).json({ success: false, error: 'refreshToken and deviceId required' })
      return
    }
    const tokens = await auth.refreshSession({
      refreshToken: String(refreshToken),
      deviceId: String(deviceId),
    })
    res.json({ success: true, data: tokens })
  } catch (error) {
    res.status(401).json({
      success: false,
      error: error instanceof Error ? error.message : 'Refresh failed',
    })
  }
})

router.post('/auth/logout', async (req, res: Response<ApiResponse>) => {
  try {
    const { refreshToken } = req.body || {}
    if (refreshToken) await auth.logoutSession(String(refreshToken))
    res.json({ success: true, message: 'logged out' })
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Logout failed',
    })
  }
})

router.get('/auth/me', authenticateToken, async (req: AuthRequest, res: Response<ApiResponse>) => {
  try {
    const user = await auth.getUserPublic(req.user!.userId)
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' })
      return
    }
    res.json({ success: true, data: { user } })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed',
    })
  }
})

router.get('/devices', authenticateToken, async (req: AuthRequest, res: Response<ApiResponse>) => {
  try {
    const devices = await auth.listDevices(req.user!.userId)
    res.json({ success: true, data: { devices } })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed',
    })
  }
})

// ── Config documents ──────────────────────────────────────────────

router.get('/config/documents', authenticateToken, async (req: AuthRequest, res: Response<ApiResponse>) => {
  try {
    const profile = String(req.query.profile || 'default')
    const docs = await listDocumentMeta(req.user!.userId, profile)
    res.json({ success: true, data: { documents: docs } })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed',
    })
  }
})

router.get(
  '/config/documents/:docType',
  authenticateToken,
  async (req: AuthRequest, res: Response<ApiResponse>) => {
    try {
      const profile = String(req.query.profile || 'default')
      const doc = await getDocument(req.user!.userId, req.params.docType, profile)
      if (!doc) {
        res.status(404).json({ success: false, error: 'Document not found' })
        return
      }
      res.json({ success: true, data: doc })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed',
      })
    }
  }
)

router.put(
  '/config/documents/:docType',
  authenticateToken,
  async (req: AuthRequest, res: Response<ApiResponse>) => {
    try {
      const body = req.body || {}
      const saved = await putDocument({
        userId: req.user!.userId,
        docType: req.params.docType,
        profile: body.profile || 'default',
        payload: body.payload && typeof body.payload === 'object' ? body.payload : {},
        schemaVersion: body.schemaVersion,
        baseRevision: body.baseRevision,
        deviceId: body.deviceId ? String(body.deviceId) : undefined,
      })
      res.json({ success: true, data: saved })
    } catch (error) {
      if (error instanceof ConfigConflictError) {
        res.status(409).json({
          success: false,
          error: 'conflict',
          data: { current: error.current },
        })
        return
      }
      if (error instanceof MissingBaseRevisionError) {
        res.status(428).json({
          success: false,
          error: 'missing_base_revision',
          data: { current: error.current },
        })
        return
      }
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed',
      })
    }
  }
)

router.post('/config/sync', authenticateToken, async (req: AuthRequest, res: Response<ApiResponse>) => {
  try {
    const body = req.body || {}
    const result = await batchSync({
      userId: req.user!.userId,
      profile: body.profile || 'default',
      deviceId: body.deviceId ? String(body.deviceId) : undefined,
      known: body.known || {},
      push: Array.isArray(body.push) ? body.push : [],
    })
    res.json({ success: true, data: result })
  } catch (error) {
    log.error('batch sync failed', error)
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Sync failed',
    })
  }
})

router.get('/control/health', async (_req, res: Response<ApiResponse>) => {
  const db = await checkDbHealth()
  res.status(db.ok ? 200 : 503).json({
    success: db.ok,
    data: { database: db },
  })
})

export default router
