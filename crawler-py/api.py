# -*- coding: utf-8 -*-
"""
api.py — CLIA Crawler FastAPI 마이크로서비스

pdp_pipeline.py 파이프라인을 REST + SSE API로 노출한다.
Playwright(sync) / Gemini / 전역 상태 이슈를 피하려 파이프라인은
독립 서브프로세스로 실행하고, out/<slug>/progress.json · mirror.json 을
읽어 Job 상태/결과를 제공한다.

엔드포인트 (API Integration Specification 준수):
  POST /api/v1/crawl              → 202 { job_id }        (비동기 작업 등록)
  GET  /api/v1/jobs/{job_id}      → 상태/결과 (진행중 200 / 완료 200)
  GET  /api/v1/jobs/{job_id}/stream → SSE 실시간 진행률
  GET  /healthz                   → 헬스체크

키 전략(하이브리드): 헤더 X-Gemini-API-Key 있으면 우선(BYOK),
없으면 서버 마스터 키(.env GEMINI_API_KEY).

실행: ./.venv/bin/uvicorn api:app --host 0.0.0.0 --port 8080
"""
import asyncio
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Dict, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "out"
# 로컬은 venv 파이썬, 도커/배포는 시스템 파이썬(PATH) 사용
_venv_py = ROOT / ".venv" / "bin" / "python"
PY = str(_venv_py) if _venv_py.exists() else sys.executable
PIPELINE = str(ROOT / "pdp_pipeline.py")
# .env 는 로컬 개발용 (배포 시엔 컨테이너 환경변수 사용)
load_dotenv(ROOT.parent / ".env")
load_dotenv(ROOT / ".env")  # crawler-py/.env 도 허용

# 공유 배포용 인증: CLIA_API_TOKEN 설정 시 Bearer 토큰 필수.
# 미설정(로컬 개발) 시 인증 생략.
API_TOKEN = os.getenv("CLIA_API_TOKEN", "").strip()

app = FastAPI(title="CLIA Crawler API", version="1.0.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


def require_auth(authorization: Optional[str] = Header(default=None)):
    """CLIA_API_TOKEN 이 설정돼 있으면 Authorization: Bearer <token> 강제."""
    if not API_TOKEN:
        return
    if authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="invalid or missing api token")


# job_id → 작업 메타 (인메모리; 재시작 시 산출물 파일이 진실 소스)
JOBS: Dict[str, dict] = {}


def slugify(url: str) -> str:
    return re.sub(r"-+$", "", re.sub(r"[^\w]+", "-", re.sub(r"https?://", "", url)))


def read_json(fp: Path) -> Optional[dict]:
    try:
        return json.loads(fp.read_text(encoding="utf-8"))
    except Exception:
        return None


# ── 요청/응답 모델 ──────────────────────────────────────────────
class CrawlRequest(BaseModel):
    url: str = Field(..., description="분석할 LG.com PDP URL")
    force_refresh: bool = Field(False, description="캐시 무시하고 재크롤")
    use_pro_model: bool = Field(False, description="Gemini 2.5 Pro 사용 (기본 Flash)")


# ── 파이프라인 서브프로세스 기동 ─────────────────────────────────
def launch_pipeline(job_id: str, url: str, use_pro: bool, gemini_key: Optional[str]):
    slug = slugify(url)
    out = OUT_DIR / slug
    out.mkdir(parents=True, exist_ok=True)
    # 새 작업의 진행률 파일 초기화 (이전 캐시 progress 오인 방지)
    (out / "progress.json").write_text(
        json.dumps({"percent": 0, "message": "작업 대기열 등록됨", "updated_at": time.time()}),
        encoding="utf-8",
    )

    cmd = [PY, PIPELINE, url, "--cache"]  # --cache: 원crawl/스크린샷 재사용(있으면)
    if use_pro:
        cmd.append("--pro")

    env = os.environ.copy()
    if gemini_key:                      # BYOK: 클라이언트 키 우선 주입
        env["GEMINI_API_KEY"] = gemini_key

    log_fp = open(out / "pipeline.log", "w", encoding="utf-8")
    proc = subprocess.Popen(cmd, cwd=str(ROOT), env=env, stdout=log_fp, stderr=subprocess.STDOUT)
    JOBS[job_id].update({"pid": proc.pid, "proc": proc, "slug": slug, "out": out})


def job_snapshot(job_id: str) -> dict:
    """산출물 파일을 진실 소스로 삼아 현재 Job 상태를 계산."""
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    out: Path = job["out"]
    mirror_fp = out / "mirror.json"
    prog = read_json(out / "progress.json") or {"percent": 0, "message": ""}
    proc = job.get("proc")
    alive = proc is not None and proc.poll() is None

    # 완료: mirror.json 이 이번 작업 시작 이후 생성됨
    if mirror_fp.exists() and mirror_fp.stat().st_mtime >= job["started_at"] - 1:
        mirror = read_json(mirror_fp) or {}
        qa = read_json(out / "qa_report.json")
        return {
            "job_id": job_id, "status": "completed", "progress_percent": 100,
            "completed_at": mirror_fp.stat().st_mtime,
            "result": {**mirror, "_qa": qa},
        }
    # 프로세스 종료됐는데 결과 없음 → 실패
    if proc is not None and not alive:
        tail = ""
        try:
            tail = (out / "pipeline.log").read_text(encoding="utf-8")[-500:]
        except Exception:
            pass
        return {"job_id": job_id, "status": "failed", "progress_percent": prog.get("percent", 0),
                "error": tail or "pipeline exited without result"}
    # 진행 중
    return {
        "job_id": job_id, "status": "processing",
        "progress_percent": prog.get("percent", 0),
        "log_message": prog.get("message", ""),
        "updated_at": prog.get("updated_at"),
    }


