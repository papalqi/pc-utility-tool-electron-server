# PC Utility Tool Server - Windows 一键安装脚本
# PowerShell 脚本

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  PC Utility Tool Server - 一键安装" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# 检查 Node.js
Write-Host "[1/5] 检查 Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version
    Write-Host "✓ Node.js 已安装: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ 未检测到 Node.js，请先安装 Node.js (https://nodejs.org/)" -ForegroundColor Red
    exit 1
}

# 检查 npm
Write-Host "[2/5] 检查 npm..." -ForegroundColor Yellow
try {
    $npmVersion = npm --version
    Write-Host "✓ npm 已安装: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ 未检测到 npm" -ForegroundColor Red
    exit 1
}

# 安装依赖
Write-Host "[3/5] 安装依赖..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ 依赖安装成功" -ForegroundColor Green
} else {
    Write-Host "✗ 依赖安装失败" -ForegroundColor Red
    exit 1
}

# 创建 .env 文件
Write-Host "[4/5] 配置环境变量..." -ForegroundColor Yellow
if (-Not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "✓ 已创建 .env 文件" -ForegroundColor Green
    Write-Host "  请编辑 .env 文件修改配置（特别是修改默认密码）" -ForegroundColor Yellow
} else {
    Write-Host "✓ .env 文件已存在" -ForegroundColor Green
}

# 编译 TypeScript
Write-Host "[5/5] 编译 TypeScript..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ 编译成功" -ForegroundColor Green
} else {
    Write-Host "✗ 编译失败" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "启动服务器:" -ForegroundColor Yellow
Write-Host "  npm start" -ForegroundColor White
Write-Host ""
Write-Host "开发模式:" -ForegroundColor Yellow
Write-Host "  npm run dev" -ForegroundColor White
Write-Host ""
Write-Host "服务状态监控:" -ForegroundColor Yellow
Write-Host "  http://localhost:3000/status" -ForegroundColor White
Write-Host ""
Write-Host "⚠️  重要提示:" -ForegroundColor Red
Write-Host "  1. 请修改 .env 文件中的默认密码" -ForegroundColor Yellow
Write-Host "  2. 请修改 JWT_SECRET 为随机字符串" -ForegroundColor Yellow
Write-Host "  3. 生产环境请使用 HTTPS" -ForegroundColor Yellow
Write-Host ""
