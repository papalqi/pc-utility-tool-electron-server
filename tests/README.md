# 七牛云上传测试

本目录包含了七牛云文件上传功能的完整测试套件，包括单元测试和集成测试。

## 📋 目录

- [测试文件说明](#测试文件说明)
- [环境配置](#环境配置)
- [安装依赖](#安装依赖)
- [运行测试](#运行测试)
- [测试覆盖范围](#测试覆盖范围)
- [常见问题](#常见问题)

## 📁 测试文件说明

### 1. `qiniu-upload.test.ts` - 单元测试

测试七牛云上传的核心功能：

- ✅ 七牛云配置验证
- ✅ 上传令牌生成
- ✅ 文件上传到七牛云
- ✅ 访问URL生成
- ✅ 存储策略（qiniu/hybrid模式）
- ✅ 错误处理（无效凭证）

### 2. `qiniu-integration.test.ts` - 集成测试

测试完整的文件上传流程：

- ✅ 用户认证流程
- ✅ 单文件上传
- ✅ 多文件上传
- ✅ 文件列表获取
- ✅ 文件下载
- ✅ 文件删除
- ✅ 存储使用情况统计
- ✅ 错误处理（认证失败、无文件等）

### 3. `setup.ts` - 测试环境配置

配置测试环境和全局设置。

## 🔧 环境配置

### 1. 配置七牛云凭证

在运行测试前，需要在 `.env.test` 文件中配置七牛云凭证：

```env
# Qiniu Cloud Storage
QINIU_ACCESS_KEY=your_qiniu_access_key
QINIU_SECRET_KEY=your_qiniu_secret_key
QINIU_BUCKET=your_bucket_name
QINIU_DOMAIN=https://your-domain.com
QINIU_ZONE=Zone_z2
```

### 2. 存储模式配置

可以通过 `STORAGE_TYPE` 环境变量设置存储模式：

- `local`: 仅本地存储
- `qiniu`: 纯七牛云存储（所有文件都上传到云端）
- `hybrid`: 混合模式（大文件上传云端，小文件本地存储）

```env
# Storage configuration
STORAGE_TYPE=qiniu
BACKUP_THRESHOLD=10485760  # 10MB，hybrid模式的阈值
```

### 3. 获取七牛云凭证

1. 登录 [七牛云控制台](https://portal.qiniu.com/)
2. 访问"个人中心 > 密钥管理"获取 `AccessKey` 和 `SecretKey`
3. 在"对象存储 > 空间管理"创建或选择存储空间（Bucket）
4. 获取存储空间的CDN域名（Domain）

详细配置说明请参考项目根目录的 `QINIU_SETUP.md` 文件。

## 📦 安装依赖

```bash
# 安装测试依赖
npm install

# 或使用 pnpm
pnpm install
```

测试依赖包括：
- `jest`: 测试框架
- `ts-jest`: TypeScript支持
- `supertest`: HTTP请求测试
- `@types/jest`: Jest类型定义
- `@types/supertest`: Supertest类型定义

## 🚀 运行测试

### 运行所有测试

```bash
npm test
```

### 运行特定测试文件

```bash
# 运行单元测试
npm test qiniu-upload.test

# 运行集成测试
npm test qiniu-integration.test
```

### 监听模式（开发时使用）

```bash
npm run test:watch
```

### 生成测试覆盖率报告

```bash
npm run test:coverage
```

### 仅运行特定测试用例

```bash
# 运行包含特定关键词的测试
npm test -- -t "文件上传"
```

## 📊 测试覆盖范围

### 单元测试覆盖

| 功能模块 | 测试用例 | 状态 |
|---------|---------|------|
| 配置验证 | 七牛云凭证检查 | ✅ |
| 令牌生成 | 上传令牌生成 | ✅ |
| 文件上传 | 上传到七牛云 | ✅ |
| URL生成 | 访问URL构建 | ✅ |
| 存储策略 | qiniu模式 | ✅ |
| 存储策略 | hybrid模式 | ✅ |
| 错误处理 | 无效凭证 | ✅ |

### 集成测试覆盖

| 功能流程 | 测试用例 | 状态 |
|---------|---------|------|
| 用户认证 | 登录获取token | ✅ |
| 单文件上传 | 上传并获取元数据 | ✅ |
| 云存储验证 | 验证cloudUrl | ✅ |
| 文件列表 | 获取用户文件 | ✅ |
| 文件下载 | 下载已上传文件 | ✅ |
| 文件删除 | 删除文件 | ✅ |
| 多文件上传 | 批量上传 | ✅ |
| 存储统计 | 获取存储使用情况 | ✅ |
| 错误处理 | 无认证token | ✅ |
| 错误处理 | 无效token | ✅ |
| 错误处理 | 未上传文件 | ✅ |

## 🐛 常见问题

### 1. 测试失败：七牛云凭证未配置

**错误信息：**
```
⚠️ Qiniu credentials not configured, skipping tests
```

**解决方案：**
在 `.env.test` 文件中配置正确的七牛云凭证。

### 2. 测试超时

**错误信息：**
```
Timeout - Async callback was not invoked within the 5000 ms timeout
```

**解决方案：**
- 检查网络连接
- 确认七牛云服务可访问
- 测试已设置30秒超时，如需调整可修改 `jest.config.js`

### 3. 上传失败：statusCode !== 200

**可能原因：**
- AccessKey 或 SecretKey 不正确
- Bucket 名称错误
- 存储空间权限不足
- 网络连接问题

**解决方案：**
1. 验证七牛云凭证是否正确
2. 确认存储空间设置
3. 检查存储区域（Zone）配置是否匹配

### 4. cloudUrl 为 undefined

**可能原因：**
- 在 `local` 模式下运行测试
- 在 `hybrid` 模式下，文件大小未达到阈值
- 七牛云上传失败但本地保存成功

**解决方案：**
- 确认 `STORAGE_TYPE=qiniu` 或 `STORAGE_TYPE=hybrid`
- 如果是 hybrid 模式，确保测试文件大小超过 `BACKUP_THRESHOLD`

### 5. 测试文件清理失败

**警告信息：**
```
Failed to clean up test file
```

**说明：**
这通常不影响测试结果，只是清理操作失败。测试文件位于 `test-uploads` 目录，可以手动删除。

## 📝 测试最佳实践

### 1. 使用测试专用存储空间

建议为测试创建独立的七牛云存储空间，避免与生产数据混淆。

### 2. 定期清理测试文件

测试会在七牛云中创建文件（以 `test/` 为前缀），虽然测试完成后会自动清理，但建议定期检查并清理残留文件。

### 3. 监控存储使用量

频繁运行测试可能会产生一定的存储和流量费用，建议关注七牛云账户使用情况。

### 4. CI/CD 集成

在CI/CD环境中运行测试时，需要安全地配置环境变量：

```yaml
# GitHub Actions 示例
env:
  QINIU_ACCESS_KEY: ${{ secrets.QINIU_ACCESS_KEY }}
  QINIU_SECRET_KEY: ${{ secrets.QINIU_SECRET_KEY }}
  QINIU_BUCKET: ${{ secrets.QINIU_BUCKET }}
  QINIU_DOMAIN: ${{ secrets.QINIU_DOMAIN }}
```

## 🔍 调试测试

### 启用详细日志

测试会输出详细的日志信息，包括：
- ✅ 成功操作的确认信息
- ⚠️ 警告信息
- ❌ 错误信息

### 查看测试覆盖率

```bash
npm run test:coverage

# 在浏览器中查看详细报告
open coverage/lcov-report/index.html
```

## 🤝 贡献

如果发现测试问题或需要添加新的测试用例，请：

1. 创建 Issue 描述问题
2. 提交 Pull Request 并包含测试
3. 确保所有测试通过

## 📄 相关文档

- [七牛云配置指南](../QINIU_SETUP.md)
- [快速开始](../QUICKSTART.md)
- [部署指南](../DEPLOYMENT.md)
- [七牛云官方文档](https://developer.qiniu.com/)

## 📧 联系支持

如有问题，请通过以下方式联系：

- GitHub Issues: [创建Issue](https://github.com/papalqi/pc-utility-tool-electron-server/issues)
- 项目维护者: papalqi

---

**测试愉快！** 🎉
