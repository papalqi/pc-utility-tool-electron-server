import { Router, Response } from 'express';
import { AuthRequest, ApiResponse, FileMetadata } from '../types';
import { authenticateToken } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { fileService } from '../services/fileService';
import { logger } from '../utils/logger';
import fs from 'fs';
import https from 'https';
import http from 'http';

const log = logger.createScope('FileRoutes');
const router = Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * POST /api/files/upload
 * Upload a file
 */
router.post(
  '/upload',
  upload.single('file'),
  async (req: AuthRequest, res: Response<ApiResponse<FileMetadata>>) => {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: 'No file uploaded',
        });
        return;
      }

      const userId = req.user!.userId;
      const metadata = await fileService.saveFile(
        userId,
        req.file.originalname,
        req.file.filename,
        req.file.size,
        req.file.mimetype
      );

      res.status(201).json({
        success: true,
        data: metadata,
      });
    } catch (error) {
      log.error('File upload failed', error);
      res.status(500).json({
        success: false,
        error: 'Failed to upload file',
      });
    }
  }
);

/**
 * POST /api/files/upload-multiple
 * Upload multiple files
 */
router.post(
  '/upload-multiple',
  upload.array('files', 10), // Max 10 files
  async (req: AuthRequest, res: Response<ApiResponse<FileMetadata[]>>) => {
    try {
      if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
        res.status(400).json({
          success: false,
          error: 'No files uploaded',
        });
        return;
      }

      const userId = req.user!.userId;
      const metadataList: FileMetadata[] = [];

      for (const file of req.files) {
        const metadata = await fileService.saveFile(
          userId,
          file.originalname,
          file.filename,
          file.size,
          file.mimetype
        );
        metadataList.push(metadata);
      }

      res.status(201).json({
        success: true,
        data: metadataList,
      });
    } catch (error) {
      log.error('Multiple file upload failed', error);
      res.status(500).json({
        success: false,
        error: 'Failed to upload files',
      });
    }
  }
);

/**
 * GET /api/files
 * List all files for current user
 */
router.get('/', async (req: AuthRequest, res: Response<ApiResponse<FileMetadata[]>>) => {
  try {
    const userId = req.user!.userId;
    const files = await fileService.getFilesByUser(userId);

    res.json({
      success: true,
      data: files,
    });
  } catch (error) {
    log.error('Failed to list files', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list files',
    });
  }
});

/**
 * GET /api/files/:fileId
 * Download a file (with Qiniu proxy support)
 */
router.get('/:fileId', async (req: AuthRequest, res: Response) => {
  try {
    const { fileId } = req.params;
    const userId = req.user!.userId;

    const metadata = await fileService.getFileById(fileId);

    if (!metadata) {
      res.status(404).json({
        success: false,
        error: 'File not found',
      });
      return;
    }

    // Verify file belongs to user
    if (metadata.userId !== userId) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    const filePath = fileService.getFilePath(metadata);

    // 优先尝试本地文件
    if (fs.existsSync(filePath)) {
      log.debug(`Serving file from local: ${metadata.originalName}`);
      res.download(filePath, metadata.originalName);
      return;
    }

    // 如果本地不存在但有七牛云URL，从七牛云代理下载
    if (metadata.cloudUrl) {
      log.info(`Proxying file from Qiniu: ${metadata.originalName}`);
      // 获取七牛云直接访问URL
      const qiniuUrl = fileService.getQiniuDirectUrl(metadata.cloudUrl);
      if (!qiniuUrl) {
        res.status(500).json({
          success: false,
          error: 'Unable to access file from cloud storage',
        });
        return;
      }
      await proxyFileFromQiniu(qiniuUrl, metadata.originalName, res);
      return;
    }

    // 文件既不在本地也不在云端
    res.status(404).json({
      success: false,
      error: 'File not found in local or cloud storage',
    });
  } catch (error) {
    log.error('File download failed', error);
    res.status(500).json({
      success: false,
      error: 'Failed to download file',
    });
  }
});

/**
 * 从七牛云代理下载文件
 */
async function proxyFileFromQiniu(
  cloudUrl: string,
  originalName: string,
  res: Response
): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = cloudUrl.startsWith('https') ? https : http;

    const request = protocol.get(cloudUrl, (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        log.error(`Qiniu proxy failed with status ${proxyRes.statusCode}`);
        res.status(502).json({
          success: false,
          error: 'Failed to fetch file from cloud storage',
        });
        reject(new Error(`HTTP ${proxyRes.statusCode}`));
        return;
      }

      // 设置响应头
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
      if (proxyRes.headers['content-length']) {
        res.setHeader('Content-Length', proxyRes.headers['content-length']);
      }

      // 流式传输文件
      proxyRes.pipe(res);

      proxyRes.on('end', () => {
        log.debug(`File proxied successfully: ${originalName}`);
        resolve();
      });

      proxyRes.on('error', (error) => {
        log.error('Proxy stream error', error);
        reject(error);
      });
    });

    request.on('error', (error) => {
      log.error('Qiniu proxy request failed', error);
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          error: 'Failed to connect to cloud storage',
        });
      }
      reject(error);
    });

    request.setTimeout(30000, () => {
      request.destroy();
      if (!res.headersSent) {
        res.status(504).json({
          success: false,
          error: 'Cloud storage request timeout',
        });
      }
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * DELETE /api/files/:fileId
 * Delete a file
 */
router.delete('/:fileId', async (req: AuthRequest, res: Response<ApiResponse>) => {
  try {
    const { fileId } = req.params;
    const userId = req.user!.userId;

    const metadata = await fileService.getFileById(fileId);

    if (!metadata) {
      res.status(404).json({
        success: false,
        error: 'File not found',
      });
      return;
    }

    // Verify file belongs to user
    if (metadata.userId !== userId) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    await fileService.deleteFile(fileId);

    res.json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error) {
    log.error('File deletion failed', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete file',
    });
  }
});

/**
 * GET /api/files/storage/usage
 * Get storage usage for current user
 */
router.get('/storage/usage', async (req: AuthRequest, res: Response<ApiResponse<{ used: number; files: number }>>) => {
  try {
    const userId = req.user!.userId;
    const files = await fileService.getFilesByUser(userId);
    const used = await fileService.getUserStorageSize(userId);

    res.json({
      success: true,
      data: {
        used,
        files: files.length,
      },
    });
  } catch (error) {
    log.error('Failed to get storage usage', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get storage usage',
    });
  }
});

export default router;
