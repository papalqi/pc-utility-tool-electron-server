# Windows 服务器自动部署脚本
# 用于在 Windows 服务器上拉取最新代码并重启服务

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  开始自动部署 PC Utility Tool Server" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# 配置
$APP_NAME = "pc-utility-tool-server"
$BRANCH = "main"
$APP_DIR = $PSScriptRoot

Set-Location $APP_DIR

# 1. 停止服务
Write-Host "[1/6] 停止现有服务..." -ForegroundColor Yellow
try {
    Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -like "*$APP_DIR*"
    } | Stop-Process -Force
    Write-Host "✓ 服务已停止" -ForegroundColor Green
} catch {
    Write-Host "服务未运行" -ForegroundColor Gray
}
Write-Host ""

# 2. 备份当前版本
Write-Host "[2/6] 备份当前版本..." -ForegroundColor Yellow
$BACKUP_DIR = "backups\$(Get-Date -Format 'yyyyMMdd_HHmmss')"
New-Item -ItemType Directory -Path $BACKUP_DIR -Force | Out-Null
if (Test-Path "dist") {
    Copy-Item -Path "dist" -Destination $BACKUP_DIR -Recurse
    Write-Host "✓ 已备份到 $BACKUP_DIR" -ForegroundColor Green
} else {
    Write-Host "跳过备份（首次部署）" -ForegroundColor Cyan
}
Write-Host ""

# 3. 拉取最新代码
Write-Host "[3/6] 拉取最新代码..." -ForegroundColor Yellow
git fetch origin
git reset --hard "origin/$BRANCH"
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ 代码已更新到最新版本" -ForegroundColor Green
} else {
    Write-Host "✗ 代码拉取失败" -ForegroundColor Red
    exit 1
}
Write-Host ""

# 4. 安装依赖
Write-Host "[4/6] 安装依赖..." -ForegroundColor Yellow
npm ci
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ 依赖安装成功" -ForegroundColor Green
} else {
    Write-Host "✗ 依赖安装失败，正在回滚..." -ForegroundColor Red
    if (Test-Path "$BACKUP_DIR\dist") {
        Copy-Item -Path "$BACKUP_DIR\dist" -Destination "." -Recurse -Force
    }
    exit 1
}
Write-Host ""

# 5. 编译项目
Write-Host "[5/6] 编译项目..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ 编译成功" -ForegroundColor Green
} else {
    Write-Host "✗ 编译失败，正在回滚..." -ForegroundColor Red
    if (Test-Path "$BACKUP_DIR\dist") {
        Copy-Item -Path "$BACKUP_DIR\dist" -Destination "." -Recurse -Force
    }
    exit 1
}
Write-Host ""

# 6. 启动服务
Write-Host "[6/6] 启动服务..." -ForegroundColor Yellow
if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    # 使用 PM2
    pm2 start npm --name $APP_NAME -- start
    if ($LASTEXITCODE -ne 0) {
        pm2 restart $APP_NAME
    }
    pm2 save
    Write-Host "✓ 服务已通过 PM2 启动" -ForegroundColor Green
} else {
    # 使用后台进程
    Start-Process -FilePath "npm" -ArgumentList "start" -WindowStyle Hidden -WorkingDirectory $APP_DIR
    Write-Host "✓ 服务已在后台启动" -ForegroundColor Green
}
Write-Host ""

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  部署完成！" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "查看服务状态:" -ForegroundColor Yellow
if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    Write-Host "  pm2 status" -ForegroundColor White
    Write-Host "  pm2 logs $APP_NAME" -ForegroundColor White
} else {
    Write-Host "  访问 http://localhost:3000/status" -ForegroundColor White
}
Write-Host ""
Write-Host "访问服务:" -ForegroundColor Yellow
Write-Host "  http://your-server-ip:3000/status" -ForegroundColor White
Write-Host ""
