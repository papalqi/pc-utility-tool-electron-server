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
import { fleetInsightService } from '../services/fleetInsightService'
import { normalizeFleetReportBody } from '../services/fleetReportNormalize'
import { logger } from '../utils/logger'

const log = logger.createScope('FleetRoute')
const router = Router()

/**
 * Merge business insight into probe results so *old* clients (no insights IPC)
 * still show meaningful text instead of bare「正常」.
 */
function enrichSnapshotWithInsights(snap: ReturnType<typeof fleetMonitorService.getSnapshot>) {
  const insights = fleetInsightService.getMap()
  const results = (snap.results || []).map((r) => {
    const insight = insights[r.serviceId]
    if (!insight?.ok || !insight.summary) return r
    if (r.status === 'down') return r
    // Keep probe evidence available in checks; surface business summary as card evidence.
    return {
      ...r,
      evidence: insight.summary,
      description: r.description
        ? `${r.description} · ${insight.summary}`
        : insight.summary,
    }
  })
  return { ...snap, results, insights }
}

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const snap = fleetMonitorService.getSnapshot()
    // If never probed yet, run once
    if (!snap.checkedAt) {
      const fresh = await fleetMonitorService.probeAll()
      res.json({
        success: true,
        data: enrichSnapshotWithInsights(fresh),
      })
      return
    }
    res.json({
      success: true,
      data: enrichSnapshotWithInsights(snap),
    })
  } catch (error) {
    log.error('fleet status failed', error)
    res.status(500).json({ success: false, error: 'fleet status failed' })
  }
})

/** Business metrics (tokens, find counts, CCH charts, …). Independent TTL from probes. */
router.get('/insights', async (req: Request, res: Response) => {
  try {
    const refresh = String(req.query.refresh || '') === '1'
    if (refresh) {
      await fleetInsightService.refreshAll()
    }
    const insights = fleetInsightService.getAll()
    res.json({
      success: true,
      data: {
        insights,
        byId: fleetInsightService.getMap(),
        checkedAt: Date.now(),
        hub: {
          host: process.env.FLEET_HUB_HOST || '21.6.70.42',
          role: 'fleet-insights',
        },
      },
    })
  } catch (error) {
    log.error('fleet insights failed', error)
    res.status(500).json({ success: false, error: 'fleet insights failed' })
  }
})

router.get('/insights/:serviceId', async (req: Request, res: Response) => {
  try {
    const serviceId = String(req.params.serviceId || '')
    const refresh = String(req.query.refresh || '') === '1'
    if (refresh) {
      const one = await fleetInsightService.refreshService(serviceId)
      res.json({ success: true, data: one })
      return
    }
    const cached = fleetInsightService.getOne(serviceId)
    if (!cached) {
      res.status(404).json({ success: false, error: `no insight adapter for ${serviceId}` })
      return
    }
    res.json({ success: true, data: cached })
  } catch (error) {
    log.error('fleet insight one failed', error)
    res.status(500).json({ success: false, error: 'fleet insight failed' })
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
