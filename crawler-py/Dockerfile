# CLIA Crawler API — Playwright 공식 파이썬 이미지 (Chromium 사전 설치)
FROM mcr.microsoft.com/playwright/python:v1.55.0-jammy

WORKDIR /app

# 의존성 먼저 (레이어 캐시)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Playwright 브라우저 (베이스 이미지에 포함돼 있지만 버전 정합 보장)
RUN playwright install chromium

# 앱 소스 (out/·.venv·__pycache__ 는 .dockerignore 로 제외)
COPY . .

# 산출물 캐시 디렉터리 (Render Disk 마운트 대상)
RUN mkdir -p /app/out

ENV PORT=8080
EXPOSE 8080

# uvicorn 기동 (PORT 환경변수 존중)
CMD ["sh", "-c", "uvicorn api:app --host 0.0.0.0 --port ${PORT:-8080}"]
