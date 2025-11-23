# 七牛云存储配置指南

## 📦 存储策略

系统支持三种存储策略，可通过网页配置或 `.env` 文件配置：

### 1. 本地存储 (local)
- **特点**：所有文件仅存储在本地服务器
- **适用场景**：小规模部署、内网环境
- **优点**：配置简单，无需云服务
- **缺点**：受服务器磁盘限制，无CDN加速

### 2. 七牛云存储 (qiniu)
- **特点**：文件直接上传到七牛云，本地不保留
- **适用场景**：需要CDN加速、多地访问
- **优点**：CDN加速、不占用本地空间
- **缺点**：依赖网络、产生存储和流量费用

### 3. 混合模式 (hybrid) ⭐ **推荐**
- **特点**：本地存储 + 大文件自动备份到七牛云
- **适用场景**：兼顾性能和成本
- **优点**：
  - 小文件快速访问（本地）
  - 大文件CDN加速（七牛云）
  - 双重备份更安全
- **配置项**：`BACKUP_THRESHOLD`（默认10MB）

## 🚀 快速配置

### 方式一：网页配置（推荐）

1. 访问 `http://your-server:3000/settings.html`
2. 登录管理员账号
3. 配置存储设置：
   - 选择存储类型
   - 填写七牛云凭证（如需要）
   - 设置备份阈值
4. 点击"保存配置"
5. 点击"重启服务器"使配置生效

### 方式二：环境变量配置

编辑 `.env` 文件：

```bash
# 存储策略
STORAGE_TYPE=hybrid

# 七牛云凭证（从七牛云控制台获取）
QINIU_ACCESS_KEY=your-access-key
QINIU_SECRET_KEY=your-secret-key
QINIU_BUCKET=your-bucket-name
QINIU_DOMAIN=http://your-cdn-domain.com
QINIU_ZONE=Zone_z2

# 混合模式配置
BACKUP_THRESHOLD=10485760  # 10MB，大于此大小的文件会备份到云端
```

## 📝 七牛云准备工作

