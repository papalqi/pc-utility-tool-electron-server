import os from 'os';
import { fileService } from './fileService';
import { userService } from './userService';
import { config } from '../config';

/**
 * Service for monitoring server status
 */
class StatusService {
  private startTime: Date;

  constructor() {
    this.startTime = new Date();
  }

  /**
   * Get comprehensive server status
   */
  async getStatus() {
    const uptime = Date.now() - this.startTime.getTime();
    const allUsers = await userService.getAllUsers();
    const allFiles = fileService.getAllFiles();

    // Calculate total storage used
    let totalStorage = 0;
    for (const file of allFiles) {
      totalStorage += file.size;
    }

    // System info
    const systemInfo = {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      uptime: os.uptime(),
    };

    // Node.js info
    const nodeInfo = {
      version: process.version,
      pid: process.pid,
      memoryUsage: process.memoryUsage(),
    };

    return {
      server: {
        status: 'running',
        uptime: uptime,
        startTime: this.startTime,
        environment: config.nodeEnv,
        port: config.port,
      },
      storage: {
        uploadDir: config.upload.dir,
        maxFileSize: config.upload.maxFileSize,
        totalFiles: allFiles.length,
        totalSize: totalStorage,
        totalSizeFormatted: this.formatBytes(totalStorage),
      },
      users: {
        total: allUsers.length,
      },
      system: {
        platform: systemInfo.platform,
        arch: systemInfo.arch,
        hostname: systemInfo.hostname,
        cpus: systemInfo.cpus,
        totalMemory: systemInfo.totalMemory,
        totalMemoryFormatted: this.formatBytes(systemInfo.totalMemory),
        freeMemory: systemInfo.freeMemory,
        freeMemoryFormatted: this.formatBytes(systemInfo.freeMemory),
        systemUptime: systemInfo.uptime,
      },
      node: {
        version: nodeInfo.version,
        pid: nodeInfo.pid,
        memoryUsage: {
          rss: nodeInfo.memoryUsage.rss,
          rssFormatted: this.formatBytes(nodeInfo.memoryUsage.rss),
          heapTotal: nodeInfo.memoryUsage.heapTotal,
          heapTotalFormatted: this.formatBytes(nodeInfo.memoryUsage.heapTotal),
          heapUsed: nodeInfo.memoryUsage.heapUsed,
          heapUsedFormatted: this.formatBytes(nodeInfo.memoryUsage.heapUsed),
          external: nodeInfo.memoryUsage.external,
          externalFormatted: this.formatBytes(nodeInfo.memoryUsage.external),
        },
      },
      timestamp: new Date(),
    };
  }

  /**
   * Get simple health check
   */
  getHealth() {
    return {
      status: 'healthy',
      timestamp: new Date(),
      uptime: Date.now() - this.startTime.getTime(),
    };
  }

  /**
   * Format bytes to human readable format
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Reset start time (for testing)
   */
  resetStartTime() {
    this.startTime = new Date();
  }
}

export const statusService = new StatusService();
