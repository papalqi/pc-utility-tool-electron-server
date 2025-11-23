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
    storageType: (process.env.STORAGE_TYPE || 'local') as 'local' | 'qiniu' | 'hybrid',
    backupThreshold: parseInt(process.env.BACKUP_THRESHOLD || '10485760', 10), // 10MB default for hybrid mode
  },

  // Qiniu Cloud Storage
  qiniu: {
    accessKey: process.env.QINIU_ACCESS_KEY || '',
    secretKey: process.env.QINIU_SECRET_KEY || '',
    bucket: process.env.QINIU_BUCKET || '',
    domain: process.env.QINIU_DOMAIN || '',
    zone: process.env.QINIU_ZONE || 'Zone_z2',
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
    if (config.admin.password === 'admin123') {
      errors.push('ADMIN_PASSWORD must be changed in production');
    }
  }

  // Validate Qiniu configuration if using qiniu or hybrid storage
  if (config.upload.storageType === 'qiniu' || config.upload.storageType === 'hybrid') {
    if (!config.qiniu.accessKey) {
      errors.push('QINIU_ACCESS_KEY is required when using qiniu or hybrid storage');
    }
    if (!config.qiniu.secretKey) {
      errors.push('QINIU_SECRET_KEY is required when using qiniu or hybrid storage');
    }
    if (!config.qiniu.bucket) {
      errors.push('QINIU_BUCKET is required when using qiniu or hybrid storage');
    }
    if (!config.qiniu.domain) {
      errors.push('QINIU_DOMAIN is required when using qiniu or hybrid storage');
    }
  }

  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(error => console.error(`  - ${error}`));
    throw new Error('Invalid configuration');
  }
}
