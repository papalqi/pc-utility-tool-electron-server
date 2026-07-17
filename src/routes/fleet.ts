/**
 * Fleet monitor API — hub aggregation for utility-tool clients.
 *
 * GET  /api/fleet/status   full snapshot (no auth — read-only ops surface)
 * GET  /api/fleet/alerts   recent alerts
 * POST /api/fleet/probe    force re-probe (optional)
 * POST /api/fleet/report   external service push (CCH custom webhook compatible)
 */

import { Router, Request, Response } from 'express'
import { fleetMonitorService } from '../services/fleetMonitorService'
import { normalizeFleetReportBody } from '../services/fleetReportNormalize'
import { logger } from '../utils/logger'

const log = logger.createScope('FleetRoute')
const router = Router()

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const snap = fleetMonitorService.getSnapshot()
    // If never probed yet, run once
    if (!snap.checkedAt) {
      const fresh = await fleetMonitorService.probeAll()
      res.json({ success: true, data: fresh })
      return
    }
    res.json({ success: true, data: snap })
  } catch (error) {
    log.error('fleet status failed', error)
    res.status(500).json({ success: false, error: 'fleet status failed' })
  }
})

router.get('/alerts', (req: Request, res: Response) => {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 30)
    res.json({ success: true, data: fleetMonitorService.getAlerts(limit) })
  } catch (error) {
    log.error('fleet alerts failed', error)
    res.status(500).json({ success: false, error: 'fleet alerts failed' })
  }
})

router.post('/probe', async (_req: Request, res: Response) => {
  try {
    const snap = await fleetMonitorService.probeAll()
    res.json({ success: true, data: snap })
  } catch (error) {
    log.error('fleet probe failed', error)
    res.status(500).json({ success: false, error: 'fleet probe failed' })
  }
})

router.post('/report', (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>
    const normalized = normalizeFleetReportBody(body)

    if (!normalized) {
      log.warn('fleet report rejected: unrecognized payload', {
        keys: Object.keys(body).slice(0, 20),
      })
      res.status(400).json({
        success: false,
        error:
          'unrecognized payload; send {serviceId,status,message} or CCH custom webhook JSON (title/level/provider/...)',
      })
      return
    }

    // Skip pure info leaderboard noise from marking degraded services, but still record
    const alert = fleetMonitorService.reportExternal({
      serviceId: normalized.serviceId,
      serviceName: normalized.serviceName,
      status: normalized.status,
      message: normalized.message,
      severity: normalized.severity,
    })

    log.info('fleet report accepted', {
      serviceId: normalized.serviceId,
      severity: normalized.severity,
      status: normalized.status,
      message: normalized.message.slice(0, 160),
    })

    // CCH custom webhook only requires HTTP 2xx; keep body simple
    res.json({ success: true, data: alert })
  } catch (error) {
    log.error('fleet report failed', error)
    res.status(500).json({ success: false, error: 'fleet report failed' })
  }
})

export default router
