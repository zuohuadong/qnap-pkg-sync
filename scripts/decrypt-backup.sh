#!/bin/bash

# Decrypt Config Backup
#
# 用于解密从 GitHub Actions Artifacts 下载的配置文件备份
#
# 使用方法:
#   1. 从 GitHub Actions 下载加密的备份:
#      gh run download <run-id> -n config-backup-encrypted-<run-id>
#
#   2. 设置解密密码:
#      export ENCRYPTION_PASSWORD="your-password"
#
#   3. 运行此脚本:
#      ./scripts/decrypt-backup.sh config-backup.tar.gz.enc

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check arguments
if [ $# -eq 0 ]; then
    echo -e "${RED}❌ Error: No encrypted file specified${NC}"
    echo ""
    echo "Usage:"
    echo "  export ENCRYPTION_PASSWORD=\"your-password\""
    echo "  $0 config-backup.tar.gz.enc"
    exit 1
fi

ENCRYPTED_FILE="$1"

# Check if file exists
if [ ! -f "$ENCRYPTED_FILE" ]; then
    echo -e "${RED}❌ Error: File not found: $ENCRYPTED_FILE${NC}"
    exit 1
fi

# Check if password is set
if [ -z "$ENCRYPTION_PASSWORD" ]; then
    echo -e "${RED}❌ Error: ENCRYPTION_PASSWORD environment variable not set${NC}"
    echo ""
    echo "Please set the password:"
    echo "  export ENCRYPTION_PASSWORD=\"your-password\""
    exit 1
fi

# Get output filename
OUTPUT_FILE="${ENCRYPTED_FILE%.enc}"

echo -e "${YELLOW}🔓 Decrypting backup...${NC}"
echo "  Input:  $ENCRYPTED_FILE"
echo "  Output: $OUTPUT_FILE"
echo ""

# Decrypt
if openssl enc -aes-256-cbc -d -pbkdf2 \
    -in "$ENCRYPTED_FILE" \
    -out "$OUTPUT_FILE" \
    -pass env:ENCRYPTION_PASSWORD; then

    echo -e "${GREEN}✅ Decryption successful${NC}"
    echo ""

    # Extract if it's a tar.gz
    if [[ "$OUTPUT_FILE" == *.tar.gz ]]; then
        echo -e "${YELLOW}📂 Extracting archive...${NC}"
        tar -xzf "$OUTPUT_FILE"
        echo -e "${GREEN}✅ Extraction complete${NC}"
        echo ""
        echo "Config files restored:"
        ls -lh config/ 2>/dev/null || echo "  (config directory not found)"
    fi

else
    echo -e "${RED}❌ Decryption failed${NC}"
    echo "  Please check your password"
    exit 1
fi
