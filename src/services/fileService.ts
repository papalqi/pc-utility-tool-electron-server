import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
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
    await this.loadMetadata();
    log.info('File service initialized');
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
   * Save file metadata
   */
  async saveFile(
    userId: string,
    originalName: string,
    filename: string,
    size: number,
    mimetype: string
  ): Promise<FileMetadata> {
    await this.ensureUserDirectory(userId);

    const metadata: FileMetadata = {
      id: uuidv4(),
      originalName,
      filename,
      path: path.join(this.getUserDirectory(userId), filename),
      size,
      mimetype,
      userId,
      uploadedAt: new Date(),
    };

    this.files.set(metadata.id, metadata);
    await this.saveMetadata();

    log.info(`File saved: ${originalName} for user ${userId}`);
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
}

export const fileService = new FileService();
