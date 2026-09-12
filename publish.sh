#!/usr/bin/env bash
# 把本地监控产出的状态发布到 Vercel（以静态文件形式），让公众号接口秒回
set -e
SRC="$HOME/.hermes/codex-reset-status.json"
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SRC" ] || { echo "[publish] 找不到 $SRC（先跑一次监控）"; exit 1; }
cp "$SRC" "$DIR/public/status.json"
cd "$DIR"
git add -A
if git diff --cached --quiet; then echo "[publish] 状态无变化，跳过"; exit 0; fi
git -c user.email=bot@local -c user.name=codex-bot \
    commit -q -m "chore: update codex reset status $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -q
echo "[publish] 已推送到远端，Vercel 会自动重新部署"
