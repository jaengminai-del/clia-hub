/**
 * drain.js — 재배포해도 백그라운드 작업이 끊기지 않게 (2026-11-24)
 *
 * Railway 는 새 배포가 켜지면 이전 서버에 SIGTERM 을 보내고 RAILWAY_DEPLOYMENT_DRAINING_SECONDS(15분) 뒤에 강제로 끈다.
 *   이전 서버: SIGTERM → 새 작업은 시작하지 않고(미리 준비 · 벌크 엑셀 다음 행) 돌고 있는 크롤 · 준비 · 벌크 행을 끝까지 마친 뒤
 *             결과를 버킷에 올리고 끝낸다 (최대 DRAIN_MAX_SECONDS, 기본 840초 — 강제 종료 전에).
 *             마무리하는 동안 버킷에 system/draining.json { at } 을 30초마다 새로 쓴다.
 *   새 서버:   gate() — 이전 서버가 마무리 중이면(draining.json 이 90초 안에 새로 쓰였으면) 끝날 때까지 기다렸다가
 *             버킷을 다시 받아(이전 서버가 마친 결과) 이어서 시작한다 → 벌크 엑셀 이어 하기 · 미리 준비가 같은 일을 두 번 하지 않는다.
 *
 * 각 모듈은 register({ name, pause(), busy() }) 로 붙는다 — pause: 새 작업을 시작하지 않음, busy: 돌고 있는 작업 수.
 */
const store = require('./crawl-store');

const KEY = 'system/draining.json';
const MAX_MS = (parseInt(process.env.DRAIN_MAX_SECONDS, 10) || 840) * 1000;
const FRESH_MS = 90 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hooks = [];
let draining = false;

const register = (h) => { hooks.push(h); };
const isDraining = () => draining;
const busy = () => hooks.reduce((n, h) => n + (Number(h.busy()) || 0), 0);
const busyText = () => hooks.map((h) => `${h.name} ${h.busy()}`).join(' · ');
const putLease = (at) => store.putBuffer(KEY, Buffer.from(JSON.stringify({ at, pid: process.pid, deployment: process.env.RAILWAY_DEPLOYMENT_ID || '' })), 'application/json').catch(() => {});

async function drainAndExit(sig) {
  if (draining) return;
  draining = true;
  const t0 = Date.now();
  for (const h of hooks) { try { h.pause(); } catch (_) {} }
  console.log(`[drain] ${sig}: 새 작업은 시작하지 않고, 돌고 있는 작업을 마친 뒤 끝냄 (최대 ${MAX_MS / 1000}초) — ${busyText()}`);
  if (busy() > 0) {
    await putLease(Date.now());
    const t = setInterval(() => putLease(Date.now()), 30 * 1000);
    let last = 0;
    while (busy() > 0 && Date.now() - t0 < MAX_MS) {
      await sleep(5000);
      if (Date.now() - last > 60 * 1000) { last = Date.now(); console.log(`[drain] 마무리 중 ${Math.round((Date.now() - t0) / 1000)}초 — ${busyText()}`); }
    }
    clearInterval(t);
    await sleep(3000);   // 끝난 작업의 버킷 업로드가 나갈 틈
  }
  await putLease(0);
  console.log(`[drain] 끝 (${Math.round((Date.now() - t0) / 1000)}초, 남은 작업 ${busy()})`);
  process.exit(0);
}

/** 새 서버: 이전 서버의 마무리를 기다린다 (시작 뒤 1분 동안은 SIGTERM 이 늦게 올 수 있어 지켜본다). 기다렸으면 버킷을 다시 받는다. */
let gateP = null;
function gate() {
  if (gateP) return gateP;
  gateP = (async () => {
    if (!store.enabled()) return false;
    const t0 = Date.now();
    let waited = false;
    for (;;) {
      let j = null;
      try { const b = await store.getBuffer(KEY); j = b ? JSON.parse(b.toString('utf8')) : null; } catch (_) {}
      const fresh = j && j.at && Date.now() - j.at < FRESH_MS;
      if (fresh) {
        if (!waited) console.log('[drain] 이전 서버가 작업을 마무리하는 중 — 끝나면 이어서 시작');
        waited = true;
      } else if (waited || Date.now() - t0 > 60 * 1000) break;
      if (Date.now() - t0 > MAX_MS + 2 * 60 * 1000) break;
      await sleep(fresh ? 20 * 1000 : 10 * 1000);
    }
    if (waited) {
      console.log('[drain] 이전 서버 마무리 끝 → 버킷 다시 받기 (그 서버가 마친 결과)');
      await store.pullAll().then((s) => s && console.log(`[drain] 다시 받기: 다운로드 ${s.downloaded}, 같음 ${s.unchanged}`)).catch((e) => console.warn('[drain] 다시 받기 실패', e.message));
      try { require('./bulk-catalog').invalidate(); } catch (_) {}
    }
    return waited;
  })();
  return gateP;
}

module.exports = { register, isDraining, drainAndExit, gate, busy };
