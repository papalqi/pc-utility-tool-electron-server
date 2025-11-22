#!/bin/bash
# 服务器端自动部署脚本
# 用于在服务器上拉取最新代码并重启服务

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
APP_DIR=$(cd "$(dirname "$0")" && pwd)
APP_NAME="pc-utility-tool-server"
BRANCH="main"

cd "$APP_DIR"

# 创建必要的目录
mkdir -p logs data uploads backups

# 检查并安装 PM2
echo -e "${YELLOW}检查 PM2...${NC}"
if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}PM2 未安装，正在安装...${NC}"
    npm install -g pm2
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ PM2 安装成功${NC}"
    else
        echo -e "${YELLOW}⚠ PM2 安装失败，将使用 nohup 方式运行${NC}"
    fi
else
    echo -e "${GREEN}✓ PM2 已安装 ($(pm2 --version))${NC}"
fi
echo ""

# 1. 停止服务
echo -e "${YELLOW}[1/6] 停止现有服务...${NC}"
if command -v pm2 &> /dev/null; then
    pm2 stop $APP_NAME 2>/dev/null || echo "服务未运行"
    pm2 delete $APP_NAME 2>/dev/null || true
    echo -e "${GREEN}✓ 已停止 PM2 服务${NC}"
else
    # 使用 PID 文件停止
    if [ -f "logs/app.pid" ]; then
        OLD_PID=$(cat logs/app.pid)
        kill $OLD_PID 2>/dev/null && echo -e "${GREEN}✓ 已停止进程 $OLD_PID${NC}" || echo "进程已停止"
        rm -f logs/app.pid
    else
        pkill -f "node dist/index.js" 2>/dev/null && echo -e "${GREEN}✓ 已停止服务${NC}" || echo "服务未运行"
    fi
fi
echo ""

# 2. 备份当前版本
echo -e "${YELLOW}[2/6] 备份当前版本...${NC}"
BACKUP_DIR="backups/$(date +%Y%m%d_%H%M%S)"
if [ -d "dist" ]; then
    mkdir -p "$BACKUP_DIR"
    cp -r dist "$BACKUP_DIR/"
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
if npm install; then
    echo -e "${GREEN}✓ 依赖安装成功${NC}"
else
    echo -e "${RED}✗ 依赖安装失败${NC}"
    if [ -d "$BACKUP_DIR/dist" ]; then
        echo -e "${YELLOW}正在回滚...${NC}"
        cp -r "$BACKUP_DIR/dist" ./
    fi
    exit 1
fi
echo ""

# 5. 编译项目
echo -e "${YELLOW}[5/6] 编译项目...${NC}"
if npm run build; then
    echo -e "${GREEN}✓ 编译成功${NC}"
else
    echo -e "${RED}✗ 编译失败${NC}"
    if [ -d "$BACKUP_DIR/dist" ]; then
        echo -e "${YELLOW}正在回滚...${NC}"
        cp -r "$BACKUP_DIR/dist" ./
    fi
    exit 1
fi
echo ""

# 6. 启动服务
echo -e "${YELLOW}[6/6] 启动服务...${NC}"
if command -v pm2 &> /dev/null; then
    # 使用 PM2
    pm2 start npm --name "$APP_NAME" -- start
    pm2 save
    sleep 3
    echo -e "${GREEN}✓ 服务已通过 PM2 启动${NC}"
    echo ""
    pm2 status "$APP_NAME"
else
    # 使用 nohup
    nohup npm start > logs/app.log 2>&1 &
    NEW_PID=$!
    echo "$NEW_PID" > logs/app.pid
    sleep 3
    
    if kill -0 $NEW_PID 2>/dev/null; then
        echo -e "${GREEN}✓ 服务已启动 (PID: $NEW_PID)${NC}"
    else
        echo -e "${RED}✗ 服务启动失败，查看日志：${NC}"
        tail -30 logs/app.log
        exit 1
    fi
fi
echo ""

echo -e "${CYAN}================================================${NC}"
echo -e "${GREEN}  部署完成！${NC}"
echo -e "${CYAN}================================================${NC}"
echo ""

# 测试服务
echo -e "${YELLOW}测试服务连接...${NC}"
sleep 2
if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 服务运行正常${NC}"
    echo ""
    echo -e "${YELLOW}访问地址：${NC}"
    echo "  - http://localhost:3000/status"
    
    # 尝试获取外网 IP
    PUBLIC_IP=$(curl -s --max-time 2 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    if [ -n "$PUBLIC_IP" ]; then
        echo "  - http://$PUBLIC_IP:3000/status"
    fi
else
    echo -e "${RED}✗ 服务未响应${NC}"
    echo -e "${YELLOW}查看日志：${NC}"
    if command -v pm2 &> /dev/null; then
        echo "  pm2 logs $APP_NAME"
    else
        echo "  tail -f logs/app.log"
    fi
fi

echo ""
echo -e "${YELLOW}常用命令：${NC}"
if command -v pm2 &> /dev/null; then
    echo "  pm2 status          # 查看状态"
    echo "  pm2 logs $APP_NAME  # 查看日志"
    echo "  pm2 restart $APP_NAME  # 重启服务"
    echo "  pm2 stop $APP_NAME  # 停止服务"
else
    echo "  tail -f logs/app.log  # 查看日志"
    echo "  cat logs/app.pid      # 查看进程ID"
    echo "  kill \$(cat logs/app.pid)  # 停止服务"
fi
echo ""
