#!/usr/bin/env bash
# 在部署目录中初始化 OpenTogetherTube 部署文件：compose.yml、backup.sh、.env（随机密钥）。
# 已有 .env 时拒绝覆盖。用法：bash deploy/init.sh [部署目录]（默认当前目录）
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-.}"
cd "$target"

cp -n "$here/next-compose.yml" compose.yml
cp -n "$here/next-backup.sh" backup.sh
chmod 700 backup.sh

if [ -e .env ]; then
	echo ".env 已存在，未覆盖。如需重新生成请先自行移走旧文件。" >&2
	exit 1
fi

postgres_password="$(openssl rand -hex 32)"
session_secret="$(openssl rand -hex 48)"
admin_api_key="$(openssl rand -hex 32)"
(
	umask 077
	sed \
		-e "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$postgres_password/" \
		-e "s/^SESSION_SECRET=$/SESSION_SECRET=$session_secret/" \
		-e "s/^ADMIN_API_KEY=$/ADMIN_API_KEY=$admin_api_key/" \
		"$here/.env.example" > .env
)

echo "已生成 compose.yml、backup.sh、.env。"
echo "下一步：编辑 .env 把 OTT_PUBLIC_HOSTNAME 设为 YOUR_HOST:8080，然后运行："
echo "  sudo docker compose up -d   # 自动拉取镜像、执行迁移并启动"
