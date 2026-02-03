import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { config } from '../config';
import { logger } from '../utils/logger';

const log = logger.createScope('UpdateService');

interface GitHubReleaseAsset {
  id: number;
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

function parseUpdateYamlUrls(yamlText: string): string[] {
  const urls = new Set<string>();

  for (const rawLine of yamlText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const idx = line.indexOf(':');
    if (idx <= 0) continue;

    const key = line.slice(0, idx).trim();
    if (key !== 'path' && key !== 'url') continue;

    let value = line.slice(idx + 1).trim();
    // strip inline comments
    const hash = value.indexOf('#');
    if (hash >= 0) {
      value = value.slice(0, hash).trim();
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value) {
      urls.add(value);
    }
  }

  return [...urls];
}

function assetPriority(filename: string): number {
  const lower = filename.toLowerCase();

  // Manifests are small and cheap to download.
  if (
    (lower === 'latest.yml' || lower === 'latest-mac.yml' || lower === 'latest-linux.yml') &&
    lower.endsWith('.yml')
  ) {
    return 0;
  }

  // Blockmaps are small and help differential updates.
  if (lower.endsWith('.blockmap')) return 1;

  // Common platforms next.
  if (lower.endsWith('.exe')) return 2;
  if (lower.endsWith('.zip')) return 3;
  if (lower.endsWith('.dmg')) return 4;

  // Linux artifacts.
  if (lower.endsWith('.deb')) return 5;
  if (lower.endsWith('.appimage')) return 6;

  return 10;
}

function isUpdateManifest(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower === 'latest.yml' || lower === 'latest-mac.yml' || lower === 'latest-linux.yml';
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

function buildGitHubAssetDownloadHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'pc-utility-tool-electron-server',
    // Required by GitHub to download release assets via API:
    // https://docs.github.com/rest/releases/assets?apiVersion=2022-11-28#get-a-release-asset
    Accept: 'application/octet-stream',
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

async function moveFileReplace(srcPath: string, destPath: string): Promise<void> {
  await ensureDir(path.dirname(destPath));

  try {
    await fs.rm(destPath, { force: true });
  } catch {
    // ignore
  }

  try {
    await fs.rename(srcPath, destPath);
  } catch (error) {
    // Cross-device rename fallback
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV') {
      await fs.copyFile(srcPath, destPath);
      await fs.rm(srcPath, { force: true });
      return;
    }
    throw error;
  }
}

async function downloadFile(url: string, destPath: string, token?: string): Promise<number> {
  const tempPath = `${destPath}.part`;

  await ensureDir(path.dirname(destPath));
  let existingSize = 0;
  try {
    const stat = await fs.stat(tempPath);
    existingSize = stat.size;
  } catch {
    existingSize = 0;
  }

  const headers = buildGitHubHeaders(token);
  if (existingSize > 0) {
    headers.Range = `bytes=${existingSize}-`;
  }

  let res = await fetch(url, {
    headers,
    redirect: 'follow',
  });

  // If server didn't honor range request, restart the download from scratch.
  if (existingSize > 0 && res.ok && res.status === 200) {
    await fs.rm(tempPath, { force: true });
    existingSize = 0;
    res = await fetch(url, { headers: buildGitHubHeaders(token), redirect: 'follow' });
  }

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  if (!res.body) {
    throw new Error('Download failed: empty response body');
  }

  const nodeStream = Readable.fromWeb(res.body as unknown as ReadableStream);
  const writeStream = fssync.createWriteStream(tempPath, {
    flags: existingSize > 0 && res.status === 206 ? 'a' : 'w',
  });
  await pipeline(nodeStream, writeStream);

  await fs.rm(destPath, { force: true });
  await fs.rename(tempPath, destPath);

  const stat = await fs.stat(destPath);
  return stat.size;
}

async function downloadReleaseAsset(
  owner: string,
  repo: string,
  asset: GitHubReleaseAsset,
  destPath: string,
  token?: string
): Promise<number> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`;
  const tempPath = `${destPath}.part`;

  await ensureDir(path.dirname(destPath));
  let existingSize = 0;
  try {
    const stat = await fs.stat(tempPath);
    existingSize = stat.size;
  } catch {
    existingSize = 0;
  }

  const headers = buildGitHubAssetDownloadHeaders(token);
  if (existingSize > 0) {
    headers.Range = `bytes=${existingSize}-`;
  }

  let res = await fetch(apiUrl, { headers, redirect: 'follow' });

  // If server didn't honor range request, restart the download from scratch.
  if (existingSize > 0 && res.ok && res.status === 200) {
    await fs.rm(tempPath, { force: true });
    existingSize = 0;
    res = await fetch(apiUrl, { headers: buildGitHubAssetDownloadHeaders(token), redirect: 'follow' });
  }

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  if (!res.body) {
    throw new Error('Download failed: empty response body');
  }

  const nodeStream = Readable.fromWeb(res.body as unknown as ReadableStream);
  const writeStream = fssync.createWriteStream(tempPath, {
    flags: existingSize > 0 && res.status === 206 ? 'a' : 'w',
  });
  await pipeline(nodeStream, writeStream);

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
      const target = config.githubUpdates.target;

      if (!owner || !repo) {
        throw new Error('GitHub updates source is not configured (owner/repo missing)');
      }

      await ensureDir(updatesDir);

      log.info('Fetching latest GitHub release for updates', { owner, repo });
      const release = await fetchLatestRelease(owner, repo, token);
      const stagingDir = path.join(updatesDir, '.staging', release.tag_name);
      await ensureDir(stagingDir);

      const downloaded: UpdateSyncResult['downloaded'] = [];
      const skipped: UpdateSyncResult['skipped'] = [];

      const releaseAssets = [...release.assets];

      // If only Windows is needed, only download what latest.yml points to (and its blockmap).
      // This avoids spending hours downloading large mac/linux artifacts on low bandwidth servers.
      if (target === 'windows') {
        const latest = releaseAssets.find((a) => a?.name === 'latest.yml');
        if (!latest) {
          throw new Error('latest.yml is missing in GitHub release assets');
        }

        const latestStagePath = path.join(stagingDir, 'latest.yml');
        // Ensure latest.yml is present for parsing (in staging). Do not publish it yet.
        if (await fileExists(latestStagePath)) {
          try {
            const stat = await fs.stat(latestStagePath);
            if (Number.isFinite(latest.size) && stat.size !== latest.size) {
              await fs.rm(latestStagePath, { force: true });
            }
          } catch {
            // ignore
          }
        }
        if (!(await fileExists(latestStagePath))) {
          log.info('Downloading update manifest (staging)', { filename: 'latest.yml' });
          const actualSize = await downloadReleaseAsset(owner, repo, latest, latestStagePath, token);
          downloaded.push({ filename: 'latest.yml (staging)', size: actualSize });
        }

        const latestContent = await fs.readFile(latestStagePath, 'utf-8');
        const referenced = parseUpdateYamlUrls(latestContent);
        const allowNames = new Set<string>(['latest.yml']);
        for (const ref of referenced) {
          allowNames.add(path.basename(ref));
          // blockmap is optional but recommended
          allowNames.add(`${path.basename(ref)}.blockmap`);
        }

        // Filter in-place
        for (let i = releaseAssets.length - 1; i >= 0; i -= 1) {
          const name = releaseAssets[i]?.name;
          if (!name) {
            releaseAssets.splice(i, 1);
            continue;
          }
          if (!allowNames.has(name)) {
            releaseAssets.splice(i, 1);
          }
        }
      }

      const sortedAssets = releaseAssets.sort((a, b) => {
        const aName = a?.name || '';
        const bName = b?.name || '';
        const pa = assetPriority(aName);
        const pb = assetPriority(bName);
        if (pa !== pb) return pa - pb;
        const sa = Number.isFinite(a?.size) ? a.size : Number.POSITIVE_INFINITY;
        const sb = Number.isFinite(b?.size) ? b.size : Number.POSITIVE_INFINITY;
        return sa - sb;
      });

      const stagedToPromote: Array<{
        filename: string;
        stagedPath: string;
        finalPath: string;
      }> = [];

      for (const asset of sortedAssets) {
        const filename = asset?.name;
        const assetId = asset?.id;
        const downloadUrl = asset?.browser_download_url;
        const expectedSize = asset?.size;

        if (!filename || !downloadUrl || !assetId) {
          continue;
        }

        const baseName = path.basename(filename);
        const finalPath = path.join(updatesDir, baseName);
        const stagedPath = path.join(stagingDir, baseName);

        // Idempotent: skip if file exists with same size
        if (await fileExists(finalPath)) {
          try {
            const stat = await fs.stat(finalPath);
            if (Number.isFinite(expectedSize) && stat.size === expectedSize) {
              skipped.push({ filename, reason: 'already exists (same size)' });
              continue;
            }
          } catch {
            // fallthrough to download
          }
        }

        // If a previous attempt already staged the full file, reuse it.
        if (await fileExists(stagedPath)) {
          try {
            const stat = await fs.stat(stagedPath);
            if (Number.isFinite(expectedSize) && stat.size === expectedSize) {
              stagedToPromote.push({ filename: baseName, stagedPath, finalPath });
              skipped.push({ filename, reason: 'already staged (same size)' });
              continue;
            }
          } catch {
            // fallthrough to download
          }
        }

        log.info('Downloading update asset (staging)', { filename: baseName });
        let actualSize = 0;
        try {
          // Prefer GitHub API asset download for private repos.
          actualSize = await downloadReleaseAsset(owner, repo, asset, stagedPath, token);
        } catch (error) {
          log.warn('GitHub API asset download failed, fallback to browser_download_url', {
            filename: baseName,
            error: error instanceof Error ? error.message : String(error),
          });
          actualSize = await downloadFile(downloadUrl, stagedPath, token);
        }

        stagedToPromote.push({ filename: baseName, stagedPath, finalPath });
        downloaded.push({ filename: baseName, size: actualSize });
      }

      // Publish: promote staged files into public updatesDir, keeping manifests last.
      if (stagedToPromote.length > 0) {
        const manifestFirst: typeof stagedToPromote = [];
        const manifestLast: typeof stagedToPromote = [];

        for (const item of stagedToPromote) {
          if (isUpdateManifest(item.filename)) {
            manifestLast.push(item);
          } else {
            manifestFirst.push(item);
          }
        }

        const ordered = [...manifestFirst, ...manifestLast];
        log.info('Promoting staged update assets', { count: ordered.length, tag: release.tag_name });
        for (const item of ordered) {
          await moveFileReplace(item.stagedPath, item.finalPath);
        }

        // Best-effort cleanup; keep staging if something goes wrong earlier for resume.
        try {
          await fs.rm(stagingDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
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
