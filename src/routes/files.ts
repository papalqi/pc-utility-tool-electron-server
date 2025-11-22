import { Router, Response } from 'express';
import { AuthRequest, ApiResponse, FileMetadata } from '../types';
import { authenticateToken } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { fileService } from '../services/fileService';
import { logger } from '../utils/logger';

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
 * Download a file
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

    // Send file
    const filePath = fileService.getFilePath(metadata);
    res.download(filePath, metadata.originalName);
  } catch (error) {
    log.error('File download failed', error);
    res.status(500).json({
      success: false,
      error: 'Failed to download file',
    });
  }
});

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
