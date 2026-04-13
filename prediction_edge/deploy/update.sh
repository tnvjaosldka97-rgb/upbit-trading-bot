#!/bin/bash
# 코드 업데이트 + 재시작 (30초 다운타임)
set -e

cd ~/prediction_edge

echo "=== Pulling latest code ==="
git pull

echo "=== Rebuilding and restarting ==="
docker-compose down
docker-compose up -d --build

echo "=== Done. Logs: ==="
docker-compose logs --tail=30 -f
