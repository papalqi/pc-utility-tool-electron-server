import { Router, Request, Response } from 'express'
import { authenticateToken } from '../middleware/auth'
import type { AuthRequest } from '../types'
import { config } from '../config'
import { knotJobService } from '../services/knotJobService'
import { logger } from '../utils/logger'

const log = logger.createScope('KnotRoute')
const router = Router()

function dispatchToken(): string {
  return (process.env.KNOT_DISPATCH_TOKEN || config.admin.password || '').trim()
}

function hasDispatchToken(req: Request): boolean {
  const expected = dispatchToken()
  if (!expected) return false
  const header = String(req.headers['x-knot-dispatch-token'] || '')
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

function hostnameOf(req: Request): string {
  return String(req.headers['x-knot-hostname'] || req.body?.hostname || '').trim()
}

router.get('/agents', requireDispatchAuth, (_req: Request, res: Response) => {
  res.json({ success: true, data: knotJobService.listAgents() })
})

router.get('/jobs', requireDispatchAuth, (req: Request, res: Response) => {
  const limit = Number(req.query.limit || 50)
  const target = typeof req.query.target === 'string' ? req.query.target : undefined
  const status = typeof req.query.status === 'string' ? req.query.status : undefined
  const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined
  res.json({
    success: true,
    data: knotJobService.listJobs(limit, {
      target,
      status: status as 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | undefined,
      kind: kind as 'knot' | 'script' | undefined,
    }),
  })
})

router.get('/repos', requireDispatchAuth, (req: Request, res: Response) => {
  const target = typeof req.query.target === 'string' ? req.query.target : undefined
  res.json({ success: true, data: knotJobService.listRepos(target) })
})

router.get('/jobs/:id', requireDispatchAuth, (req: Request, res: Response) => {
  const job = knotJobService.getJob(req.params.id)
  if (!job) {
    res.status(404).json({ success: false, error: 'job not found' })
    return
  }
  res.json({ success: true, data: job })
})

router.post('/jobs', requireDispatchAuth, (req: Request, res: Response) => {
  try {
    const job = knotJobService.createJob(req.body || {})
    res.json({ success: true, data: job })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(400).json({ success: false, error: message })
  }
})

router.post('/heartbeat', requireDispatchAuth, (req: Request, res: Response) => {
  try {
    const body = req.body || {}
    const record = knotJobService.heartbeat({
      hostname: hostnameOf(req) || body.hostname,
      knotFound: Boolean(body.knotFound),
      knotPath: body.knotPath,
      knotVersion: body.knotVersion,
      knotSource: body.knotSource,
      repos: body.repos,
      projects: body.projects,
      skills: body.skills,
      cch: body.cch,
      skillRoots: body.skillRoots,
    })
    res.json({ success: true, data: record })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(400).json({ success: false, error: message })
  }
})

router.post('/jobs/claim', requireDispatchAuth, (req: Request, res: Response) => {
  const hostname = hostnameOf(req)
  if (!hostname) {
    res.status(400).json({ success: false, error: 'hostname required' })
    return
  }
  const job = knotJobService.claimNext(hostname)
  res.json({ success: true, data: job })
})

router.post('/jobs/:id/result', requireDispatchAuth, (req: Request, res: Response) => {
  try {
    const hostname = hostnameOf(req)
    if (!hostname) {
      res.status(400).json({ success: false, error: 'hostname required' })
      return
    }
    const job = knotJobService.finishJob(req.params.id, hostname, req.body || {})
    res.json({ success: true, data: job })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('finish job failed', { message })
    res.status(400).json({ success: false, error: message })
  }
})

export default router