# ── 엔드포인트 ──────────────────────────────────────────────────
@app.get("/healthz")
def healthz():
    return {"ok": True, "master_key": bool(os.getenv("GEMINI_API_KEY")),
            "firecrawl": bool(os.getenv("FIRECRAWL_API_KEY"))}


@app.post("/api/v1/crawl", status_code=202)
def crawl(req: CrawlRequest, x_gemini_api_key: Optional[str] = Header(default=None),
          _auth: None = Depends(require_auth)):
    if not req.url.startswith("http"):
        raise HTTPException(status_code=400, detail="valid url required")
    slug = slugify(req.url)
    out = OUT_DIR / slug
    mirror_fp = out / "mirror.json"

    # 캐시 우선: 이미 분석된 URL 이면 즉시 완료 응답 (레이턴시 0)
    if mirror_fp.exists() and not req.force_refresh:
        job_id = "cached_" + uuid.uuid4().hex[:12]
        JOBS[job_id] = {"url": req.url, "slug": slug, "out": out,
                        "started_at": 0, "proc": None}
        return {"job_id": job_id, "status": "completed", "cached": True,
                "message": "기분석 캐시 존재 — /api/v1/jobs/{job_id} 로 결과 조회",
                "estimated_duration_seconds": 0}

    # force_refresh: 이전 산출물 제거 후 새 크롤
    if req.force_refresh and out.exists():
        for f in ("mirror.json", "final.json", "pc.md", "pc.html", "pc_full.png", "progress.json"):
            try:
                (out / f).unlink()
            except Exception:
                pass

    job_id = "job_" + uuid.uuid4().hex[:12]
    JOBS[job_id] = {"url": req.url, "slug": slug, "started_at": time.time()}
    gk = x_gemini_api_key or None
    launch_pipeline(job_id, req.url, req.use_pro_model, gk)
    return {"job_id": job_id, "status": "queued",
            "message": "크롤링 분석 작업이 대기열에 등록되었습니다. 실시간 상태 조회를 활용하십시오.",
            "estimated_duration_seconds": 45}


@app.get("/api/v1/jobs/{job_id}")
def job_status(job_id: str, _auth: None = Depends(require_auth)):
    return job_snapshot(job_id)


def _render_ebay_html(out: Path) -> str:
    """mirror.json → CCG 디자인 렌더러(ebay_builder)로 eBay HTML fragment 생성.
    로컬 eBay 빌더(/api/ebay-generate)와 100% 동일한 결과 — 디자인 단일 소스."""
    mirror = read_json(out / "mirror.json")
    if not mirror:
        raise HTTPException(status_code=404, detail="mirror not ready — crawl first")
    from ebay_builder import build_ebay_html
    return build_ebay_html(mirror, fragment=True)


@app.get("/api/v1/jobs/{job_id}/ebay-html", response_class=HTMLResponse)
def job_ebay_html(job_id: str, _auth: None = Depends(require_auth)):
    """완료된 잡의 mirror를 CCG 컴포넌트 디자인(eBay 설명란 삽입용 fragment)으로 렌더."""
    snap = job_snapshot(job_id)
    if snap["status"] != "completed":
        raise HTTPException(status_code=409, detail=f"job status={snap['status']} — 완료 후 호출하세요")
    return _render_ebay_html(JOBS[job_id]["out"])


@app.get("/api/v1/ebay-html", response_class=HTMLResponse)
def ebay_html_by_url(url: str, _auth: None = Depends(require_auth)):
    """URL 직접 지정 렌더 (잡 ID 없이) — 캐시된 크롤 결과가 있어야 함.
    서버 재시작으로 job_id 가 사라져도 URL 만으로 동일 HTML 을 받을 수 있다."""
    out = OUT_DIR / slugify(url)
    return _render_ebay_html(out)


@app.get("/api/v1/jobs/{job_id}/stream")
async def job_stream(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="job not found")

    async def gen():
        last = -1
        for _ in range(2400):  # 최대 ~20분 (0.5s * 2400) — Pro 모델+QA 루프 크롤은 11~15분 소요
            snap = job_snapshot(job_id)
            pct = snap.get("progress_percent", 0)
            if snap["status"] == "completed":
                yield f"event: complete\ndata: {json.dumps({'redirect_url': f'/api/v1/jobs/{job_id}'})}\n\n"
                return
            if snap["status"] == "failed":
                yield f"event: error\ndata: {json.dumps({'error': snap.get('error', '')[:300]})}\n\n"
                return
            if pct != last:
                yield f"event: progress\ndata: {json.dumps({'percent': pct, 'message': snap.get('log_message', '')}, ensure_ascii=False)}\n\n"
                last = pct
            await asyncio.sleep(0.5)
        yield f"event: error\ndata: {json.dumps({'error': 'timeout'})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
