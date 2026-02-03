import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config();

/**
 * Server configuration
 */
export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  bindHost: process.env.BIND_HOST || '0.0.0.0',
  /**
   * Express trust proxy setting.
   * When the server is reverse-proxied (e.g. Caddy/Nginx), enable this so middlewares
   * like express-rate-limit can read the real client IP from X-Forwarded-For.
   *
   * Examples:
   * - TRUST_PROXY=1
   * - TRUST_PROXY=true
   * - TRUST_PROXY=loopback
   */
  trustProxy: process.env.TRUST_PROXY,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV !== 'production',

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },

  // File upload
  upload: {
    dir: process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'),
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '104857600', 10), // 100MB default
  },

  // Auto-update artifacts (electron-updater generic provider)
  updates: {
    dir: process.env.UPDATES_DIR || path.join(process.cwd(), 'updates'),
    maxFileSize: parseInt(process.env.MAX_UPDATE_FILE_SIZE || process.env.MAX_FILE_SIZE || '104857600', 10),
  },

  // GitHub release sync for updates
  githubUpdates: {
    owner: process.env.GITHUB_UPDATES_OWNER || 'papalqi',
    repo: process.env.GITHUB_UPDATES_REPO || 'utility-tool',
    token: process.env.GITHUB_UPDATES_TOKEN || '',
    target: process.env.GITHUB_UPDATES_TARGET || 'all',
  },

  githubWebhook: {
    secret: process.env.GITHUB_WEBHOOK_SECRET || '',
  },

  // Admin user
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123',
  },

  // Rate limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },

  // CORS
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },
};

/**
 * Validate required configuration
 */
export function validateConfig(): void {
  const errors: string[] = [];

  if (config.nodeEnv === 'production') {
    if (config.jwt.secret === 'your-super-secret-jwt-key-change-this') {
      errors.push('JWT_SECRET must be set in production');
    }
    if (!config.admin.password) {
      errors.push('ADMIN_PASSWORD must be set in production');
    }
    if (config.admin.password === 'admin123') {
      errors.push('ADMIN_PASSWORD must be changed in production');
    }
  }

  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(error => console.error(`  - ${error}`));
    throw new Error('Invalid configuration');
  }

  const target = config.githubUpdates.target;
  if (target !== 'all' && target !== 'windows') {
    throw new Error(`Invalid GITHUB_UPDATES_TARGET: ${target} (expected: all | windows)`);
  }
}
