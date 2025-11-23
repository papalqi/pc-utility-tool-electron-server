import { Router, Response } from 'express';
import { AuthRequest, ApiResponse } from '../types';
import { authenticateToken } from '../middleware/auth';
import { configService, StorageConfig } from '../services/configService';
import { logger } from '../utils/logger';

const log = logger.createScope('SettingsRoutes');
const router = Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * GET /api/settings/storage
 * Get current storage configuration
 */
router.get('/storage', async (_req: AuthRequest, res: Response<ApiResponse<StorageConfig>>) => {
  try {
    const config = await configService.getStorageConfig();
    
    // Hide sensitive information (only show if partially filled)
    const safeConfig: StorageConfig = {
      ...config,
      qiniuAccessKey: config.qiniuAccessKey ? '***' + config.qiniuAccessKey.slice(-4) : '',
      qiniuSecretKey: config.qiniuSecretKey ? '***' + config.qiniuSecretKey.slice(-4) : '',
    };

    res.json({
      success: true,
      data: safeConfig,
    });
  } catch (error) {
    log.error('Failed to get storage configuration', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get storage configuration',
    });
  }
});

/**
 * PUT /api/settings/storage
 * Update storage configuration
 */
router.put('/storage', async (req: AuthRequest, res: Response<ApiResponse<StorageConfig>>) => {
  try {
    const updateData: Partial<StorageConfig> = req.body;

    // Validate configuration
    const validation = configService.validateStorageConfig(updateData);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.errors.join('; '),
      });
      return;
    }

    // Update configuration
    await configService.updateStorageConfig(updateData);

    // Get updated configuration
    const updatedConfig = await configService.getStorageConfig();
    
    // Hide sensitive information
    const safeConfig: StorageConfig = {
      ...updatedConfig,
      qiniuAccessKey: updatedConfig.qiniuAccessKey ? '***' + updatedConfig.qiniuAccessKey.slice(-4) : '',
      qiniuSecretKey: updatedConfig.qiniuSecretKey ? '***' + updatedConfig.qiniuSecretKey.slice(-4) : '',
    };

    log.info(`Storage configuration updated by user ${req.user?.username}`);

    res.json({
      success: true,
      data: safeConfig,
      message: 'Configuration updated successfully. Please restart the server for changes to take full effect.',
    });
  } catch (error) {
    log.error('Failed to update storage configuration', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update storage configuration',
    });
  }
});

/**
 * POST /api/settings/storage/test
 * Test storage configuration (validates Qiniu credentials if provided)
 */
router.post('/storage/test', async (_req: AuthRequest, res: Response<ApiResponse<{ valid: boolean; message: string }>>) => {
  try {
    const testData: Partial<StorageConfig> = _req.body;

    // Validate configuration
    const validation = configService.validateStorageConfig(testData);
    
    if (!validation.valid) {
      res.json({
        success: true,
        data: {
          valid: false,
          message: validation.errors.join('; '),
        },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        valid: true,
        message: 'Configuration is valid',
      },
    });
  } catch (error) {
    log.error('Failed to test storage configuration', error);
    res.status(500).json({
      success: false,
      error: 'Failed to test storage configuration',
    });
  }
});

/**
 * POST /api/settings/restart
 * Restart the server (requires authentication)
 */
router.post('/restart', async (req: AuthRequest, res: Response<ApiResponse>) => {
  try {
    log.info(`Server restart initiated by user ${req.user?.username}`);
    
    // Send response before restarting
    res.json({
      success: true,
      message: 'Server is restarting. Please wait a moment and refresh the page.',
    });

    // Give the response time to be sent
    setTimeout(() => {
      log.info('Restarting server...');
      process.exit(0); // Exit with code 0 - PM2/systemd will restart automatically
    }, 1000);
  } catch (error) {
    log.error('Failed to restart server', error);
    res.status(500).json({
      success: false,
      error: 'Failed to restart server',
    });
  }
});

export default router;
