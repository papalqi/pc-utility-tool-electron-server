import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import qiniu from 'qiniu';
import { FileMetadata } from '../types';
import { logger } from '../utils/logger';
import { config } from '../config';

const log = logger.createScope('FileService');

/**
 * File service - manages file storage and metadata
 */
class FileService {
  private metadataFile: string;
  private files: Map<string, FileMetadata>;

  constructor() {
    this.metadataFile = path.join(process.cwd(), 'data', 'files.json');
    this.files = new Map();
  }

  /**
   * Initialize file service
   */
  async initialize(): Promise<void> {
    await this.ensureUploadDirectory();
    await this.ensureDataDirectory();
    await this.loadMetadata();
    
    const storageType = config.upload.storageType;
    log.info(`File service initialized with ${storageType} storage mode`);
    
    if (storageType === 'qiniu' || storageType === 'hybrid') {
      if (!config.qiniu.accessKey || !config.qiniu.secretKey) {
        log.warn('Qiniu credentials not configured, falling back to local storage');
      } else {
        log.info('Qiniu cloud storage configured');
      }
    }
  }

  /**
   * Ensure data directory exists
   */
  private async ensureDataDirectory(): Promise<void> {
    const dataDir = path.dirname(this.metadataFile);
    try {
      await fs.access(dataDir);
    } catch {
      await fs.mkdir(dataDir, { recursive: true });
      log.info('Created data directory');
    }
  }

  /**
   * Ensure upload directory exists
   */
  private async ensureUploadDirectory(): Promise<void> {
    try {
      await fs.access(config.upload.dir);
    } catch {
      await fs.mkdir(config.upload.dir, { recursive: true });
      log.info('Created upload directory');
    }
  }

  /**
   * Load file metadata
   */
  private async loadMetadata(): Promise<void> {
    try {
      const data = await fs.readFile(this.metadataFile, 'utf-8');
      const filesArray: FileMetadata[] = JSON.parse(data);
      this.files = new Map(filesArray.map(file => [file.id, file]));
      log.info(`Loaded ${this.files.size} file metadata entries`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        log.info('No existing file metadata, starting fresh');
        this.files = new Map();
      } else {
        log.error('Failed to load file metadata', error);
        throw error;
      }
    }
  }

  /**
   * Save file metadata
   */
  private async saveMetadata(): Promise<void> {
    try {
      const filesArray = Array.from(this.files.values());
      await fs.writeFile(this.metadataFile, JSON.stringify(filesArray, null, 2), 'utf-8');
      log.debug('File metadata saved');
    } catch (error) {
      log.error('Failed to save file metadata', error);
      throw error;
    }
  }

  /**
   * Get user directory path
   */
  private getUserDirectory(userId: string): string {
    return path.join(config.upload.dir, userId);
  }

  /**
   * Ensure user directory exists
   */
  private async ensureUserDirectory(userId: string): Promise<void> {
    const userDir = this.getUserDirectory(userId);
    try {
      await fs.access(userDir);
    } catch {
      await fs.mkdir(userDir, { recursive: true });
      log.debug(`Created user directory for ${userId}`);
    }
  }

