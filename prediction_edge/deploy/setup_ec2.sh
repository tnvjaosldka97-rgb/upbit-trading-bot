#!/bin/bash
# AWS EC2 us-east-1 초기 세팅 스크립트
# Amazon Linux 2023 또는 Ubuntu 22.04 기준
# 실행: bash setup_ec2.sh

set -e

echo "=== Prediction Edge — EC2 Setup ==="

# 1. Docker 설치
if ! command -v docker &> /dev/null; then
    echo "[1/5] Docker 설치 중..."
    sudo yum update -y 2>/dev/null || sudo apt-get update -y
    sudo yum install -y docker 2>/dev/null || sudo apt-get install -y docker.io
    sudo systemctl enable docker
    sudo systemctl start docker
    sudo usermod -aG docker $USER
    echo "Docker 설치 완료"
else
    echo "[1/5] Docker 이미 설치됨"
fi

# 2. Docker Compose 설치
if ! command -v docker-compose &> /dev/null; then
    echo "[2/5] Docker Compose 설치 중..."
    sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
        -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    echo "Docker Compose 설치 완료"
else
    echo "[2/5] Docker Compose 이미 설치됨"
fi

# 3. Git 설치
if ! command -v git &> /dev/null; then
    echo "[3/5] Git 설치 중..."
    sudo yum install -y git 2>/dev/null || sudo apt-get install -y git
else
    echo "[3/5] Git 이미 설치됨"
fi

# 4. 프로젝트 클론 or 업데이트
REPO_DIR="$HOME/prediction_edge"
if [ -d "$REPO_DIR" ]; then
    echo "[4/5] 기존 repo 업데이트..."
    cd "$REPO_DIR"
    git pull
else
    echo "[4/5] Repo 클론 중..."
    echo "GitHub repo URL 입력: "
    read REPO_URL
    git clone "$REPO_URL" "$REPO_DIR"
    cd "$REPO_DIR"
fi

# 5. .env 확인
if [ ! -f ".env" ]; then
    echo "[5/5] .env 파일이 없습니다. 생성 중..."
    cp .env.example .env
    echo ""
    echo "========================================"
    echo "  .env 파일을 편집하세요:"
    echo "  nano $REPO_DIR/.env"
    echo "========================================"
else
    echo "[5/5] .env 파일 확인됨"
fi

echo ""
echo "=== 세팅 완료 ==="
echo ""
echo "다음 명령어로 시작:"
echo "  cd $REPO_DIR"
echo "  docker-compose up -d --build"
echo ""
echo "로그 확인:"
echo "  docker-compose logs -f"
echo ""
echo "대시보드 접속:"
echo "  http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):8080"
