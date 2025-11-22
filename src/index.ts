import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config, validateConfig } from './config';
import { logger } from './utils/logger';
import { userService } from './services/userService';
import { fileService } from './services/fileService';
import authRoutes from './routes/auth';
import fileRoutes from './routes/files';

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
    app.use(helmet());
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
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

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

    // 404 handler
    app.use((_req, res) => {
      res.status(404).json({
        success: false,
        error: 'Not found',
      });
    });

    // Error handler
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      log.error('Unhandled error', err);
      res.status(500).json({
        success: false,
        error: config.isDevelopment ? err.message : 'Internal server error',
      });
    });

    // Start server
    app.listen(config.port, () => {
      log.info(`Server running on port ${config.port}`);
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
