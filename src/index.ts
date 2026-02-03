import express from 'express';
import cors from 'cors';
// import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs/promises';
import { config, validateConfig } from './config';
import { logger } from './utils/logger';
import { userService } from './services/userService';
import { fileService } from './services/fileService';
import authRoutes from './routes/auth';
import fileRoutes from './routes/files';
import statusRoutes from './routes/status';
import settingsRoutes from './routes/settings';
import updatesRoutes from './routes/updates';
import webhooksRoutes from './routes/webhooks';

const log = logger.createScope('Server');

/**
 * Initialize server
 */
async function initializeServer() {
  try {
    // Validate configuration
    validateConfig();
    log.info('Configuration validated');

    // Initialize services
    await userService.initialize();
    await fileService.initialize();
    await fs.mkdir(config.updates.dir, { recursive: true });
    log.info(`Updates directory ensured: ${config.updates.dir}`);

    // Create admin user if not exists
    const adminExists = await userService.findByUsername(config.admin.username);
    if (!adminExists) {
      await userService.createUser({
        username: config.admin.username,
        password: config.admin.password,
      });
      log.info(`Admin user created: ${config.admin.username}`);
      if (config.isDevelopment) {
        log.warn(`Default admin password is in use. Please change it!`);
      }
    }

    // Create Express app
    const app = express();

    // Security middleware
    // Temporarily disable helmet for debugging
    // app.use(helmet({
    //   contentSecurityPolicy: false,
    // }));
    app.use(cors({
      origin: config.cors.origin,
      credentials: true,
    }));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.maxRequests,
      message: {
        success: false,
        error: 'Too many requests, please try again later',
      },
    });
    app.use('/api/', limiter);

    // Body parsing and compression
    app.use(compression());

    // Webhooks need raw body for signature verification
    app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhooksRoutes);

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Static files for status page
    app.use(express.static(path.join(process.cwd(), 'public')));
    // Static files for electron-updater (generic provider)
    app.use(
      '/updates',
      express.static(config.updates.dir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );

    // Health check endpoint
    app.get('/health', (_req, res) => {
      res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString(),
      });
    });

    // API routes
    app.use('/api/auth', authRoutes);
    app.use('/api/files', fileRoutes);
    app.use('/api/settings', settingsRoutes);
    app.use('/api/updates', updatesRoutes);
    
    // Status monitoring routes
    app.use(statusRoutes);

    // 404 handler
    app.use((_req, res) => {
      res.status(404).json({
        success: false,
        error: 'Not found',
      });
    });

    // Error handler
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      log.error('Unhandled error', err);
      res.status(500).json({
        success: false,
        error: config.isDevelopment ? err.message : 'Internal server error',
      });
    });

    // Start server
    app.listen(config.port, config.bindHost, () => {
      log.info(`Server running on port ${config.port}`);
      log.info(`Listening on ${config.bindHost}:${config.port}`);
      log.info(`Environment: ${config.nodeEnv}`);
      log.info(`Upload directory: ${config.upload.dir}`);
      log.info(`Max file size: ${config.upload.maxFileSize} bytes`);
      log.info('Server initialized successfully');
    });
  } catch (error) {
    log.error('Failed to initialize server', error);
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error);
  process.exit(1);
});

// Initialize
initializeServer();
