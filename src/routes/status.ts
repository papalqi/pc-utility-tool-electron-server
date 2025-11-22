import { Router, Response, Request } from 'express';
import { statusService } from '../services/statusService';
import { ApiResponse } from '../types';
import { logger } from '../utils/logger';
import path from 'path';

const log = logger.createScope('StatusRoute');
const router = Router();

/**
 * GET /api/status
 * Get comprehensive server status (requires authentication in production)
 */
router.get('/api/status', async (_req: Request, res: Response<ApiResponse<unknown>>) => {
  try {
    const status = await statusService.getStatus();
    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    log.error('Failed to get status', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get server status',
    });
  }
});

/**
 * GET /status
 * Serve status monitoring web page
 */
router.get('/status', (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'public', 'status.html'));
});

export default router;
