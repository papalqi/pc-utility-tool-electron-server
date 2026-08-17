import { Router, Request, Response } from 'express'
import { authenticateToken } from '../middleware/auth'
import type { AuthRequest } from '../types'
import { config } from '../config'
import { cchProfileService } from '../services/cchProfileService'

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

router.get('/profile', requireDispatchAuth, (req: Request, res: Response) => {
  const includeKey = String(req.query.includeKey || '') === '1'
  res.json({ success: true, data: includeKey ? cchProfileService.getForApply() : cchProfileService.get(false) })
})

router.post('/profile', requireDispatchAuth, (req: Request, res: Response) => {
  const saved = cchProfileService.save(req.body || {})
  res.json({ success: true, data: saved })
})

export default router
