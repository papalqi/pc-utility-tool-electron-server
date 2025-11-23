# 开发模式启动脚本
# 直接调用 ts-node-dev 避免 npm scripts 问题

Write-Host "启动开发服务器..." -ForegroundColor Cyan
Write-Host ""

$APP_DIR = $PSScriptRoot
Set-Location $APP_DIR

# 检查依赖是否安装
if (-not (Test-Path "node_modules")) {
    Write-Host "⚠ 未找到依赖，正在安装..." -ForegroundColor Yellow
    npm install
    Write-Host ""
}

# 直接调用 ts-node-dev
if (Test-Path ".\node_modules\.bin\ts-node-dev.ps1") {
    Write-Host "✓ 启动开发服务器（支持热重载）" -ForegroundColor Green
    Write-Host "✓ 访问: http://localhost:3000" -ForegroundColor Green
    Write-Host "✓ 设置: http://localhost:3000/settings.html" -ForegroundColor Green
    Write-Host ""
    & ".\node_modules\.bin\ts-node-dev.ps1" --respawn --transpile-only src/index.ts
} else {
    Write-Host "✗ 未找到 ts-node-dev" -ForegroundColor Red
    Write-Host "请运行: npm install" -ForegroundColor Yellow
    exit 1
}
