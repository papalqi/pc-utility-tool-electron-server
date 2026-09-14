import { Router, Request, Response } from 'express'
import { authenticateToken } from '../middleware/auth'
import type { AuthRequest } from '../types'
import { config } from '../config'
import { fleetScheduleService } from '../services/fleetScheduleService'
import { logger } from '../utils/logger'
import type { FleetScheduleInput } from '../lib/fleetSchedules'

const log = logger.createScope('FleetScheduleRoute')
const router = Router()

function dispatchToken(): string {
  return (process.env.KNOT_DISPATCH_TOKEN || config.admin.password || '').trim()
}

function hasDispatchToken(req: Request): boolean {
  const expected = dispatchToken()
  if (!expected) return false
  const header = String(req.headers['x-knot-dispatch-token'] || req.headers['x-mcp-token'] || '')
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  return header === expected || bearer === expected
}

function requireDispatchAuth(req: AuthRequest, res: Response, next: () => void): void {
  if (hasDispatchToken(req)) {
    next()
    return
  }
  authenticateToken(req, res, next)
}

router.get('/', requireDispatchAuth, (_req: Request, res: Response) => {
  res.json({ success: true, data: fleetScheduleService.snapshot() })
})

router.get('/runs/:id', requireDispatchAuth, (req: Request, res: Response) => {
  const run = fleetScheduleService.getRun(req.params.id)
  if (!run) {
    res.status(404).json({ success: false, error: 'run not found' })
    return
  }
  res.json({ success: true, data: run })
})

router.get('/:id', requireDispatchAuth, (req: Request, res: Response) => {
  const schedule = fleetScheduleService.getSchedule(req.params.id)
  if (!schedule) {
    res.status(404).json({ success: false, error: 'schedule not found' })
    return
  }
  res.json({
    success: true,
    data: {
      schedule,
      runs: fleetScheduleService.listRuns(20, schedule.id),
    },
  })
})

router.post('/', requireDispatchAuth, (req: Request, res: Response) => {
  try {
    const schedule = fleetScheduleService.saveSchedule((req.body || {}) as FleetScheduleInput)
    res.json({ success: true, data: schedule })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('save schedule failed', { error: message })
    res.status(400).json({ success: false, error: message })
  }
})

router.put('/:id', requireDispatchAuth, (req: Request, res: Response) => {
  try {
    const schedule = fleetScheduleService.saveSchedule({ ...(req.body || {}), id: req.params.id } as FleetScheduleInput)
    res.json({ success: true, data: schedule })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(400).json({ success: false, error: message })
  }
})

router.patch('/:id/enabled', requireDispatchAuth, (req: Request, res: Response) => {
  try {
    const enabled = Boolean(req.body?.enabled)
    const schedule = fleetScheduleService.setEnabled(req.params.id, enabled)
    res.json({ success: true, data: schedule })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(400).json({ success: false, error: message })
  }
})

router.delete('/:id', requireDispatchAuth, (req: Request, res: Response) => {
  const ok = fleetScheduleService.deleteSchedule(req.params.id)
  if (!ok) {
    res.status(404).json({ success: false, error: 'schedule not found' })
    return
  }
  res.json({ success: true, data: { id: req.params.id } })
})

router.post('/:id/run', requireDispatchAuth, (req: Request, res: Response) => {
  try {
    const run = fleetScheduleService.runNow(req.params.id)
    res.json({ success: true, data: run })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(400).json({ success: false, error: message })
  }
})

export default router
