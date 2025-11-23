# 七牛云上传测试运行脚本 (PowerShell)
# 此脚本帮助快速配置和运行七牛云上传测试

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  七牛云上传测试 - 快速启动" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查是否存在 .env.test 文件
if (-not (Test-Path ".env.test")) {
    Write-Host "❌ 未找到 .env.test 文件" -ForegroundColor Red
    Write-Host ""
    Write-Host "请先配置测试环境变量：" -ForegroundColor Yellow
    Write-Host "1. 复制 .env.test 文件（已创建模板）" -ForegroundColor Yellow
    Write-Host "2. 填写七牛云凭证：" -ForegroundColor Yellow
    Write-Host "   - QINIU_ACCESS_KEY" -ForegroundColor Yellow
    Write-Host "   - QINIU_SECRET_KEY" -ForegroundColor Yellow
    Write-Host "   - QINIU_BUCKET" -ForegroundColor Yellow
    Write-Host "   - QINIU_DOMAIN" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "获取凭证：https://portal.qiniu.com/user/key" -ForegroundColor Cyan
    exit 1
}

# 检查七牛云凭证是否配置
$envContent = Get-Content ".env.test" -Raw
if ($envContent -match "QINIU_ACCESS_KEY=\s*$" -or $envContent -match "QINIU_SECRET_KEY=\s*$") {
    Write-Host "⚠️  七牛云凭证未配置" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "请在 .env.test 文件中配置七牛云凭证" -ForegroundColor Yellow
    Write-Host "部分测试将会跳过" -ForegroundColor Yellow
    Write-Host ""
    
    $continue = Read-Host "是否继续运行测试？(y/n)"
    if ($continue -ne "y" -and $continue -ne "Y") {
        Write-Host "测试已取消" -ForegroundColor Red
        exit 0
    }
}

# 检查 node_modules
if (-not (Test-Path "node_modules")) {
    Write-Host "📦 安装依赖..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ 依赖安装失败" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ 依赖安装完成" -ForegroundColor Green
    Write-Host ""
}

# 显示测试选项
Write-Host "请选择测试类型：" -ForegroundColor Cyan
Write-Host "1. 运行所有测试" -ForegroundColor White
Write-Host "2. 仅运行单元测试 (qiniu-upload.test.ts)" -ForegroundColor White
Write-Host "3. 仅运行集成测试 (qiniu-integration.test.ts)" -ForegroundColor White
Write-Host "4. 运行测试并生成覆盖率报告" -ForegroundColor White
Write-Host "5. 监听模式（开发使用）" -ForegroundColor White
Write-Host ""

$choice = Read-Host "请输入选项 (1-5)"

Write-Host ""
Write-Host "🚀 开始运行测试..." -ForegroundColor Green
Write-Host ""

switch ($choice) {
    "1" {
        npm test
    }
    "2" {
        npm test -- qiniu-upload.test
    }
    "3" {
        npm test -- qiniu-integration.test
    }
    "4" {
        npm run test:coverage
        Write-Host ""
        Write-Host "📊 覆盖率报告已生成: coverage/lcov-report/index.html" -ForegroundColor Cyan
        
        $openReport = Read-Host "是否在浏览器中打开覆盖率报告？(y/n)"
        if ($openReport -eq "y" -or $openReport -eq "Y") {
            Start-Process "coverage/lcov-report/index.html"
        }
    }
    "5" {
        npm run test:watch
    }
    default {
        Write-Host "❌ 无效的选项" -ForegroundColor Red
        exit 1
    }
}

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  ✅ 测试完成！" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  ❌ 测试失败" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "查看详细文档: tests/README.md" -ForegroundColor Yellow
}
