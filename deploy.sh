#!/bin/bash
# 服务器端自动部署脚本
# 用于在服务器上拉取最新代码并重启服务

set -e  # 遇到错误立即退出

echo "================================================"
echo "  开始自动部署 PC Utility Tool Server"
echo "================================================"
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 配置
APP_DIR=$(dirname $(readlink -f $0))
APP_NAME="pc-utility-tool-server"
BRANCH="main"

cd $APP_DIR

# 1. 停止服务
echo -e "${YELLOW}[1/6] 停止现有服务...${NC}"
if command -v pm2 &> /dev/null; then
    pm2 stop $APP_NAME || echo "服务未运行"
else
    pkill -f "node dist/index.js" || echo "服务未运行"
fi
echo -e "${GREEN}✓ 服务已停止${NC}"
echo ""

# 2. 备份当前版本
echo -e "${YELLOW}[2/6] 备份当前版本...${NC}"
BACKUP_DIR="backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p $BACKUP_DIR
if [ -d "dist" ]; then
    cp -r dist $BACKUP_DIR/
    echo -e "${GREEN}✓ 已备份到 $BACKUP_DIR${NC}"
else
    echo -e "${CYAN}跳过备份（首次部署）${NC}"
fi
echo ""

# 3. 拉取最新代码
echo -e "${YELLOW}[3/6] 拉取最新代码...${NC}"
git fetch origin
git reset --hard origin/$BRANCH
echo -e "${GREEN}✓ 代码已更新到最新版本${NC}"
echo ""

# 4. 安装依赖
echo -e "${YELLOW}[4/6] 安装依赖...${NC}"
npm ci
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 依赖安装成功${NC}"
else
    echo -e "${RED}✗ 依赖安装失败，正在回滚...${NC}"
    if [ -d "$BACKUP_DIR/dist" ]; then
        cp -r $BACKUP_DIR/dist ./
    fi
    exit 1
fi
echo ""

# 5. 编译项目
echo -e "${YELLOW}[5/6] 编译项目...${NC}"
npm run build
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 编译成功${NC}"
else
    echo -e "${RED}✗ 编译失败，正在回滚...${NC}"
    if [ -d "$BACKUP_DIR/dist" ]; then
        cp -r $BACKUP_DIR/dist ./
    fi
    exit 1
fi
echo ""

# 6. 启动服务
echo -e "${YELLOW}[6/6] 启动服务...${NC}"
if command -v pm2 &> /dev/null; then
    # 使用 PM2
    pm2 start npm --name $APP_NAME -- start || pm2 restart $APP_NAME
    pm2 save
    echo -e "${GREEN}✓ 服务已通过 PM2 启动${NC}"
else
    # 使用 nohup
    nohup npm start > logs/app.log 2>&1 &
    echo -e "${GREEN}✓ 服务已在后台启动${NC}"
fi
echo ""

echo -e "${CYAN}================================================${NC}"
echo -e "${GREEN}  部署完成！${NC}"
echo -e "${CYAN}================================================${NC}"
echo ""
echo -e "${YELLOW}查看服务状态:${NC}"
if command -v pm2 &> /dev/null; then
    echo "  pm2 status"
    echo "  pm2 logs $APP_NAME"
else
    echo "  tail -f logs/app.log"
fi
echo ""
echo -e "${YELLOW}访问服务:${NC}"
echo "  http://your-server-ip:3000/status"
echo ""
