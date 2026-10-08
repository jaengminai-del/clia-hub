# CLIA Content Hub — 배포 이미지 (Railway · Render · Google Cloud Run 등 Docker 지원 클라우드 공통)
#   Node.js 20 (서버·Puppeteer) + Python 3.12 (크롤러) + Chromium (Playwright·Puppeteer) 를 모두 설치한다.
#   API 키는 이미지에 넣지 않는다 — 클라우드 관리 화면의 환경 변수로 주입 (DEPLOY.md 참고).
FROM mcr.microsoft.com/playwright/python:v1.55.0-noble

# Node.js 20
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node 의존성 (Puppeteer 가 자체 Chrome 을 내려받음)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Python 크롤러 의존성 + Playwright Chromium (버전 정합)
COPY crawler-py/requirements.txt crawler-py/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r crawler-py/requirements.txt \
 && python3 -m playwright install chromium

# 앱 소스 + 크롤링 캐시
COPY . .
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3001 \
    CRAWLER_PYTHON=python3 \
    PYTHONIOENCODING=utf-8
EXPOSE 3001

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
