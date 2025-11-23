# 七牛云代理下载功能说明

## 🎯 功能概述

服务器现在支持通过**中转代理**方式访问七牛云文件，无需配置CDN域名，提供更好的安全性和灵活性。

## ✨ 功能优势

### 1. **无需CDN域名配置**
- ❌ 之前：必须配置 `QINIU_DOMAIN` 才能访问文件
- ✅ 现在：即使不配置域名，服务器也能代理访问七牛云文件

### 2. **统一的访问接口**
```
客户端 → 服务器 (/api/files/:fileId) → 七牛云
```
客户端始终通过同一个API访问文件，无需关心文件存储位置。

### 3. **更好的安全性**
- ✅ 隐藏七牛云真实URL
- ✅ 不暴露CDN域名
- ✅ 统一的权限验证
- ✅ 防止文件链接泄露

### 4. **智能降级策略**
服务器会按优先级选择文件来源：
1. **本地文件**（最快）→ 直接返回
2. **七牛云文件**（代理）→ 从七牛云流式传输
3. **文件不存在** → 返回404错误

### 5. **访问统计和控制**
- ✅ 可以记录所有下载行为
- ✅ 可以实施流量控制
- ✅ 可以添加下载次数限制
- ✅ 可以做用户行为分析

---

## 🔧 工作原理

### 文件下载流程

```
┌─────────┐     GET /api/files/:fileId     ┌─────────┐
│ 客户端  │ ───────────────────────────────>│  服务器 │
└─────────┘                                 └─────────┘
                                                  │
                                            检查本地文件
                                                  │
                                    ┌─────────────┼─────────────┐
                                    │                           │
                              本地存在                     本地不存在
                                    │                           │
                                    ▼                           ▼
                            ┌──────────────┐          ┌──────────────┐
                            │  直接返回    │          │ 检查cloudUrl  │
                            │  本地文件    │          └──────────────┘
                            └──────────────┘                  │
                                                              │
                                                    ┌─────────┴─────────┐
                                                    │                   │
                                              有cloudUrl            无cloudUrl
                                                    │                   │
                                                    ▼                   ▼
                                          ┌──────────────┐      ┌────────┐
                                          │ 从七牛云代理  │      │ 返回404 │
                                          │  流式传输    │      └────────┘
                                          └──────────────┘
                                                    │
                                                    ▼
                                          ┌──────────────┐
                                          │  返回文件     │
                                          └──────────────┘
```

### 七牛云URL构建

当没有配置 `QINIU_DOMAIN` 时，系统会自动使用七牛云的源站域名：

```
格式: http://{bucket}.{zone}.qiniucs.com/{key}
示例: http://papalqiserver.z2.qiniucs.com/user123/file.txt
```

**Zone映射：**
- `Zone_z0` → `z0` (华东-浙江)
- `Zone_z1` → `z1` (华北-河北)
- `Zone_z2` → `z2` (华南-广东)
- `Zone_na0` → `na0` (北美)
- `Zone_as0` → `as0` (东南亚)

---

## 📝 配置说明

### 无需CDN域名（推荐）

`.env` 配置：
```env
STORAGE_TYPE=qiniu
QINIU_ACCESS_KEY=你的AccessKey
QINIU_SECRET_KEY=你的SecretKey
QINIU_BUCKET=你的存储空间
QINIU_DOMAIN=          # 留空，使用代理模式
QINIU_ZONE=Zone_z2
```

**优点：**
- ✅ 配置简单，无需申请域名
- ✅ 更安全，不暴露七牛云URL
- ✅ 统一API接口

**缺点：**
- ⚠️ 服务器带宽消耗增加
- ⚠️ 响应速度略慢（多一次转发）

### 使用CDN域名（可选）

`.env` 配置：
```env
STORAGE_TYPE=qiniu
QINIU_ACCESS_KEY=你的AccessKey
QINIU_SECRET_KEY=你的SecretKey
QINIU_BUCKET=你的存储空间
QINIU_DOMAIN=http://cdn.example.com  # 配置CDN域名
QINIU_ZONE=Zone_z2
```

**优点：**
- ✅ CDN加速，下载更快
- ✅ 节省服务器带宽

**缺点：**
- ⚠️ 需要配置和维护域名
- ⚠️ 暴露CDN URL结构

---

## 🚀 使用示例

### 客户端调用

```javascript
// 上传文件
const formData = new FormData();
formData.append('file', file);

const uploadResponse = await fetch('http://your-server:3000/api/files/upload', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  },
  body: formData
});

const { data } = await uploadResponse.json();
const fileId = data.id;

// 下载文件（服务器自动处理本地/云端）
const downloadUrl = `http://your-server:3000/api/files/${fileId}`;

// 方式1：直接下载
window.open(downloadUrl);

