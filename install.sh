#!/bin/bash
# PC Utility Tool Server - Linux/Mac 一键安装脚本

echo "================================================"
echo "  PC Utility Tool Server - 一键安装"
echo "================================================"
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 检查 Node.js
echo -e "${YELLOW}[1/5] 检查 Node.js...${NC}"
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✓ Node.js 已安装: $NODE_VERSION${NC}"
else
    echo -e "${RED}✗ 未检测到 Node.js，请先安装 Node.js (https://nodejs.org/)${NC}"
    exit 1
fi

# 检查 npm
echo -e "${YELLOW}[2/5] 检查 npm...${NC}"
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    echo -e "${GREEN}✓ npm 已安装: $NPM_VERSION${NC}"
else
    echo -e "${RED}✗ 未检测到 npm${NC}"
    exit 1
fi

# 安装依赖
echo -e "${YELLOW}[3/5] 安装依赖...${NC}"
npm install
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 依赖安装成功${NC}"
else
    echo -e "${RED}✗ 依赖安装失败${NC}"
    exit 1
fi

# 创建 .env 文件
echo -e "${YELLOW}[4/5] 配置环境变量...${NC}"
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo -e "${GREEN}✓ 已创建 .env 文件${NC}"
    echo -e "${YELLOW}  请编辑 .env 文件修改配置（特别是修改默认密码）${NC}"
else
    echo -e "${GREEN}✓ .env 文件已存在${NC}"
fi

# 编译 TypeScript
echo -e "${YELLOW}[5/5] 编译 TypeScript...${NC}"
npm run build
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 编译成功${NC}"
else
    echo -e "${RED}✗ 编译失败${NC}"
    exit 1
fi

echo ""
echo -e "${CYAN}================================================${NC}"
echo -e "${GREEN}  安装完成！${NC}"
echo -e "${CYAN}================================================${NC}"
echo ""
echo -e "${YELLOW}启动服务器:${NC}"
echo "  npm start"
echo ""
echo -e "${YELLOW}开发模式:${NC}"
echo "  npm run dev"
echo ""
echo -e "${YELLOW}服务状态监控:${NC}"
echo "  http://localhost:3000/status"
echo ""
echo -e "${RED}⚠️  重要提示:${NC}"
echo -e "${YELLOW}  1. 请修改 .env 文件中的默认密码${NC}"
echo -e "${YELLOW}  2. 请修改 JWT_SECRET 为随机字符串${NC}"
echo -e "${YELLOW}  3. 生产环境请使用 HTTPS${NC}"
echo ""