### 1. 注册七牛云账号
访问 [https://portal.qiniu.com/signup](https://portal.qiniu.com/signup)

### 2. 创建存储空间 (Bucket)
1. 进入"对象存储" → "空间管理"
2. 点击"新建空间"
3. 填写空间名称（如：`my-files`）
4. 选择区域（Zone）
5. 设置访问权限：
   - **私有**：需要鉴权访问
   - **公开**：任何人可访问

### 3. 配置CDN域名
1. 进入空间设置 → "域名管理"
2. 绑定自定义域名或使用测试域名
3. 记录域名：`http://your-cdn-domain.com`

### 4. 获取密钥
1. 进入"个人中心" → "密钥管理"
2. 记录 `AccessKey` 和 `SecretKey`

### 5. 选择存储区域

| Zone值 | 区域 | 说明 |
|--------|------|------|
| `Zone_z0` | 华东 | 江苏、上海、浙江等 |
| `Zone_z1` | 华北 | 北京、河北、天津等 |
| `Zone_z2` | 华南 | 广东、广西等 |
| `Zone_na0` | 北美 | 美国、加拿大 |
| `Zone_as0` | 东南亚 | 新加坡等 |

## 💡 使用示例

### 示例1：纯本地存储
```bash
STORAGE_TYPE=local
# 无需七牛云配置
```

### 示例2：纯七牛云存储
```bash
STORAGE_TYPE=qiniu
QINIU_ACCESS_KEY=Ov7W2L0fM8R3X...
QINIU_SECRET_KEY=6yU9kP1mN4bT...
QINIU_BUCKET=my-cloud-storage
QINIU_DOMAIN=http://cdn.example.com
QINIU_ZONE=Zone_z2
```

### 示例3：混合模式（推荐）
```bash
STORAGE_TYPE=hybrid
BACKUP_THRESHOLD=10485760  # 10MB

# 小于10MB：本地存储
# 大于10MB：本地 + 七牛云备份

QINIU_ACCESS_KEY=Ov7W2L0fM8R3X...
QINIU_SECRET_KEY=6yU9kP1mN4bT...
QINIU_BUCKET=my-cloud-storage
QINIU_DOMAIN=http://cdn.example.com
QINIU_ZONE=Zone_z2
```

## 🔍 工作流程

### Local模式
```
用户上传 → 本地服务器 → 完成
```

### Qiniu模式
```
用户上传 → 本地临时文件 → 七牛云 → 删除临时文件 → 完成
```

### Hybrid模式
```
用户上传 → 判断文件大小
  ├─ 小文件（<阈值） → 本地存储 → 完成
  └─ 大文件（≥阈值） → 本地存储 + 七牛云备份 → 完成
```

## 📊 文件访问

### 本地文件
```
GET /api/files/:fileId
→ 直接从本地读取并下载
```

### 七牛云文件
```
GET /api/files/:fileId
→ 重定向到 CDN URL: http://cdn.example.com/userId/filename.ext
```

### 混合模式文件
```
GET /api/files/:fileId
→ 优先从本地读取
→ 如果有cloudUrl，也可以从CDN访问
```

## 🛡️ 安全建议

1. **密钥保护**
   - 不要提交 `.env` 到 Git
   - 使用环境变量或密钥管理服务
   - 定期轮换密钥

2. **访问控制**
   - 私有空间：适合敏感文件
   - 公开空间：适合公共资源
   - 使用七牛云的防盗链功能

3. **费用控制**
   - 设置合理的 `BACKUP_THRESHOLD`
   - 监控存储和流量使用
   - 启用七牛云的流量封顶

## 💰 成本优化

### 混合模式推荐配置

```bash
# 小图片、文档：本地存储（快速访问）
# 大视频、压缩包：云端备份（节省空间）

BACKUP_THRESHOLD=10485760  # 10MB

# 成本估算（按1000个用户，平均每人100MB）
# - 本地：小文件 ~50GB（免费）
# - 七牛云：大文件 ~50GB（约￥3/月）
# - 流量：10GB/月（约￥10/月）
# 总计：约￥13/月
```

## 🔧 故障排除

### 问题1：上传到七牛云失败
```
检查：
1. AccessKey 和 SecretKey 是否正确
2. Bucket 名称是否正确
3. Zone 配置是否匹配
4. 网络是否可以访问七牛云
```

### 问题2：无法通过CDN访问
```
检查：
1. 域名是否已绑定并解析
2. 域名配置是否正确（带http://或https://）
3. 空间权限是否为公开
4. 文件路径格式：userId/filename
```

### 问题3：配置修改不生效
```
解决：
1. 网页配置后点击"重启服务器"
2. 或手动重启：pm2 restart pc-utility-tool-server
3. 检查日志确认配置已加载
```

## 📈 监控

### 查看存储状态
访问 `http://your-server:3000/status` 查看：
- 存储模式
- 文件统计
- 存储使用量

### 日志查看
```bash
# PM2日志
pm2 logs pc-utility-tool-server

# 查找七牛云相关日志
pm2 logs | grep Qiniu
```

### 关键日志示例
```
[INFO] [FileService] File service initialized with hybrid storage mode
[INFO] [FileService] Qiniu cloud storage configured
[INFO] [FileService] File uploaded to Qiniu: document.pdf (15728640 bytes)
[INFO] [FileService] File saved: document.pdf for user xxx (local + cloud: http://cdn.example.com/xxx/document.pdf)
```

## 🎯 最佳实践

1. **开发环境**：使用 `local` 模式
2. **生产环境**：使用 `hybrid` 模式
3. **高流量场景**：使用 `qiniu` 模式
4. **备份阈值**：根据实际情况调整（建议5-20MB）
5. **定期备份**：重要文件建议同时保留本地和云端副本

## 📚 相关文档

- [七牛云官方文档](https://developer.qiniu.com/)
- [七牛云SDK文档](https://developer.qiniu.com/kodo/sdk/nodejs)
- [API使用文档](./API_USAGE.md)

## 🆘 获取帮助

- 查看服务器日志
- 访问七牛云工单系统
- 检查网络连接和防火墙设置
