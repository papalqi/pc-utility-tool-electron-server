import { Router, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AuthRequest, ApiResponse } from '../types';
import { authenticateToken } from '../middleware/auth';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Server-triggered macOS build on PAPEHUANG-MC2, reusing HAPI as transport.
 *
 * Flow:
 *   POST /api/mac-build {ref} (admin)
 *     1. git fetch + git archive <sha> on the server repo (https, anonymous read OK)
 *     2. stash tarball behind a one-time-ish token (15 min TTL)
 *     3. HAPI hub: spawn codebuddy session on MC2 + send build prompt
 *        (prompt only carries tarball URL + sha; deploy secret stays in
 *         ~/.mac-build-secrets.env on MC2, never in the prompt)
 *   GET  /api/mac-build/source/<sha>.tar.gz?token=...  (MC2 downloads source)
 *   GET  /api/mac-build/status/:sessionId (admin)      (poll agent progress)
 *
 * Env:
 *   HAPI_CLI_API_TOKEN   (required) HAPI hub CLI token -> /api/auth JWT
 *   HAPI_HUB_URL         default http://21.6.69.126:3006
 *   HAPI_MC2_MACHINE_ID  default 9e253395-83d0-40a9-a8c4-2eccad307c58
 *   MAC_BUILD_REPO       default /data/workspace/utility-tool
 *   MAC_BUILD_DIR        default <updates.dir>/../mac-build
 *   MAC_BUILD_URL_BASE   default http://21.6.70.42:<port> (base URL MC2 downloads from)
 */

const log = logger.createScope('MacBuildRoutes');
const router = Router();
const execFileAsync = promisify(execFile);

// NOTE: no router-level auth — /source/* is token-gated by design (MC2 has no JWT);
// admin-only routes take authenticateToken individually.

function isAdmin(req: AuthRequest): boolean {
  return Boolean(req.user?.username && req.user.username === config.admin.username);
}

function requireAdmin(req: AuthRequest, res: Response<ApiResponse>): boolean {
  if (!isAdmin(req)) {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return false;
  }
  return true;
}

const HAPI_HUB_URL = (process.env.HAPI_HUB_URL || 'http://21.6.69.126:3006').replace(/\/$/, '');
const MC2_MACHINE_ID = process.env.HAPI_MC2_MACHINE_ID || '9e253395-83d0-40a9-a8c4-2eccad307c58';
const MAC_BUILD_REPO = process.env.MAC_BUILD_REPO || '/data/workspace/utility-tool';
const MAC_BUILD_DIR = process.env.MAC_BUILD_DIR || path.join(config.updates.dir, '..', 'mac-build');
const MAC_BUILD_URL_BASE = (process.env.MAC_BUILD_URL_BASE || `http://21.6.70.42:${config.port}`).replace(/\/$/, '');

const TOKEN_TTL_MS = 60 * 60 * 1000;
const sourceTokens = new Map<string, { file: string; expires: number }>();

function pruneTokens(): void {
  const now = Date.now();
  for (const [token, entry] of sourceTokens) {
    if (entry.expires < now) sourceTokens.delete(token);
  }
}

async function hapiJwt(): Promise<string> {
  const cliToken = process.env.HAPI_CLI_API_TOKEN;
  if (!cliToken) {
    throw new Error('HAPI_CLI_API_TOKEN is not configured on the server');
  }
  const resp = await fetch(`${HAPI_HUB_URL}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken: cliToken }),
  });
  const body = (await resp.json()) as { token?: string; error?: string };
  if (!resp.ok || !body.token) {
    throw new Error(`HAPI auth failed: ${body.error || resp.status}`);
  }
  return body.token;
}

async function hapiPost<T>(jwt: string, apiPath: string, payload: unknown): Promise<T> {
  const resp = await fetch(`${HAPI_HUB_URL}${apiPath}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await resp.json()) as T & { error?: string; message?: string };
  if (!resp.ok) {
    throw new Error(`HAPI ${apiPath} failed: ${body.error || body.message || resp.status}`);
  }
  return body;
}

function extractTexts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) extractTexts(item, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.type === 'text' && typeof obj.text === 'string') {
      out.push(obj.text);
    }
    for (const key of ['message', 'content', 'data']) {
      const value = obj[key];
      if (value && typeof value === 'object') extractTexts(value, out);
    }
  }
  return out;
}

/**
 * POST /api/mac-build
 * Trigger a macOS build of <ref> on MC2 (admin only).
 */
