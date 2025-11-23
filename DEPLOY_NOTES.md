# 部署注意事项

## ⚠️ 重要警告

**`deploy.ps1` 和 `deploy.sh` 脚本会执行 `git reset --hard`，这会丢弃所有未提交的本地修改！**

## 安全部署流程

### 1. 开发阶段（本地修改）

```powershell
# 直接运行开发服务器，无需部署脚本
npm run dev

# 或手动启动
.\node_modules\.bin\ts-node-dev.ps1 --respawn --transpile-only src/index.ts
```

### 2. 提交修改

```powershell
# 查看修改
git status

# 添加文件
git add .

# 提交
git commit -m "feat: 添加存储设置管理API"

# 推送到远程
git push origin main
```

### 3. 部署到服务器

```powershell
# 现在可以安全使用部署脚本
.\deploy.ps1
```

## 部署脚本做了什么

1. **停止服务** - 停止运行中的 Node.js 进程
2. **备份** - 备份 `dist` 目录
3. **重置代码** - ⚠️ `git reset --hard origin/main` （丢弃本地修改）
4. **安装依赖** - `npm ci`
5. **编译** - `npm run build`
6. **启动服务** - 使用 PM2 或后台进程

## npm scripts 在 PowerShell 中的问题

如果遇到 `'node' 不是内部或外部命令` 错误，使用以下方式运行：

```powershell
# 方式1：直接调用脚本
.\node_modules\.bin\ts-node-dev.ps1 --respawn --transpile-only src/index.ts

# 方式2：使用 npx
npx ts-node-dev --respawn --transpile-only src/index.ts

# 方式3：切换到 CMD
cmd
npm run dev
```

## 新增功能：存储设置管理

### API 端点

```
GET    /api/settings/storage        # 获取配置
PUT    /api/settings/storage        # 更新配置
POST   /api/settings/storage/test   # 测试配置
POST   /api/settings/restart         # 重启服务器
```

### 使用示例

```javascript
// 1. 登录
const loginRes = await fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' })
});
const { token } = (await loginRes.json()).data;

// 2. 获取配置
const configRes = await fetch('/api/settings/storage', {
  headers: { 'Authorization': `Bearer ${token}` }
});

// 3. 更新配置
await fetch('/api/settings/storage', {
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    storageType: 'hybrid',
    backupThreshold: 10485760
  })
});

// 4. 重启服务器
await fetch('/api/settings/restart', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
});
```

## 总结

- ✅ **开发时**：使用 `npm run dev` 或直接调用脚本
- ✅ **修改后**：先提交到 Git
- ✅ **部署时**：使用 `.\deploy.ps1`
- ⚠️ **不要**：在有未提交修改时运行部署脚本
