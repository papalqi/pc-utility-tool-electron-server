import { Router, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { AuthRequest, ApiResponse } from '../types';
import { authenticateToken } from '../middleware/auth';
import { updateUpload } from '../middleware/updateUpload';
import { config } from '../config';
import { logger } from '../utils/logger';
import { updateService } from '../services/updateService';

const log = logger.createScope('UpdateRoutes');
const router = Router();

function isAdmin(req: AuthRequest): boolean {
  return Boolean(req.user?.username && req.user.username === config.admin.username);
}

function requireAdmin(req: AuthRequest, res: Response<ApiResponse>): boolean {
  if (!isAdmin(req)) {
    res.status(403).json({
      success: false,
      error: 'Admin access required',
    });
    return false;
  }
  return true;
}

// All routes require authentication
router.use(authenticateToken);

/**
 * GET /api/updates
 * List update artifacts (admin only)
 */
router.get('/', async (req: AuthRequest, res: Response<ApiResponse>) => {
  try {
    if (!requireAdmin(req, res)) {
      return;
    }

    const updatesDir = config.updates.dir;
    await fs.mkdir(updatesDir, { recursive: true });

    const entries = await fs.readdir(updatesDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const filename = entry.name;
          const filePath = path.join(updatesDir, filename);
          const stat = await fs.stat(filePath);
          return {
            filename,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          };
        })
    );

    res.json({
      success: true,
      data: {
        updatesDir,
        publicBaseUrl: `/updates/`,
        files: files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
      },
    });
  } catch (error) {
    log.error('Failed to list update artifacts', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list update artifacts',
    });
  }
});

/**
 * POST /api/updates/upload
 * Upload update artifacts (admin only)
 *
 * Expected files:
 * - latest.yml (Windows/Linux)
 * - latest-mac.yml (macOS)
 * - installers (*.exe/*.dmg/*.zip/*.AppImage/*.deb) and *.blockmap
 */
router.post(
  '/upload',
  updateUpload.array('files', 50),
  async (req: AuthRequest, res: Response<ApiResponse>) => {
    try {
      if (!requireAdmin(req, res)) {
        return;
      }

      const files = (req.files || []) as Express.Multer.File[];
      if (!files || files.length === 0) {
        res.status(400).json({
          success: false,
          error: 'No files uploaded',
        });
        return;
      }

      log.info(`Update artifacts uploaded by admin ${req.user?.username}`, {
        count: files.length,
        files: files.map((f) => f.originalname),
      });

      res.json({
        success: true,
        data: {
          updatesDir: config.updates.dir,
          publicBaseUrl: `/updates/`,
          uploaded: files.map((file) => ({
            filename: path.basename(file.originalname),
            size: file.size,
          })),
        },
        message: 'Update artifacts uploaded successfully',
      });
    } catch (error) {
      log.error('Failed to upload update artifacts', error);
      res.status(500).json({
        success: false,
        error: 'Failed to upload update artifacts',
      });
    }
  }
);

/**
 * POST /api/updates/sync
 * Pull latest GitHub Release assets into UPDATES_DIR (admin only)
 */
router.post('/sync', async (req: AuthRequest, res: Response<ApiResponse>) => {
  try {
    if (!requireAdmin(req, res)) {
      return;
    }

    // Run sync in background to avoid client/proxy timeouts on large artifacts.
    void updateService
      .syncFromGitHubLatestRelease()
      .then((result) => {
        log.info('Updates sync completed', { tag: result.source.tag, downloaded: result.downloaded.length });
      })
      .catch((error) => {
        log.error('Updates sync failed', error);
      });

    res.status(202).json({
      success: true,
      message: 'Sync started',
    });
  } catch (error) {
    log.error('Failed to sync updates from GitHub', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to sync updates from GitHub',
    });
  }
});

export default router;