router.post('/', authenticateToken, async (req: AuthRequest, res: Response<ApiResponse>) => {
  let stage = 'init';
  try {
    if (!requireAdmin(req, res)) return;

    const ref = String(req.body?.ref || 'electrondev');
    log.info(`mac-build triggered by ${req.user?.username}`, { ref });

    stage = 'git';
    // 1) fetch + resolve sha (prefer origin/<ref> — local branch may be stale)
    await execFileAsync('git', ['fetch', 'origin', ref], { cwd: MAC_BUILD_REPO, timeout: 120000 });
    let sha = '';
    try {
      sha = (await execFileAsync('git', ['rev-parse', `origin/${ref}^{commit}`], { cwd: MAC_BUILD_REPO })).stdout.trim();
    } catch {
      sha = (await execFileAsync('git', ['rev-parse', `${ref}^{commit}`], { cwd: MAC_BUILD_REPO })).stdout.trim();
    }

    // 2) archive source
    await fs.promises.mkdir(MAC_BUILD_DIR, { recursive: true });
    const tgzPath = path.join(MAC_BUILD_DIR, `${sha}.tar.gz`);
    if (!fs.existsSync(tgzPath)) {
      await execFileAsync('git', ['archive', '--format=tar.gz', '-o', tgzPath, sha], { cwd: MAC_BUILD_REPO, timeout: 120000 });
    }

    // 3) token for source download
    pruneTokens();
    const token = crypto.randomBytes(24).toString('hex');
    sourceTokens.set(token, { file: tgzPath, expires: Date.now() + TOKEN_TTL_MS });
    const sourceUrl = `${MAC_BUILD_URL_BASE}/api/mac-build/source/${sha}.tar.gz?token=${token}`;

    // 4) spawn HAPI session on MC2
    stage = 'hapi-auth';
    const jwt = await hapiJwt();
    stage = 'hapi-spawn';
    const spawn = await hapiPost<{ type: string; sessionId?: string; message?: string }>(
      jwt,
      `/api/machines/${MC2_MACHINE_ID}/spawn`,
      { directory: '/Users/papalqi', yolo: true, agent: 'codebuddy' }
    );
    if (spawn.type !== 'success' || !spawn.sessionId) {
      throw new Error(`HAPI spawn failed: ${spawn.message || spawn.type}`);
    }
    const sessionId = spawn.sessionId;

    const prompt = [
      '在 MC2 上执行一次 Mac 构建。严格按步骤执行，不要修改源码，不要做其他事。',
      `1. 运行: bash ~/mac-build.sh "${sourceUrl}" "${sha}"`,
      '2. 脚本成功后回复: release/ 产物 ls -lh、latest-mac.yml 全文、以及 [mac-build] DONE 行。',
      '3. 若失败: 回复脚本输出的最后 30 行。',
      '禁止 sudo；禁止碰 /Volumes/P4Storage；禁止打印任何密码/token。',
    ].join('\n');

    stage = 'hapi-message';
    // The hub marks a freshly spawned session active only after the runner-side
    // process reports back; posting immediately can race and get
    // "Session is inactive". Retry briefly.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        await hapiPost(jwt, `/api/sessions/${sessionId}/messages`, { text: prompt });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!/inactive/i.test(msg)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (lastErr) throw lastErr;
    log.info('mac-build session spawned', { sessionId, sha });

    res.json({
      success: true,
      data: { sessionId, sha, ref, sourceTtlSec: TOKEN_TTL_MS / 1000 },
      message: 'macOS build triggered on MC2',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to trigger mac-build', { stage, message });
    res.status(500).json({
      success: false,
      error: `[${stage}] ${message}`,
    });
  }
});

/**
 * GET /api/mac-build/source/:file?token=...
 * Source tarball download for MC2 (token gated, 15 min TTL).
 */
router.get('/source/:file', async (req: AuthRequest, res: Response) => {
  pruneTokens();
  const file = String(req.params.file || '');
  if (!/^[0-9a-f]{40}\.tar\.gz$/.test(file)) {
    res.status(400).json({ success: false, error: 'Bad file' });
    return;
  }
  const token = String(req.query.token || '');
  const entry = sourceTokens.get(token);
  if (!entry || entry.expires < Date.now() || path.basename(entry.file) !== file) {
    res.status(403).json({ success: false, error: 'Invalid or expired token' });
    return;
  }
  res.setHeader('content-type', 'application/gzip');
  fs.createReadStream(entry.file).pipe(res);
});

/**
 * GET /api/mac-build/status/:sessionId
 * Poll build session progress (admin only).
 */
router.get('/status/:sessionId', authenticateToken, async (req: AuthRequest, res: Response<ApiResponse>) => {
  try {
    if (!requireAdmin(req, res)) return;
    const sessionId = String(req.params.sessionId || '');
    const jwt = await hapiJwt();
    const sessionResp = await fetch(`${HAPI_HUB_URL}/api/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const session = (await sessionResp.json()) as Record<string, unknown>;
    const msgsResp = await fetch(`${HAPI_HUB_URL}/api/sessions/${sessionId}/messages?limit=12`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const msgs = (await msgsResp.json()) as { messages?: Array<Record<string, unknown>> };
    const tail: string[] = [];
    for (const m of (msgs.messages || []).slice().reverse()) {
      for (const t of extractTexts(m.content)) {
        tail.push(t.length > 500 ? `${t.slice(0, 500)}…` : t);
      }
    }
    res.json({
      success: true,
      data: {
        active: session?.active ?? null,
        thinking: session?.thinking ?? null,
        tail: tail.slice(-12),
      },
    });
  } catch (error) {
    log.error('Failed to query mac-build status', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to query status',
    });
  }
});

export default router;