  /**
   * Upload file to Qiniu Cloud Storage
   */
  private async uploadToQiniu(localPath: string, userId: string, filename: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const mac = new qiniu.auth.digest.Mac(config.qiniu.accessKey, config.qiniu.secretKey);
        const options = {
          scope: config.qiniu.bucket,
        };
        const putPolicy = new qiniu.rs.PutPolicy(options);
        const uploadToken = putPolicy.uploadToken(mac);

        const qiniuConfig = new qiniu.conf.Config();
        // @ts-expect-error - Zone configuration
        qiniuConfig.zone = qiniu.zone[config.qiniu.zone];

        const formUploader = new qiniu.form_up.FormUploader(qiniuConfig);
        const putExtra = new qiniu.form_up.PutExtra();

        // 使用用户ID作为目录前缀
        const key = `${userId}/${filename}`;

        formUploader.putFile(uploadToken, key, localPath, putExtra, (err, body, info) => {
          if (err) {
            log.error('Qiniu upload failed', err);
            reject(err);
            return;
          }

          if (info.statusCode === 200) {
            log.info(`File uploaded to Qiniu: ${key}`);
            resolve(key);
          } else {
            log.error(`Qiniu upload failed with status ${info.statusCode}`, body);
            reject(new Error(`Upload failed: ${info.statusCode}`));
          }
        });
      } catch (error) {
        log.error('Qiniu upload error', error);
        reject(error);
      }
    });
  }

  /**
   * Get file URL from Qiniu
   */
  private getQiniuUrl(key: string): string {
    // 如果配置了CDN域名，使用CDN域名
    if (config.qiniu.domain) {
      const domain = config.qiniu.domain.replace(/\/$/, ''); // 移除结尾斜杠
      return `${domain}/${key}`;
    }
    
    // 如果没有配置CDN域名，返回key路径
    // 服务器将通过代理方式提供访问
    return `/${key}`;
  }

  /**
   * Get direct Qiniu access URL (for proxy download)
   * 构建七牛云直接访问URL，即使没有CDN域名也能访问
   */
  getQiniuDirectUrl(cloudUrl: string): string | null {
    // 如果已经是完整URL，直接返回
    if (cloudUrl.startsWith('http://') || cloudUrl.startsWith('https://')) {
      return cloudUrl;
    }

    // 如果配置了域名，构建完整URL
    if (config.qiniu.domain) {
      const domain = config.qiniu.domain.replace(/\/$/, '');
      const key = cloudUrl.startsWith('/') ? cloudUrl.substring(1) : cloudUrl;
      return `${domain}/${key}`;
    }

    // 使用七牛云的默认源站域名
    // 格式: http://{bucket}.{zone-id}.qiniucs.com/{key}
    const bucket = config.qiniu.bucket;
    const zone = this.getQiniuZoneId(config.qiniu.zone);
    const key = cloudUrl.startsWith('/') ? cloudUrl.substring(1) : cloudUrl;
    
    if (bucket && zone) {
      return `http://${bucket}.${zone}.qiniucs.com/${key}`;
    }

    log.warn('Unable to construct Qiniu URL: missing configuration');
    return null;
  }

  /**
   * Get Qiniu zone ID from zone name
   */
  private getQiniuZoneId(zoneName: string): string {
    const zoneMap: Record<string, string> = {
      'Zone_z0': 'z0',      // 华东-浙江
      'Zone_z1': 'z1',      // 华北-河北
      'Zone_z2': 'z2',      // 华南-广东
      'Zone_na0': 'na0',    // 北美
      'Zone_as0': 'as0',    // 东南亚
    };
    return zoneMap[zoneName] || 'z2';
  }

  /**
   * Save file metadata and upload based on storage strategy
   */
  async saveFile(
    userId: string,
    originalName: string,
    filename: string,
    size: number,
    mimetype: string
  ): Promise<FileMetadata> {
    await this.ensureUserDirectory(userId);

    const localPath = path.join(this.getUserDirectory(userId), filename);
    const storageType = config.upload.storageType;
    
    let cloudUrl: string | undefined;
    let shouldUploadToCloud = false;

    // 根据存储策略决定是否上传到七牛云
    if (storageType === 'qiniu') {
      // 纯七牛云模式：直接上传
      shouldUploadToCloud = true;
    } else if (storageType === 'hybrid') {
      // 混合模式：大文件才上传到云
      shouldUploadToCloud = size >= config.upload.backupThreshold;
    }

    // 如果需要上传到七牛云
    if (shouldUploadToCloud && config.qiniu.accessKey && config.qiniu.secretKey) {
      try {
        const qiniuKey = await this.uploadToQiniu(localPath, userId, filename);
        cloudUrl = this.getQiniuUrl(qiniuKey);
        log.info(`File uploaded to Qiniu: ${originalName} (${size} bytes)`);
      } catch (error) {
        log.error(`Failed to upload to Qiniu, keeping local copy only`, error);
      }
    }

    const metadata: FileMetadata = {
      id: uuidv4(),
      originalName,
      filename,
      path: localPath,
      size,
      mimetype,
      userId,
      uploadedAt: new Date(),
      cloudUrl, // 云存储URL（如果有）
    };

    this.files.set(metadata.id, metadata);
    await this.saveMetadata();

    const storageInfo = cloudUrl 
      ? `(local + cloud: ${cloudUrl})` 
      : `(local only)`;
    log.info(`File saved: ${originalName} for user ${userId} ${storageInfo}`);
    
    return metadata;
  }

  /**
   * Get file metadata by ID
   */
  async getFileById(fileId: string): Promise<FileMetadata | null> {
    return this.files.get(fileId) || null;
  }

  /**
   * Get all files for a user
   */
  async getFilesByUser(userId: string): Promise<FileMetadata[]> {
    return Array.from(this.files.values()).filter(file => file.userId === userId);
  }

  /**
   * Delete file
   */
  async deleteFile(fileId: string): Promise<void> {
    const metadata = this.files.get(fileId);
    if (!metadata) {
      throw new Error('File not found');
    }

    // Delete physical file
    try {
      await fs.unlink(metadata.path);
      log.debug(`Deleted physical file: ${metadata.path}`);
    } catch (error) {
      log.warn(`Failed to delete physical file: ${metadata.path}`, error);
    }

    // Remove metadata
    this.files.delete(fileId);
    await this.saveMetadata();

    log.info(`File deleted: ${metadata.originalName}`);
  }

  /**
   * Get file path
   */
  getFilePath(metadata: FileMetadata): string {
    return metadata.path;
  }

  /**
   * Calculate total storage used by user
   */
  async getUserStorageSize(userId: string): Promise<number> {
    const userFiles = await this.getFilesByUser(userId);
    return userFiles.reduce((total, file) => total + file.size, 0);
  }

  /**
   * Get all files (for admin/status monitoring)
   */
  getAllFiles(): FileMetadata[] {
    return Array.from(this.files.values());
  }
}


export const fileService = new FileService();
