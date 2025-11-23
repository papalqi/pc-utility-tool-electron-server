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
 * 七牛云代理下载测试
 * 
 * 测试服务器中转下载七牛云文件的功能
 */
describe('Qiniu Proxy Download', () => {
  let app: Express;
  let authToken: string;
  let testFilePath: string;
  let uploadedFileId: string;

  beforeAll(async () => {
    // 设置Express应用
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use('/api/files', fileRoutes);

    // 初始化服务
    await userService.initialize();
    await fileService.initialize();

    // 创建或获取测试用户
    const existingUser = await userService.findByUsername('test_proxy_user');
    if (!existingUser) {
      await userService.createUser({
        username: 'test_proxy_user',
        password: 'test_password123',
      });
    }

    // 登录获取token
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({
        username: 'test_proxy_user',
        password: 'test_password123',
      });

    authToken = loginResponse.body.data.token;

    // 创建测试文件
    testFilePath = path.join(process.cwd(), 'test-uploads', 'proxy-test.txt');
    await fs.mkdir(path.dirname(testFilePath), { recursive: true });
    await fs.writeFile(testFilePath, 'Proxy download test file content.');
  });

  afterAll(async () => {
    // 清理测试文件
    if (testFilePath) {
      try {
        await fs.unlink(testFilePath);
      } catch (error) {
        console.warn('Failed to clean up test file:', error);
      }
    }
  });

  test('上传文件到七牛云', async () => {
    if (!config.qiniu.accessKey || !config.qiniu.secretKey) {
      console.log('Skipping test: Qiniu credentials not configured');
      return;
    }

    const response = await request(app)
      .post('/api/files/upload')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('file', testFilePath);

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.cloudUrl).toBeTruthy();
    
    uploadedFileId = response.body.data.id;
    console.log('✅ 文件已上传:', response.body.data.cloudUrl);
  }, 30000);

  test('通过服务器代理下载七牛云文件', async () => {
    if (!uploadedFileId) {
      console.log('Skipping test: No uploaded file');
      return;
    }

    // 下载文件
    const response = await request(app)
      .get(`/api/files/${uploadedFileId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();
    
    // 验证文件内容
    const content = response.body.toString();
    expect(content).toContain('Proxy download test file content');
    
    console.log('✅ 通过服务器代理下载成功');
  }, 30000);

  test('删除本地文件后仍可通过代理下载', async () => {
    if (!uploadedFileId || !config.qiniu.accessKey) {
      console.log('Skipping test: Prerequisites not met');
      return;
    }

    // 获取文件元数据
    const metadata = await fileService.getFileById(uploadedFileId);
    if (!metadata) {
      console.log('Skipping test: File not found');
      return;
    }

    // 删除本地文件
    try {
      await fs.unlink(metadata.path);
      console.log('✅ 本地文件已删除');
    } catch (error) {
      console.warn('Failed to delete local file:', error);
    }

    // 尝试下载（应该从七牛云代理）
    const response = await request(app)
      .get(`/api/files/${uploadedFileId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();
    
    console.log('✅ 本地文件不存在，成功从七牛云代理下载');
  }, 30000);

  test('getQiniuDirectUrl方法：无CDN域名时构建默认URL', () => {
    const testCloudUrl = '/user123/test-file.txt';
    const directUrl = fileService.getQiniuDirectUrl(testCloudUrl);
    
    expect(directUrl).toBeTruthy();
    expect(directUrl).toContain(config.qiniu.bucket);
    expect(directUrl).toContain('qiniucs.com');
    expect(directUrl).toContain('user123/test-file.txt');
    
    console.log('✅ 默认URL构建成功:', directUrl);
  });

  test('getQiniuDirectUrl方法：有CDN域名时使用CDN', () => {
    // 临时修改配置
    const originalDomain = config.qiniu.domain;
    config.qiniu.domain = 'http://cdn.example.com';

    const testCloudUrl = '/user123/test-file.txt';
    const directUrl = fileService.getQiniuDirectUrl(testCloudUrl);
    
    expect(directUrl).toBe('http://cdn.example.com/user123/test-file.txt');
    
    // 恢复原配置
    config.qiniu.domain = originalDomain;
    
    console.log('✅ CDN URL构建成功:', directUrl);
  });

  test('getQiniuDirectUrl方法：已有完整URL直接返回', () => {
    const completeUrl = 'https://cdn.example.com/file.txt';
    const directUrl = fileService.getQiniuDirectUrl(completeUrl);
    
    expect(directUrl).toBe(completeUrl);
    
    console.log('✅ 完整URL直接返回:', directUrl);
  });
});
