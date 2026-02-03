import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { updateService } from '../services/updateService';

const log = logger.createScope('GitHubWebhook');
const router = Router();

function getHeader(req: Request, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] || '';
  return '';
}

function verifySignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  const secretTrimmed = secret.trim();
  if (!secretTrimmed) {
    return false;
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const provided = signatureHeader.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', secretTrimmed).update(rawBody).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * POST /api/webhooks/github
 *
 * GitHub webhook handler (expects raw body middleware).
 * - Verifies X-Hub-Signature-256 with GITHUB_WEBHOOK_SECRET
 * - On release published/released, triggers update sync from GitHub Releases
 */
router.post('/github', async (req: Request, res: Response) => {
  try {
    const secret = config.githubWebhook.secret;
    if (!secret.trim()) {
      res.status(500).json({
        success: false,
        error: 'Webhook secret not configured',
      });
      return;
    }

    const delivery = getHeader(req, 'x-github-delivery');
    const event = getHeader(req, 'x-github-event');
    const signature = getHeader(req, 'x-hub-signature-256');

    const rawBody = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.from('');
    if (!verifySignature(rawBody, signature, secret)) {
      log.warn('Webhook signature verification failed', { delivery, event });
      res.status(401).json({
        success: false,
        error: 'Invalid signature',
      });
      return;
    }

    if (event === 'ping') {
      res.json({ success: true, message: 'pong' });
      return;
    }

    if (event !== 'release') {
      res.json({ success: true, message: `ignored event: ${event}` });
      return;
    }

    const payloadText = rawBody.toString('utf-8');
    const payload = JSON.parse(payloadText) as {
      action?: string;
      repository?: { name?: string; owner?: { login?: string } };
      release?: { tag_name?: string };
    };

    const action = payload.action || '';
    const repoName = payload.repository?.name || '';
    const repoOwner = payload.repository?.owner?.login || '';
    const tagName = payload.release?.tag_name || '';

    if (repoOwner && repoName) {
      const expectedOwner = config.githubUpdates.owner;
      const expectedRepo = config.githubUpdates.repo;
      if (repoOwner !== expectedOwner || repoName !== expectedRepo) {
        log.warn('Webhook repository mismatch, ignored', {
          delivery,
          event,
          repoOwner,
          repoName,
          expectedOwner,
          expectedRepo,
        });
        res.json({ success: true, message: 'ignored: repository mismatch' });
        return;
      }
    }

    const shouldSync = action === 'published' || action === 'released';
    if (!shouldSync) {
      res.json({ success: true, message: `ignored action: ${action}` });
      return;
    }

    log.info('Release webhook received, triggering sync', { delivery, action, tagName });

    // Respond quickly to GitHub; sync continues in background.
    res.status(202).json({ success: true, message: 'sync started' });

    updateService
      .syncFromGitHubLatestRelease()
      .then((result) => {
        log.info('Webhook sync completed', {
          tag: result.source.tag,
          downloaded: result.downloaded.length,
          skipped: result.skipped.length,
        });
      })
      .catch((error) => {
        log.error('Webhook sync failed', error);
      });
  } catch (error) {
    log.error('Webhook handler failed', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Webhook handler failed',
    });
  }
});

export default router;

