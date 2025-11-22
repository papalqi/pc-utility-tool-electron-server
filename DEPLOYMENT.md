# 部署指南

本文档介绍如何将 PC Utility Tool Server 部署到生产环境，包括手动部署和自动化部署。

## 目录

- [方案一：GitHub Actions 自动部署](#方案一github-actions-自动部署)
- [方案二：手动部署](#方案二手动部署)
- [方案三：使用 PM2 管理](#方案三使用-pm2-管理)

---

## 方案一：GitHub Actions 自动部署

### 1. 配置 GitHub Secrets

在你的 GitHub 仓库中设置以下 Secrets（Settings → Secrets and variables → Actions）：

| Secret 名称 | 说明 | 示例 |
|------------|------|------|
| `SERVER_HOST` | 服务器 IP 地址或域名 | `192.168.1.100` |
| `SERVER_USER` | SSH 登录用户名 | `ubuntu` |
| `SERVER_SSH_KEY` | SSH 私钥（完整内容） | `-----BEGIN RSA PRIVATE KEY-----...` |
| `SERVER_PORT` | SSH 端口（可选） | `22` |

#### 如何生成 SSH 密钥

在你的服务器上运行：

```bash
# 生成密钥对
ssh-keygen -t rsa -b 4096 -C "github-actions"

# 将公钥添加到授权列表
cat ~/.ssh/id_rsa.pub >> ~/.ssh/authorized_keys

# 复制私钥内容（粘贴到 GitHub Secret）
cat ~/.ssh/id_rsa
```

### 2. 修改部署脚本路径

编辑 `.github/workflows/deploy.yml` 文件，修改第 37 行的路径：

```yaml
script: |
  cd /path/to/your/app  # 改为你的服务器上的实际路径
  git pull origin main
  npm ci
  npm run build
  pm2 restart pc-utility-tool-server || pm2 start npm --name "pc-utility-tool-server" -- start
```

### 3. 服务器准备

在服务器上克隆仓库并安装 PM2：

```bash
# 克隆代码
git clone git@github.com:papalqi/pc-utility-tool-electron-server.git
cd pc-utility-tool-electron-server

# 安装 PM2（推荐）
npm install -g pm2

# 首次部署
npm install
npm run build
pm2 start npm --name "pc-utility-tool-server" -- start
pm2 save
pm2 startup  # 设置开机自启
```

### 4. 推送代码自动部署

现在，每次你推送代码到 `main` 分支，GitHub Actions 会自动：

1. ✅ 在 GitHub 服务器上编译（CI 工作流）
2. ✅ SSH 连接到你的服务器
3. ✅ 拉取最新代码
4. ✅ 安装依赖
5. ✅ 编译项目
6. ✅ 重启服务

### 5. 查看部署状态

- GitHub 仓库的 **Actions** 标签页可以看到部署日志
- 服务器上运行 `pm2 logs pc-utility-tool-server` 查看应用日志

---

## 方案二：手动部署

### Linux/Mac 服务器

使用提供的部署脚本：

```bash
# 赋予执行权限
chmod +x deploy.sh

# 运行部署
./deploy.sh
```

部署脚本会自动：
1. 停止现有服务
2. 备份当前版本
3. 拉取最新代码
4. 安装依赖
5. 编译项目
6. 启动服务

如果部署失败，会自动回滚到备份版本。

### Windows 服务器

使用 PowerShell 部署脚本：

```powershell
# 运行部署
.\deploy.ps1
```

### 首次部署步骤

```bash
# 1. 克隆仓库
git clone git@github.com:papalqi/pc-utility-tool-electron-server.git
cd pc-utility-tool-electron-server

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 文件，修改配置

# 3. 运行部署脚本
./deploy.sh  # Linux/Mac
# 或
.\deploy.ps1  # Windows
```

---

## 方案三：使用 PM2 管理

PM2 是生产环境推荐的 Node.js 进程管理工具。

### 安装 PM2

```bash
npm install -g pm2
```

### 启动应用

```bash
# 编译项目
npm run build

# 启动
pm2 start npm --name "pc-utility-tool-server" -- start

# 保存进程列表
pm2 save

# 设置开机自启
pm2 startup
```

### 常用命令

```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs pc-utility-tool-server

# 重启
pm2 restart pc-utility-tool-server

# 停止
pm2 stop pc-utility-tool-server

# 删除
pm2 delete pc-utility-tool-server

# 监控
pm2 monit
```

### PM2 配置文件

创建 `ecosystem.config.js`：

```javascript
module.exports = {
  apps: [{
    name: 'pc-utility-tool-server',
    script: 'npm',
    args: 'start',
    cwd: '/path/to/your/app',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
```

使用配置文件启动：

```bash
pm2 start ecosystem.config.js
```

---

## 生产环境配置

### 1. 环境变量

确保 `.env` 文件配置正确：

```env
NODE_ENV=production
PORT=3000
JWT_SECRET=your-strong-random-secret-key-change-this
JWT_EXPIRES_IN=24h
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=104857600
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-password-change-this
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
CORS_ORIGIN=https://your-frontend-domain.com
```

### 2. 使用反向代理（Nginx）

推荐使用 Nginx 作为反向代理：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 重定向到 HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 3. 防火墙配置

```bash
# Ubuntu/Debian
sudo ufw allow 3000/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# CentOS/RHEL
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --permanent --add-port=80/tcp
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --reload
```

### 4. 日志管理

PM2 自动管理日志，默认位置：

```bash
~/.pm2/logs/pc-utility-tool-server-out.log  # 标准输出
~/.pm2/logs/pc-utility-tool-server-error.log  # 错误日志
```

查看日志：

```bash
pm2 logs pc-utility-tool-server --lines 100
```

---

## 故障排查

### 服务无法启动

```bash
# 查看详细日志
pm2 logs pc-utility-tool-server

# 检查端口占用
netstat -tulpn | grep 3000

# 手动启动测试
npm start
```

### 部署失败回滚

```bash
# 查看备份
ls backups/

# 手动回滚
cp -r backups/YYYYMMDD_HHMMSS/dist ./
pm2 restart pc-utility-tool-server
```

### 内存不足

```bash
# 增加 PM2 内存限制
pm2 start npm --name "pc-utility-tool-server" -- start --max-memory-restart 2G
```

---

## 监控和维护

### 1. 服务状态监控

访问：http://your-server:3000/status

### 2. PM2 监控

```bash
pm2 monit
```

### 3. 自动备份

添加到 crontab：

```bash
# 每天凌晨 2 点备份
0 2 * * * cd /path/to/app && tar -czf backup-$(date +\%Y\%m\%d).tar.gz dist/ data/ uploads/
```

### 4. 日志轮转

PM2 自带日志轮转：

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

---

## 安全建议

- ✅ 使用强密码和 JWT Secret
- ✅ 配置防火墙，仅开放必要端口
- ✅ 使用 HTTPS（Let's Encrypt 免费证书）
- ✅ 定期更新依赖包 `npm audit`
- ✅ 限制文件上传大小
- ✅ 配置 CORS 仅允许可信域名
- ✅ 定期备份数据和文件

---

## 相关链接

- [PM2 官方文档](https://pm2.keymetrics.io/)
- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [Nginx 配置指南](https://nginx.org/en/docs/)
