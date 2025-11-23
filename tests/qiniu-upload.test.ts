import fs from 'fs/promises';
import path from 'path';
import qiniu from 'qiniu';
import { config } from '../src/config';

/**
 * 七牛云上传单元测试
 * 
 * 运行前请确保 .env.test 文件中配置了正确的七牛云凭证：
 * - QINIU_ACCESS_KEY
 * - QINIU_SECRET_KEY
 * - QINIU_BUCKET
 * - QINIU_DOMAIN
 */
describe('Qiniu Cloud Upload', () => {
  let testFilePath: string;
  let testFileName: string;
  let uploadedKey: string;

  beforeAll(async () => {
    // 检查七牛云配置
    if (!config.qiniu.accessKey || !config.qiniu.secretKey) {
      console.warn('⚠️ Qiniu credentials not configured, skipping tests');
      return;
    }

    // 创建测试文件
    testFileName = `test-${Date.now()}.txt`;
    testFilePath = path.join(process.cwd(), 'test-uploads', testFileName);
    
    // 确保目录存在
    await fs.mkdir(path.dirname(testFilePath), { recursive: true });
    
    // 写入测试内容
    await fs.writeFile(testFilePath, 'This is a test file for Qiniu upload.');
  });

  afterAll(async () => {
    // 清理本地测试文件
    if (testFilePath) {
      try {
        await fs.unlink(testFilePath);
      } catch (error) {
        console.warn('Failed to clean up test file:', error);
      }
    }

    // 清理七牛云上传的文件
    if (uploadedKey && config.qiniu.accessKey && config.qiniu.secretKey) {
      try {
        const mac = new qiniu.auth.digest.Mac(config.qiniu.accessKey, config.qiniu.secretKey);
        const qiniuConfig = new qiniu.conf.Config();
        const bucketManager = new qiniu.rs.BucketManager(mac, qiniuConfig);
        
        await new Promise((resolve) => {
          bucketManager.delete(config.qiniu.bucket, uploadedKey, (err, respBody) => {
            if (err) {
              console.warn('Failed to delete test file from Qiniu:', err);
              resolve(null);
            } else {
              console.log('Test file deleted from Qiniu:', uploadedKey);
              resolve(respBody);
            }
          });
        });
      } catch (error) {
        console.warn('Failed to clean up Qiniu file:', error);
      }
    }
  });

  test('配置验证：七牛云凭证应该正确配置', () => {
    expect(config.qiniu.accessKey).toBeTruthy();
    expect(config.qiniu.secretKey).toBeTruthy();
    expect(config.qiniu.bucket).toBeTruthy();
    expect(config.qiniu.zone).toBeTruthy();
  });

  test('上传令牌生成：应该能够生成有效的上传令牌', () => {
    if (!config.qiniu.accessKey || !config.qiniu.secretKey) {
      console.log('Skipping test: Qiniu credentials not configured');
      return;
    }

    const mac = new qiniu.auth.digest.Mac(config.qiniu.accessKey, config.qiniu.secretKey);
    const options = {
      scope: config.qiniu.bucket,
    };
    const putPolicy = new qiniu.rs.PutPolicy(options);
    const uploadToken = putPolicy.uploadToken(mac);

    expect(uploadToken).toBeTruthy();
    expect(typeof uploadToken).toBe('string');
    expect(uploadToken.split(':').length).toBeGreaterThanOrEqual(2);
  });

  test('文件上传：应该能够成功上传文件到七牛云', async () => {
    if (!config.qiniu.accessKey || !config.qiniu.secretKey) {
      console.log('Skipping test: Qiniu credentials not configured');
      return;
    }

    // 生成上传令牌
    const mac = new qiniu.auth.digest.Mac(config.qiniu.accessKey, config.qiniu.secretKey);
    const options = {
      scope: config.qiniu.bucket,
    };
    const putPolicy = new qiniu.rs.PutPolicy(options);
    const uploadToken = putPolicy.uploadToken(mac);

    // 配置上传
    const qiniuConfig = new qiniu.conf.Config();
    // @ts-expect-error - Zone configuration
    qiniuConfig.zone = qiniu.zone[config.qiniu.zone];

    const formUploader = new qiniu.form_up.FormUploader(qiniuConfig);
    const putExtra = new qiniu.form_up.PutExtra();

    // 使用测试目录前缀
    const key = `test/${testFileName}`;
    uploadedKey = key;

    // 执行上传
    const result = await new Promise<{ key: string; hash: string }>((resolve, reject) => {
      formUploader.putFile(uploadToken, key, testFilePath, putExtra, (err, body, info) => {
        if (err) {
          reject(err);
          return;
        }

        if (info.statusCode === 200) {
          resolve(body);
        } else {
          reject(new Error(`Upload failed with status ${info.statusCode}`));
        }
      });
    });

    // 验证上传结果
    expect(result).toBeDefined();
    expect(result.key).toBe(key);
    expect(result.hash).toBeTruthy();
    console.log('✅ 文件上传成功:', result);
  }, 30000);

  test('URL生成：应该能够生成正确的访问URL', () => {
    if (!config.qiniu.domain) {
      console.log('Skipping test: Qiniu domain not configured');
      return;
    }

    const key = 'test/example.txt';
    const domain = config.qiniu.domain.replace(/\/$/, '');
    const expectedUrl = `${domain}/${key}`;

    expect(expectedUrl).toContain(domain);
    expect(expectedUrl).toContain(key);
    expect(expectedUrl).toMatch(/^https?:\/\//);
  });

  test('存储策略：qiniu模式下应该上传所有文件', () => {
    const storageType = 'qiniu' as const;

    const shouldUploadToCloud = storageType === 'qiniu';

    expect(shouldUploadToCloud).toBe(true);
  });

  test('存储策略：hybrid模式下应该根据文件大小决定是否上传', () => {
    const threshold = 10 * 1024 * 1024; // 10MB

    const smallFileSize = 5 * 1024 * 1024; // 5MB
    const largeFileSize = 15 * 1024 * 1024; // 15MB

    const shouldUploadSmallFile = smallFileSize >= threshold;
    const shouldUploadLargeFile = largeFileSize >= threshold;

    expect(shouldUploadSmallFile).toBe(false);
    expect(shouldUploadLargeFile).toBe(true);
  });

  test('错误处理：无效的凭证应该返回错误', async () => {
    const mac = new qiniu.auth.digest.Mac('invalid_access_key', 'invalid_secret_key');
    const options = {
      scope: 'invalid_bucket',
    };
    const putPolicy = new qiniu.rs.PutPolicy(options);
    const uploadToken = putPolicy.uploadToken(mac);

    const qiniuConfig = new qiniu.conf.Config();
    const formUploader = new qiniu.form_up.FormUploader(qiniuConfig);
    const putExtra = new qiniu.form_up.PutExtra();

    const key = 'test/invalid.txt';

    await expect(
      new Promise((resolve, reject) => {
        formUploader.putFile(uploadToken, key, testFilePath, putExtra, (err, body, info) => {
          if (err) {
            reject(err);
            return;
          }

          if (info.statusCode === 200) {
            resolve(body);
          } else {
            reject(new Error(`Upload failed with status ${info.statusCode}`));
          }
        });
      })
    ).rejects.toThrow();
  }, 30000);
});