// 方式2：获取文件内容
const fileResponse = await fetch(downloadUrl, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
const blob = await fileResponse.blob();
```

### API响应示例

**上传响应：**
```json
{
  "success": true,
  "data": {
    "id": "file-uuid-123",
    "originalName": "example.pdf",
    "size": 1024000,
    "cloudUrl": "/user123/abc-def.pdf",  // 不是完整URL
    "uploadedAt": "2025-11-23T06:24:47.000Z"
  }
}
```

**注意：** `cloudUrl` 是相对路径，客户端不应直接使用，而是通过 `/api/files/:fileId` 下载。

---

## 🔍 日志输出

### 本地文件下载
```
[DEBUG] [FileRoutes] Serving file from local: example.pdf
```

### 代理下载
```
[INFO] [FileRoutes] Proxying file from Qiniu: example.pdf
[DEBUG] [FileRoutes] File proxied successfully: example.pdf
```

### 错误情况
```
[ERROR] [FileRoutes] Qiniu proxy failed with status 404
[ERROR] [FileRoutes] Failed to connect to cloud storage
```

---

## 🎯 性能优化建议

### 1. 使用CDN加速（生产环境推荐）

配置 `QINIU_DOMAIN` 使用CDN域名，直接让客户端访问CDN：

```typescript
// 修改返回给客户端的数据
if (metadata.cloudUrl && metadata.cloudUrl.startsWith('http')) {
  // 返回完整的CDN URL给客户端
  return {
    ...metadata,
    directUrl: metadata.cloudUrl  // 客户端可直接访问
  };
}
```

### 2. 实施缓存策略

```typescript
// 添加缓存头
res.setHeader('Cache-Control', 'public, max-age=31536000');
res.setHeader('ETag', metadata.hash);  // 如果有文件hash
```

### 3. 启用文件压缩

```typescript
import compression from 'compression';
app.use(compression());
```

### 4. 流量控制

```typescript
// 限制单个文件下载次数
const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15分钟
  max: 100  // 最多100次下载
});

router.get('/:fileId', downloadLimiter, async (req, res) => {
  // ...
});
```

---

## 🧪 测试

### 运行代理测试

```powershell
& "C:\Program Files\nodejs\node.exe" .\node_modules\jest\bin\jest.js qiniu-proxy.test
```

### 测试用例

- ✅ 上传文件到七牛云
- ✅ 通过服务器代理下载七牛云文件
- ✅ 删除本地文件后仍可通过代理下载
- ✅ URL构建方法测试

---

## 🔐 安全建议

### 1. 权限验证
当前已实现：
- ✅ 用户只能下载自己上传的文件
- ✅ 需要有效的JWT token

### 2. 防盗链（可选）
```typescript
// 检查Referer
if (req.get('referer') && !req.get('referer').includes('your-domain.com')) {
  return res.status(403).json({ error: 'Access denied' });
}
```

### 3. 签名URL（高级）
为七牛云URL添加时效性签名，防止链接泄露。

---

## 📊 监控和统计

### 添加下载统计

```typescript
// 在下载时记录
await logDownload({
  fileId,
  userId,
  source: fs.existsSync(filePath) ? 'local' : 'qiniu',
  timestamp: new Date()
});
```

### 带宽监控

```typescript
let totalBytes = 0;

proxyRes.on('data', (chunk) => {
  totalBytes += chunk.length;
});

proxyRes.on('end', () => {
  log.info(`Downloaded ${totalBytes} bytes from Qiniu`);
});
```

---

## ❓ 常见问题

### Q: 代理下载会不会很慢？
A: 会略慢于直接访问CDN，但在国内网络环境下差异不大。如果追求极致性能，建议配置CDN域名。

### Q: 服务器带宽够用吗？
A: 取决于文件大小和并发量。小文件（<10MB）通常没问题。大文件或高并发建议使用CDN。

### Q: 可以混合使用吗？
A: 可以！小文件通过服务器代理，大文件直接返回CDN URL给客户端。

### Q: 如何知道文件从哪里下载的？
A: 查看日志，会显示 "Serving file from local" 或 "Proxying file from Qiniu"。

---

## 🎉 总结

服务器代理功能让文件访问更加**简单**、**安全**、**灵活**：

- ✅ 无需配置CDN域名也能正常使用
- ✅ 隐藏七牛云真实URL，提升安全性
- ✅ 统一的API接口，简化客户端代码
- ✅ 智能降级，优先使用本地文件
- ✅ 流式传输，内存占用小

**推荐配置：**
- **开发/测试**: 不配置 `QINIU_DOMAIN`，使用代理模式
- **生产环境**: 配置CDN域名，获得最佳性能

---

**相关文档：**
- [七牛云配置指南](./QINIU_SETUP.md)
- [测试说明](./tests/README.md)
- [快速开始](./QUICKSTART.md)
