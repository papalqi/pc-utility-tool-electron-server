import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger';

const log = logger.createScope('ConfigService');

export interface StorageConfig {
  storageType: 'local' | 'qiniu' | 'hybrid';
  backupThreshold: number;
  uploadDir: string;
  maxFileSize: number;
  qiniuAccessKey?: string;
  qiniuSecretKey?: string;
  qiniuBucket?: string;
  qiniuDomain?: string;
  qiniuZone?: string;
}

class ConfigService {
  private envPath: string;

  constructor() {
    this.envPath = path.join(process.cwd(), '.env');
  }

  /**
   * Read current storage configuration from environment variables
   */
  async getStorageConfig(): Promise<StorageConfig> {
    return {
      storageType: (process.env.STORAGE_TYPE || 'local') as 'local' | 'qiniu' | 'hybrid',
      backupThreshold: parseInt(process.env.BACKUP_THRESHOLD || '1048576', 10),
      uploadDir: process.env.UPLOAD_DIR || './uploads',
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '104857600', 10),
      qiniuAccessKey: process.env.QINIU_ACCESS_KEY || '',
      qiniuSecretKey: process.env.QINIU_SECRET_KEY || '',
      qiniuBucket: process.env.QINIU_BUCKET || '',
      qiniuDomain: process.env.QINIU_DOMAIN || '',
      qiniuZone: process.env.QINIU_ZONE || 'Zone_z2',
    };
  }

  /**
   * Update storage configuration in .env file
   */
  async updateStorageConfig(config: Partial<StorageConfig>): Promise<void> {
    try {
      // Read current .env file
      let envContent = '';
      try {
        envContent = await fs.readFile(this.envPath, 'utf-8');
      } catch {
        // If .env doesn't exist, create a new one
        log.warn('.env file not found, creating new one');
        envContent = '';
      }

      // Parse and update environment variables
      const lines = envContent.split('\n');
      const updatedVars: { [key: string]: string } = {};

      // Map configuration to environment variable names
      if (config.storageType !== undefined) {
        updatedVars['STORAGE_TYPE'] = config.storageType;
      }
      if (config.backupThreshold !== undefined) {
        updatedVars['BACKUP_THRESHOLD'] = config.backupThreshold.toString();
      }
      if (config.uploadDir !== undefined) {
        updatedVars['UPLOAD_DIR'] = config.uploadDir;
      }
      if (config.maxFileSize !== undefined) {
        updatedVars['MAX_FILE_SIZE'] = config.maxFileSize.toString();
      }
      if (config.qiniuAccessKey !== undefined) {
        updatedVars['QINIU_ACCESS_KEY'] = config.qiniuAccessKey;
      }
      if (config.qiniuSecretKey !== undefined) {
        updatedVars['QINIU_SECRET_KEY'] = config.qiniuSecretKey;
      }
      if (config.qiniuBucket !== undefined) {
        updatedVars['QINIU_BUCKET'] = config.qiniuBucket;
      }
      if (config.qiniuDomain !== undefined) {
        updatedVars['QINIU_DOMAIN'] = config.qiniuDomain;
      }
      if (config.qiniuZone !== undefined) {
        updatedVars['QINIU_ZONE'] = config.qiniuZone;
      }

      // Update or add variables in the file
      const updatedKeys = new Set<string>();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Skip comments and empty lines
        if (!line || line.startsWith('#')) {
          continue;
        }

        // Check if this line contains a variable we want to update
        const match = line.match(/^([^=]+)=/);
        if (match) {
          const key = match[1].trim();
          if (updatedVars[key] !== undefined) {
            lines[i] = `${key}=${updatedVars[key]}`;
            updatedKeys.add(key);
          }
        }
      }

      // Add new variables that weren't in the file
      for (const [key, value] of Object.entries(updatedVars)) {
        if (!updatedKeys.has(key)) {
          lines.push(`${key}=${value}`);
        }
      }

      // Write back to .env file
      const newContent = lines.join('\n');
      await fs.writeFile(this.envPath, newContent, 'utf-8');

      // Update process.env (Note: This only affects the current process)
      for (const [key, value] of Object.entries(updatedVars)) {
        process.env[key] = value;
      }

      log.info('Storage configuration updated successfully');
    } catch (error) {
      log.error('Failed to update storage configuration', error);
      throw new Error('Failed to update storage configuration');
    }
  }

  /**
   * Validate storage configuration
   */
  validateStorageConfig(config: Partial<StorageConfig>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate storage type
    if (config.storageType !== undefined) {
      if (!['local', 'qiniu', 'hybrid'].includes(config.storageType)) {
        errors.push('Invalid storage type. Must be: local, qiniu, or hybrid');
      }
    }

    // Validate backup threshold
    if (config.backupThreshold !== undefined) {
      if (config.backupThreshold < 0) {
        errors.push('Backup threshold must be a positive number');
      }
    }

    // Validate max file size
    if (config.maxFileSize !== undefined) {
      if (config.maxFileSize <= 0) {
        errors.push('Max file size must be greater than 0');
      }
    }

    // Validate Qiniu configuration when using qiniu or hybrid storage
    if (config.storageType === 'qiniu' || config.storageType === 'hybrid') {
      if (config.qiniuAccessKey !== undefined && !config.qiniuAccessKey) {
        errors.push('Qiniu Access Key is required for Qiniu or Hybrid storage');
      }
      if (config.qiniuSecretKey !== undefined && !config.qiniuSecretKey) {
        errors.push('Qiniu Secret Key is required for Qiniu or Hybrid storage');
      }
      if (config.qiniuBucket !== undefined && !config.qiniuBucket) {
        errors.push('Qiniu Bucket is required for Qiniu or Hybrid storage');
      }
      if (config.qiniuDomain !== undefined && !config.qiniuDomain) {
        errors.push('Qiniu Domain is required for Qiniu or Hybrid storage');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

export const configService = new ConfigService();
