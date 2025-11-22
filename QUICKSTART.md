# Quick Start Guide

## 一键安装（推荐）

### Windows (PowerShell)
```powershell
.\install.ps1
npm start
```

### Linux/Mac
```bash
chmod +x install.sh
./install.sh
npm start
```

安装脚本会自动：
- ✅ 检查 Node.js 和 npm
- ✅ 安装依赖
- ✅ 创建配置文件
- ✅ 编译 TypeScript

## 手动安装

```bash
# 1. Install dependencies
npm install

# 2. Copy configuration
cp .env.example .env

# 3. Build
npm run build

# 4. Start development server
npm run dev

# Server will start on http://localhost:3000
```

## 服务状态监控

安装完成后，访问以下地址查看服务器实时状态：

🖥️ **状态监控面板**: http://localhost:3000/status

监控内容包括：
- 服务器运行状态和运行时间
- 存储使用情况
- 用户统计
- 系统资源使用（CPU、内存）
- Node.js 进程信息

## Quick Test

```bash
# 1. Login (default admin account)
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# Response will include a token, use it in next requests
# Example token: eyJhbGci...

# 2. Upload a file
echo "Hello World" > sample.txt
curl -X POST http://localhost:3000/api/files/upload \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -F "file=@sample.txt"

# 3. List your files
curl http://localhost:3000/api/files \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"

# 4. Download a file (use file ID from list)
curl http://localhost:3000/api/files/FILE_ID \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -O -J

# 5. Check storage usage
curl http://localhost:3000/api/files/storage/usage \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## Default Credentials

- **Username**: `admin`
- **Password**: `admin123`

⚠️ **Change the password before deploying to production!**

## Production Deployment

```bash
# 1. Build
npm run build

# 2. Set environment variables
export NODE_ENV=production
export JWT_SECRET=your-strong-secret-key
export ADMIN_PASSWORD=new-secure-password

# 3. Start
npm start
```

## API Endpoints

### 认证
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login

### 文件管理
- `POST /api/files/upload` - Upload single file
- `POST /api/files/upload-multiple` - Upload multiple files
- `GET /api/files` - List all user files
- `GET /api/files/:id` - Download file
- `DELETE /api/files/:id` - Delete file
- `GET /api/files/storage/usage` - Get storage statistics

### 监控
- `GET /health` - Health check
- `GET /status` - Status monitoring web page
- `GET /api/status` - Status API (JSON)

See [README.md](README.md) for full documentation.
