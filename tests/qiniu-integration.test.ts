import request from 'supertest';
import express, { Express } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../src/config';
import { userService } from '../src/services/userService';
import { fileService } from '../src/services/fileService';
import authRoutes from '../src/routes/auth';
import fileRoutes from '../src/routes/files';

/**
 * 七牛云上传集成测试
 * 
 * 测试完整的文件上传流程，包括：
 * 1. 用户认证
 * 2. 文件上传到本地
 * 3. 文件上传到七牛云
 * 4. 文件元数据管理
 */
describe('Qiniu Upload Integration', () => {
  let app: Express;
  let authToken: string;
  let testUserId: string;
  let testFilePath: string;

  beforeAll(async () => {
    // 设置Express应用
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use('/api/files', fileRoutes);

    // 初始化服务
    await userService.initialize();
    await fileService.initialize();

    // 创建测试用户并获取token
    const existingUser = await userService.findByUsername('test_qiniu_user');
    if (existingUser) {
      testUserId = existingUser.id;
    } else {
      const user = await userService.createUser({
        username: 'test_qiniu_user',
        password: 'test_password123',
      });
      testUserId = user.id;
    }

    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({
        username: 'test_qiniu_user',
        password: 'test_password123',
      });

    authToken = loginResponse.body.data.token;

    // 创建测试文件
    testFilePath = path.join(process.cwd(), 'test-uploads', 'integration-test.txt');
    await fs.mkdir(path.dirname(testFilePath), { recursive: true });
    await fs.writeFile(testFilePath, 'Integration test file for Qiniu upload.');
  });

  afterAll(async () => {
    // 注意：userService没有deleteUser方法，测试用户将保留
    // 在生产环境中，应该提供适当的清理机制

    // 清理测试文件
    if (testFilePath) {
      try {
        await fs.unlink(testFilePath);
      } catch (error) {
        console.warn('Failed to clean up test file:', error);
      }
    }

    // 清理上传目录
    try {
      const uploadDir = path.join(config.upload.dir, testUserId);
      const files = await fs.readdir(uploadDir);
      for (const file of files) {
        await fs.unlink(path.join(uploadDir, file));
      }
      await fs.rmdir(uploadDir);
    } catch (error) {
      console.warn('Failed to clean up upload directory:', error);
    }
  });

  test('认证：应该能够成功登录并获取token', () => {
    expect(authToken).toBeTruthy();
    expect(typeof authToken).toBe('string');
  });

  test('文件上传：应该能够上传文件并获取元数据', async () => {
    const response = await request(app)
      .post('/api/files/upload')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('file', testFilePath);

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toBeDefined();
    expect(response.body.data.id).toBeTruthy();
    expect(response.body.data.originalName).toBe('integration-test.txt');
    expect(response.body.data.userId).toBe(testUserId);

    console.log('✅ 文件上传响应:', response.body.data);
  }, 30000);

  test('七牛云上传：当配置正确时应该包含cloudUrl', async () => {
    if (!config.qiniu.accessKey || !config.qiniu.secretKey) {
      console.log('Skipping test: Qiniu credentials not configured');
      return;
    }

    // 上传文件
    const response = await request(app)
      .post('/api/files/upload')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('file', testFilePath);

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);

    // 根据存储策略验证cloudUrl
    if (config.upload.storageType === 'qiniu') {
      // qiniu模式下，所有文件都应该有cloudUrl
      expect(response.body.data.cloudUrl).toBeTruthy();
      expect(response.body.data.cloudUrl).toContain(config.qiniu.domain);
      console.log('✅ Qiniu cloudUrl:', response.body.data.cloudUrl);
    } else if (config.upload.storageType === 'hybrid') {
      // hybrid模式下，根据文件大小判断
      const fileSize = response.body.data.size;
      if (fileSize >= config.upload.backupThreshold) {
        expect(response.body.data.cloudUrl).toBeTruthy();
        console.log('✅ Large file uploaded to Qiniu:', response.body.data.cloudUrl);
      } else {
        console.log('ℹ️ Small file kept locally only');
      }
    }
  }, 30000);

  test('文件列表：应该能够获取用户上传的文件列表', async () => {
    // 先上传一个文件
    await request(app)
      .post('/api/files/upload')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('file', testFilePath);

    // 获取文件列表
    const response = await request(app)
      .get('/api/files')
      .set('Authorization', `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data.length).toBeGreaterThan(0);

    const file = response.body.data[0];
    expect(file.userId).toBe(testUserId);
    console.log('✅ 文件列表:', response.body.data.length, '个文件');
  });

  test('文件下载：应该能够下载上传的文件', async () => {
    // 先上传一个文件
    const uploadResponse = await request(app)
      .post('/api/files/upload')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('file', testFilePath);

    const fileId = uploadResponse.body.data.id;

    // 下载文件
    const downloadResponse = await request(app)
      .get(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.body).toBeTruthy();
    console.log('✅ 文件下载成功');
  });

  test('文件删除：应该能够删除上传的文件', async () => {
    // 先上传一个文件
    const uploadResponse = await request(app)
      .post('/api/files/upload')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('file', testFilePath);

    const fileId = uploadResponse.body.data.id;

    // 删除文件
    const deleteResponse = await request(app)
      .delete(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.success).toBe(true);

    // 验证文件已删除
    const getResponse = await request(app)
      .get(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(getResponse.status).toBe(404);
    console.log('✅ 文件删除成功');
  });

  test('多文件上传：应该能够同时上传多个文件', async () => {
    // 创建多个测试文件
    const testFiles = [
      path.join(process.cwd(), 'test-uploads', 'multi-test-1.txt'),
      path.join(process.cwd(), 'test-uploads', 'multi-test-2.txt'),
    ];

    for (const filePath of testFiles) {
      await fs.writeFile(filePath, `Test content for ${path.basename(filePath)}`);
    }

    try {
      // 上传多个文件
      const response = await request(app)
        .post('/api/files/upload-multiple')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('files', testFiles[0])
        .attach('files', testFiles[1]);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBe(2);

      console.log('✅ 多文件上传成功:', response.body.data.length, '个文件');
    } finally {
      // 清理测试文件
      for (const filePath of testFiles) {
        try {
          await fs.unlink(filePath);
        } catch {
          console.warn('Failed to clean up test file:', filePath);
        }
      }
    }
  }, 30000);

  test('存储使用情况：应该能够获取用户的存储使用情况', async () => {
    const response = await request(app)
      .get('/api/files/storage/usage')
      .set('Authorization', `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toBeDefined();
    expect(typeof response.body.data.used).toBe('number');
    expect(typeof response.body.data.files).toBe('number');

    console.log('✅ 存储使用情况:', response.body.data);
  });

  test('错误处理：无认证token应该返回401', async () => {
    const response = await request(app)
      .post('/api/files/upload')
      .attach('file', testFilePath);

    expect(response.status).toBe(401);
  });

  test('错误处理：无效token应该返回403', async () => {
    const response = await request(app)
      .post('/api/files/upload')
      .set('Authorization', 'Bearer invalid_token')
      .attach('file', testFilePath);

    expect(response.status).toBe(403);
  });

  test('错误处理：未上传文件应该返回400', async () => {
    const response = await request(app)
      .post('/api/files/upload')
      .set('Authorization', `Bearer ${authToken}`);

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('No file uploaded');
  });
});
