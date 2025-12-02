#!/bin/bash

# AIAT VS Code 扩展发布脚本
# 用法: ./scripts/publish.sh [选项]

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

# 默认选项
ONLY_VSIX=false

# 解析参数
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            echo "用法: ./scripts/publish.sh [选项]"
            echo "  -m, --only-vsix  只打包 VSIX，不发布到市场"
            echo "  -h, --help       显示帮助"
            exit 0
            ;;
        -m|--only-vsix)
            ONLY_VSIX=true
            shift
            ;;
        *)
            echo -e "${RED}未知选项: $1${NC}"
            exit 1
            ;;
    esac
done

# 获取版本号
VERSION=$(grep '"version"' package.json | sed 's/.*: "\(.*\)".*/\1/')

echo -e "${BLUE}🚀 AIAT 发布脚本${NC}"
echo "=================================================="
echo -e "${BLUE}📌 版本: v${VERSION}${NC}"
echo ""

# 1. 构建项目
echo -e "${BLUE}🔨 构建项目...${NC}"
npm run package
echo -e "${GREEN}✅ 构建成功${NC}"

# 2. 删除旧的 vsix 文件
rm -f "$ROOT_DIR"/*.vsix

# 3. 打包 VSIX
echo -e "${BLUE}📦 打包 VSIX...${NC}"
npx vsce package --no-dependencies -o "$ROOT_DIR"

VSIX_FILE="$ROOT_DIR/aiat-${VERSION}.vsix"
if [[ -f "$VSIX_FILE" ]]; then
    SIZE=$(du -h "$VSIX_FILE" | cut -f1)
    echo -e "${GREEN}✅ VSIX 打包成功: aiat-${VERSION}.vsix ($SIZE)${NC}"
else
    echo -e "${RED}❌ VSIX 打包失败${NC}"
    exit 1
fi

# 4. 发布到市场
if [[ "$ONLY_VSIX" == false ]]; then
    echo -e "${BLUE}🚀 发布到 VS Code 市场...${NC}"
    npx vsce publish
    echo -e "${GREEN}✅ 发布成功${NC}"
    echo -e "${BLUE}🔗 https://marketplace.visualstudio.com/items?itemName=weinaike.aiat${NC}"
else
    echo -e "${YELLOW}⏭️  跳过市场发布${NC}"
fi

echo ""
echo -e "${GREEN}🎉 完成！${NC}"
