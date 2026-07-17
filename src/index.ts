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
import fleetRoutes from './routes/fleet';
import downloadPortalRoutes from './routes/downloadPortal';
import controlPlaneRoutes from './routes/controlPlane';
import { fleetMonitorService } from './services/fleetMonitorService';
import { checkDbHealth, isControlPlaneDbEnabled } from './db/pool';

const log = logger.createScope('Server');

function parseTrustProxySetting(raw: string | undefined): boolean | number | string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return asNumber;

  return trimmed;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

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
    } else {
      const matches = await userService.verifyPassword(adminExists, config.admin.password);
      if (!matches) {
        await userService.updatePassword(adminExists.id, config.admin.password);
        log.warn(`Admin password updated from environment: ${config.admin.username}`);
      }
    }

    // Create Express app
    const app = express();

    // Trust reverse proxy headers when configured / inferred.
    // This avoids express-rate-limit throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR behind Caddy/Nginx.
    const trustProxy =
      parseTrustProxySetting(config.trustProxy) ??
      (config.nodeEnv === 'production' && isLoopbackHost(config.bindHost) ? 1 : false);
    app.set('trust proxy', trustProxy);
    log.info('Express trust proxy configured', { trustProxy });

    // Security middleware
    // Temporarily disable helmet for debugging
    // app.use(helmet({
    //   contentSecurityPolicy: false,
    // }));
    app.use(cors({
      origin: config.cors.origin,
      credentials: true,
    }));

    // Body parsing and compression
    app.use(compression());

    // Webhooks need raw body for signature verification (before json parser)
    app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhooksRoutes);

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Fleet hub: mount BEFORE rate limit.
    // Dashboard polls /api/fleet/status every ~60s; earlier bug loops also burned the
    // shared 100/15min bucket and returned 429 to the whole client.
    app.use('/api/fleet', fleetRoutes);

    // Control plane (auth + config documents) — skip global rate limit for authenticated sync
    app.use('/api/v1', controlPlaneRoutes);

    // Rate limiting for remaining /api/* (auth, files, settings, …)
    const limiter = rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.maxRequests,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: 'Too many requests, please try again later',
      },
      skip: (req) => {
        const url = req.originalUrl || req.url || '';
        // Defense in depth if route order changes
        return url.startsWith('/api/fleet') || url.startsWith('/fleet');
      },
    });
    app.use('/api/', limiter);

    // Static files for status page (settings.html / status.html / download*.html)
    app.use(express.static(path.join(process.cwd(), 'public')));
    // Static files for electron-updater (generic provider) — keep public for auto-update clients
    app.use(
      '/updates',
      express.static(config.updates.dir, {
        dotfiles: 'ignore',
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.yml') || filePath.endsWith('.yaml') || filePath.endsWith('.json')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );

    // Password-gated human download portal
    app.use('/download', downloadPortalRoutes);
    app.get('/', (_req, res) => {
      res.redirect('/download');
    });

    // Health check endpoint
    app.get('/health', async (_req, res) => {
      const controlPlane = isControlPlaneDbEnabled()
        ? await checkDbHealth()
        : { ok: false, error: 'DATABASE_URL not configured' };
      res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        controlPlane: {
          enabled: isControlPlaneDbEnabled(),
          database: controlPlane,
        },
      });
    });

    // API routes (rate-limited)
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
      // Hub-side fleet probe loop (OpenViking / peers / self)
      try {
        fleetMonitorService.start();
        log.info('Fleet monitor started');
      } catch (fleetErr) {
        log.error('Fleet monitor failed to start', fleetErr);
      }
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
