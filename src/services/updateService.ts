import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { config } from '../config';
import { logger } from '../utils/logger';

const log = logger.createScope('UpdateService');

interface GitHubReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GitHubRelease {
  id: number;
  tag_name: string;
  name?: string;
  published_at?: string;
  assets: GitHubReleaseAsset[];
}

export interface UpdateSyncResult {
  source: {
    provider: 'github';
    owner: string;
    repo: string;
    tag: string;
    publishedAt?: string;
  };
  updatesDir: string;
  downloaded: Array<{ filename: string; size: number }>;
  skipped: Array<{ filename: string; reason: string }>;
}

function buildGitHubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'pc-utility-tool-electron-server',
    Accept: 'application/vnd.github+json',
  };

  const trimmed = token?.trim();
  if (trimmed) {
    headers.Authorization = `Bearer ${trimmed}`;
  }

  return headers;
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, destPath: string, token?: string): Promise<number> {
  const tempPath = `${destPath}.part`;

  await ensureDir(path.dirname(destPath));
  await fs.rm(tempPath, { force: true });

  const res = await fetch(url, {
    headers: buildGitHubHeaders(token),
  });

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  if (!res.body) {
    throw new Error('Download failed: empty response body');
  }

  const nodeStream = Readable.fromWeb(res.body as unknown as ReadableStream);
  await pipeline(nodeStream, fssync.createWriteStream(tempPath));

  await fs.rm(destPath, { force: true });
  await fs.rename(tempPath, destPath);

  const stat = await fs.stat(destPath);
  return stat.size;
}

async function fetchLatestRelease(owner: string, repo: string, token?: string): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const res = await fetch(url, { headers: buildGitHubHeaders(token) });
  if (!res.ok) {
    let details = '';
    try {
      const text = await res.text();
      if (text) {
        details = ` (${text.slice(0, 200)})`;
      }
    } catch {
      // ignore
    }

    const hint =
      res.status === 404 && !token
        ? ' (hint: repo may be private; set GITHUB_UPDATES_TOKEN)'
        : res.status === 401
          ? ' (hint: bad credentials; check GITHUB_UPDATES_TOKEN)'
          : res.status === 403
            ? ' (hint: forbidden; check token permissions or rate limit)'
            : '';

    throw new Error(`Failed to fetch latest release: ${res.status} ${res.statusText}${hint}${details}`);
  }
  const json = (await res.json()) as Partial<GitHubRelease>;

  if (!json || typeof json !== 'object') {
    throw new Error('Invalid GitHub response');
  }
  if (!Array.isArray(json.assets)) {
    throw new Error('Invalid GitHub response: assets missing');
  }
  if (typeof json.tag_name !== 'string' || !json.tag_name) {
    throw new Error('Invalid GitHub response: tag_name missing');
  }

  return json as GitHubRelease;
}

class UpdateService {
  private syncPromise: Promise<UpdateSyncResult> | null = null;

  async syncFromGitHubLatestRelease(): Promise<UpdateSyncResult> {
    if (this.syncPromise) {
      log.warn('Sync already in progress, reusing promise');
      return this.syncPromise;
    }

    this.syncPromise = (async () => {
      const owner = config.githubUpdates.owner;
      const repo = config.githubUpdates.repo;
      const token = config.githubUpdates.token || undefined;
      const updatesDir = config.updates.dir;

      if (!owner || !repo) {
        throw new Error('GitHub updates source is not configured (owner/repo missing)');
      }

      await ensureDir(updatesDir);

      log.info('Fetching latest GitHub release for updates', { owner, repo });
      const release = await fetchLatestRelease(owner, repo, token);

      const downloaded: UpdateSyncResult['downloaded'] = [];
      const skipped: UpdateSyncResult['skipped'] = [];

      for (const asset of release.assets) {
        const filename = asset?.name;
        const downloadUrl = asset?.browser_download_url;
        const expectedSize = asset?.size;

        if (!filename || !downloadUrl) {
          continue;
        }

        const destPath = path.join(updatesDir, path.basename(filename));

        // Idempotent: skip if file exists with same size
        if (await fileExists(destPath)) {
          try {
            const stat = await fs.stat(destPath);
            if (Number.isFinite(expectedSize) && stat.size === expectedSize) {
              skipped.push({ filename, reason: 'already exists (same size)' });
              continue;
            }
          } catch {
            // fallthrough to download
          }
        }

        log.info('Downloading update asset', { filename });
        const actualSize = await downloadFile(downloadUrl, destPath, token);
        downloaded.push({ filename: path.basename(filename), size: actualSize });
      }

      log.info('GitHub release sync completed', {
        owner,
        repo,
        tag: release.tag_name,
        downloaded: downloaded.length,
        skipped: skipped.length,
      });

      return {
        source: {
          provider: 'github',
          owner,
          repo,
          tag: release.tag_name,
          publishedAt: release.published_at,
        },
        updatesDir,
        downloaded,
        skipped,
      };
    })();

    try {
      return await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }
}

export const updateService = new UpdateService();
