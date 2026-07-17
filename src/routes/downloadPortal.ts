/**
 * Password-gated download portal for humans.
 * Auto-update feed (/updates/*) stays public for electron-updater.
 */
import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

const log = logger.createScope('DownloadPortal');
const router = Router();

const COOKIE_NAME = 'util_dl_auth';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function expectedToken(): string {
  const secret = config.jwt.secret || 'download-portal';
  return crypto
    .createHmac('sha256', secret)
    .update(`download-portal:${config.downloadSite.password}`)
    .digest('hex');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isAuthed(req: Request): boolean {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  const expected = expectedToken();
  try {
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function setAuthCookie(res: Response): void {
  const token = expectedToken();
  // Internal DevCloud serves plain HTTP; only set Secure when explicitly requested
  // (or behind HTTPS reverse proxy with DOWNLOAD_COOKIE_SECURE=true).
  const secure =
    process.env.DOWNLOAD_COOKIE_SECURE === 'true' || process.env.DOWNLOAD_COOKIE_SECURE === '1'
      ? '; Secure'
      : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
      COOKIE_MAX_AGE_MS / 1000
    )}${secure}`
  );
}

function clearAuthCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Human portal: only full release installers (大版本), not hot/yml/blockmap. */
function isFullReleaseInstaller(name: string, relPath: string): boolean {
  const n = name.toLowerCase();
  const rel = relPath.replace(/\\/g, '/').toLowerCase();
  // skip hot channel entirely
  if (rel.startsWith('hot/') || rel.includes('/hot/')) return false;
  if (n.includes('.hot.') || n.startsWith('pc.utility.tool.hot.')) return false;
  // skip manifests / maps / junk
  if (n.endsWith('.yml') || n.endsWith('.yaml') || n.endsWith('.json')) return false;
  if (n.endsWith('.blockmap')) return false;
  if (n.includes('builder-debug') || n.includes('builder-effective')) return false;
  // NSIS Setup or portable exe only
  // Setup: PC.Utility.Tool.Setup.1.0.7.exe
  // Portable: PC.Utility.Tool.1.0.7.exe (not Hot)
  if (!n.endsWith('.exe')) return false;
  if (/^pc\.utility\.tool\.setup\.\d+\.\d+\.\d+\.exe$/.test(n)) return true;
  if (/^pc\.utility\.tool\.\d+\.\d+\.\d+\.exe$/.test(n)) return true;
  return false;
}

function versionFromInstallerName(name: string): string | null {
  const m = name.match(/(\d+\.\d+\.\d+)\.exe$/i);
  return m ? m[1] : null;
}

function compareSemverDesc(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function listUpdateFiles(
  dir: string,
  base = ''
): Promise<Array<{ name: string; relPath: string; size: number; modifiedAt: string; version?: string; kind?: string }>> {
  const results: Array<{ name: string; relPath: string; size: number; modifiedAt: string; version?: string; kind?: string }> = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // still walk top-level only for non-hot; skip hot/ dir entirely
      if (entry.name.toLowerCase() === 'hot') continue;
      results.push(...(await listUpdateFiles(full, rel)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isFullReleaseInstaller(entry.name, rel)) continue;
    const st = await fs.stat(full);
    const version = versionFromInstallerName(entry.name) || undefined;
    const kind = /setup/i.test(entry.name) ? 'setup' : 'portable';
    results.push({
      name: entry.name,
      relPath: rel.replace(/\\/g, '/'),
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
      version,
      kind,
    });
  }
  return results.sort((a, b) => {
    const va = a.version || '0.0.0';
    const vb = b.version || '0.0.0';
    const byVer = compareSemverDesc(va, vb);
    if (byVer !== 0) return byVer;
    // same version: Setup first, then portable
    if (a.kind !== b.kind) return a.kind === 'setup' ? -1 : 1;
    return b.modifiedAt.localeCompare(a.modifiedAt);
  });
}

function requirePortalAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthed(req)) {
    next();
    return;
  }
  if (req.path.startsWith('/api/') || req.xhr || req.headers.accept?.includes('application/json')) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  res.redirect('/download/login');
}

/** Login page (static HTML is preferred; this is fallback) */
router.get('/login', (req, res) => {
  if (isAuthed(req)) {
    res.redirect('/download');
    return;
  }
  res.sendFile(path.join(process.cwd(), 'public', 'download-login.html'));
});

router.post('/login', (req: Request, res: Response) => {
  if (!config.downloadSite.password) {
    res.status(503).json({ success: false, error: 'DOWNLOAD_SITE_PASSWORD 未配置' });
    return;
  }
  const password = String(
    (req.body && (req.body.password || req.body.pass || req.body.pwd)) || ''
  ).trim();
  if (!password || password !== config.downloadSite.password) {
    log.warn('Download portal login failed');
    if (req.headers.accept?.includes('application/json') || req.is('application/json')) {
      res.status(401).json({ success: false, error: '密码错误' });
      return;
    }
    res.status(401).type('html').send(loginFailHtml());
    return;
  }
  setAuthCookie(res);
  log.info('Download portal login ok');
  if (req.headers.accept?.includes('application/json') || req.is('application/json')) {
    res.json({ success: true, redirect: '/download' });
    return;
  }
  res.redirect('/download');
});

router.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.redirect('/download/login');
});

router.get('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.redirect('/download/login');
});

router.get('/api/files', requirePortalAuth, async (_req, res) => {
  try {
    const files = await listUpdateFiles(config.updates.dir);
    res.json({
      success: true,
      data: {
        count: files.length,
        files: files.map((f) => ({
          ...f,
          downloadUrl: `/download/file/${encodeURIComponent(f.relPath).replace(/%2F/g, '/')}`,
          publicUrl: `/updates/${f.relPath}`,
        })),
      },
    });
  } catch (error) {
    log.error('Failed to list download files', error);
    res.status(500).json({ success: false, error: 'Failed to list files' });
  }
});

/** Cookie-gated file download (path under updates dir) */
router.get('/file/*', requirePortalAuth, async (req, res) => {
  try {
    // Express matches /file/*; remainder after /file/
    const rawUrl = req.url || '';
    const marker = '/file/';
    const idx = rawUrl.indexOf(marker);
    let rel = idx >= 0 ? rawUrl.slice(idx + marker.length) : '';
    // strip query
    rel = rel.split('?')[0];
    try {
      rel = decodeURIComponent(rel);
    } catch {
      /* keep raw */
    }
    rel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) {
      res.status(400).json({ success: false, error: 'Invalid path' });
      return;
    }
    const updatesRoot = path.resolve(config.updates.dir);
    const filePath = path.resolve(updatesRoot, rel);
    if (!filePath.startsWith(updatesRoot + path.sep) && filePath !== updatesRoot) {
      res.status(400).json({ success: false, error: 'Invalid path' });
      return;
    }
    await fs.access(filePath);
    res.download(filePath, path.basename(filePath));
  } catch {
    res.status(404).json({ success: false, error: 'File not found' });
  }
});

/** Main portal page */
router.get('/', (req, res) => {
  if (!isAuthed(req)) {
    res.redirect('/download/login');
    return;
  }
  res.sendFile(path.join(process.cwd(), 'public', 'download.html'));
});

function loginFailHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>密码错误</title>
<style>body{font-family:system-ui;background:#0f1115;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center}
a{color:#6ea8fe}</style></head>
<body><div><p>密码错误</p><p><a href="/download/login">返回登录</a></p></div></body></html>`;
}

export default router;
