#!/bin/bash
# Fly.io 최초 배포 스크립트
set -e

APP_NAME="prediction-edge"

echo "=== Fly.io 배포 시작 ==="

# 1. 앱 생성 (이미 있으면 스킵)
fly apps create $APP_NAME --machines 2>/dev/null || echo "앱 이미 존재"

# 2. 볼륨 생성 (SQLite 영속 저장)
fly volumes create prediction_edge_data \
  --app $APP_NAME \
  --region iad \
  --size 3 2>/dev/null || echo "볼륨 이미 존재"

# 3. .env 파일에서 시크릿 자동 업로드
echo "시크릿 업로드 중..."
fly secrets import --app $APP_NAME < .env

# 4. 배포
echo "배포 중..."
fly deploy --app $APP_NAME --remote-only

echo ""
echo "=== 완료 ==="
echo "대시보드: https://$APP_NAME.fly.dev"
echo "로그: fly logs --app $APP_NAME"
