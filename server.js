require('dotenv').config({ override: true });
const express = require('express');
// 아마존 A+ 텍스트 규정(® ™ * 등 특수부호 제거) — 아마존 산출 경로에서만 사용
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
// file:// 포함 모든 origin 허용 (CORS)
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: false }));
app.use(express.json({ limit: '50mb' }));
app.use(require('./crawler-routes')); // 내장 PDP 크롤러 (/api/v1/*) — 별도 FastAPI·터널 불필요
app.use('/crawler-py', (req, res) => res.sendStatus(404)); // 크롤러 소스·산출물은 정적 노출 금지
app.use(express.static('.'));

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ──────────────────────────────────────────
   /api/analyze  — LG.com PDP 섹션 추출
   Claude 없이 크롤링만 수행, 섹션 순서 보존
────────────────────────────────────────── */
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled', '--disable-web-security',
           '--lang=en-US,en']
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    // Full HD 1920×1080 — PC 데스크톱 레이아웃 강제 (모바일 이미지 회피, 고해상도 srcset 선택)
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // ① 페이지 로드 (networkidle2 시도, 타임아웃 시 이미 로드된 콘텐츠로 계속)
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
      console.warn('networkidle2 timeout, continuing with loaded content:', e.message);
    }

    // ② JS 렌더링 대기 (SPA hydration — Next.js React 렌더링 완료 보장)
    await new Promise(r => setTimeout(r, 6000));

    // ③ 404 / 에러 페이지 감지 (LG SPA는 URL 유지, DOM에 에러 표시)
    const finalUrl = page.url();
    const pageTitle = await page.title().catch(() => '');
    const titleLower = pageTitle.toLowerCase();

    // H1 텍스트 + LG 전용 에러 클래스 감지
    const pageCheck = await page.evaluate(() => {
      const h1 = document.querySelector('h1')?.innerText?.trim() || '';
      // LG 전용: error-common class
      const hasLGError = !!document.querySelector('.error-common, #lgContents.error-common, [class*="error-common"]');
      // 에러 페이지 키워드
      const body100 = document.body?.innerText?.substring(0, 200) || '';
      return { h1, hasLGError, body100 };
    }).catch(() => ({ h1: '', hasLGError: false, body100: '' }));

    const h1Lower = pageCheck.h1.toLowerCase();
    const bodyLower = pageCheck.body100.toLowerCase();

    const is404 =
      pageCheck.hasLGError ||
      titleLower.includes("404") ||
      titleLower.includes("not found") ||
      h1Lower.includes("we're sorry") ||
      h1Lower.includes("page you requested") ||
      h1Lower.includes("not available") ||
      h1Lower.includes("page not found") ||
      (bodyLower.includes("we're sorry") && bodyLower.includes("page"));

    if (is404) {
      return res.status(400).json({
        error: `페이지를 찾을 수 없습니다. URL을 확인해주세요.\n(URL: ${finalUrl})`
      });
    }
    console.log(`[analyze] 페이지 로드: ${finalUrl} | ${pageTitle} | H1: ${pageCheck.h1.substring(0, 60)}`);

    // ③-b lazy-load 이미지 강제 활성화 (IntersectionObserver 미작동 대비)
    try {
      await page.evaluate(() => {
        // LG AEM placeholder 패턴 감지 (transparent.png 등 비표준 포함)
        function isPlaceholderSrc(img) {
          const curSrc = img.getAttribute('src') || '';
          if (!curSrc || img.naturalWidth <= 1) return true;
          return /blank|placeholder|transparent|spacer|1x1|\/common\/|loading/i.test(curSrc)
              || curSrc.endsWith('.gif');
        }
        document.querySelectorAll('img').forEach(img => {
          ['data-src','data-lazy-src','data-original','data-lazy','data-srcset','data-lazy-srcset'].forEach(attr => {
            const val = img.getAttribute(attr);
            if (!val) return;
            if (attr.includes('srcset')) { if (!img.srcset) img.srcset = val; return; }
            if (isPlaceholderSrc(img)) img.src = val;
          });
        });
        document.querySelectorAll('source').forEach(src => {
          const lazy = src.getAttribute('data-srcset') || src.getAttribute('data-src') || '';
          if (lazy && !src.srcset) src.srcset = lazy;
        });
      });
    } catch (e) { console.warn('Force lazy-load warning:', e.message); }

    // ④ 쿠키/동의 배너 강제 제거
    try {
      await page.evaluate(() => {
        const COOKIE_SELS = [
          '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#onetrust-pc-sdk',
          '[id*="onetrust"]', '[class*="onetrust"]',
          '[id*="cookie"]', '[class*="cookie-banner"]', '[class*="cookie-consent"]',
          '[id*="consent"]', '[class*="consent-"]',
          '[aria-label*="cookie" i]', '[aria-label*="consent" i]',
          '.ReactModal__Overlay', '.modal-overlay',
        ];
        COOKIE_SELS.forEach(sel => {
          try { document.querySelectorAll(sel).forEach(el => el.remove()); } catch (_) {}
        });
        // position:fixed 고zIndex 오버레이 제거
        document.querySelectorAll('*').forEach(el => {
          try {
            const s = window.getComputedStyle(el);
            if ((s.position === 'fixed' || s.position === 'sticky') &&
                +s.zIndex > 500 && el.offsetHeight > 80) el.remove();
          } catch (_) {}
        });
        document.body.style.overflow = 'auto';
      });
    } catch (e) { console.warn('Cookie removal warning:', e.message); }

    // ⑤ 스크롤 → lazy-load 이미지 활성화 (페이지 이탈 대비 try/catch)
    try {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          let pos = 0;
          const step = 400;
          const t = setInterval(() => {
            window.scrollBy(0, step);
            pos += step;
            if (pos >= document.body.scrollHeight) {
              clearInterval(t);
              window.scrollTo(0, 0);
              resolve();
            }
          }, 100);
          setTimeout(() => { clearInterval(t); resolve(); }, 12000);
        });
      });
      // 스크롤 후 재차 lazy-load 강제 실행 (스크롤로 IntersectionObserver 트리거 후 data-src 잔여분 처리)
      await page.evaluate(() => {
        function isPlaceholderSrc(img) {
          const curSrc = img.getAttribute('src') || '';
          if (!curSrc || img.naturalWidth <= 1) return true;
          return /blank|placeholder|transparent|spacer|1x1|\/common\/|loading/i.test(curSrc)
              || curSrc.endsWith('.gif');
        }
        document.querySelectorAll('img').forEach(img => {
          ['data-src','data-lazy-src','data-original','data-lazy'].forEach(attr => {
            const val = img.getAttribute(attr);
            if (val && isPlaceholderSrc(img)) img.src = val;
          });
        });
        document.querySelectorAll('source').forEach(src => {
          const lazy = src.getAttribute('data-srcset') || src.getAttribute('data-src') || '';
          if (lazy && !src.srcset) src.srcset = lazy;
        });
      });
      await new Promise(r => setTimeout(r, 3000)); // 이미지 로딩 안정화 (2s → 3s)
    } catch (e) {
      console.warn('Scroll warning (continuing):', e.message);
      await new Promise(r => setTimeout(r, 1500));
    }

    // ⑤-b 캐러셀/슬라이더 숨겨진 슬라이드 이미지 수집
    // ⚠️ position/left/top/transform 변경 금지:
    //    변경 시 슬라이드가 수직으로 쌓여 컨테이너 height 폭발 → Strategy 1 필터 제거됨
    //    → 개별 슬라이드가 독립 섹션으로 추출, 그루핑(cardItems) 로직이 작동 안 됨
    try {
      await page.evaluate(() => {
        // display:none인 슬라이드만 block으로 전환 (position/transform은 절대 변경 안 함)
        [
          '[class*="swiper-slide"]', '[class*="slick-slide"]',
          '[class*="carousel-item"]', '[class*="owl-item"]',
          '[class*="-slide"]', '[role="tabpanel"]',
          '[aria-roledescription="slide"]',
          '[class*="tab-content"]', '[class*="tab-panel"]',
        ].forEach(sel => {
          document.querySelectorAll(sel).forEach(el => {
            const cs = window.getComputedStyle(el);
            // display:none만 block으로 전환 (그 외 상태는 건드리지 않음)
            if (cs.display === 'none') el.style.setProperty('display', 'block', 'important');
            // visibility/opacity만 조정 (이미지 로딩 트리거용)
            el.style.setProperty('visibility', 'visible', 'important');
            el.style.setProperty('opacity', '1', 'important');
            // ❌ position, left, top, transform → 변경 금지
          });
        });
        // ❌ 래퍼 overflow/transform 변경 금지 (height 왜곡 원인 제거)

        // 새롭게 활성화된 슬라이드의 lazy 이미지 src 직접 주입
        function isPlaceholderSrc(img) {
          const curSrc = img.getAttribute('src') || '';
          if (!curSrc || img.naturalWidth <= 1) return true;
          return /blank|placeholder|transparent|spacer|1x1|\/common\/|loading/i.test(curSrc)
              || curSrc.endsWith('.gif');
        }
        document.querySelectorAll('img').forEach(img => {
          ['data-src', 'data-lazy-src', 'data-original', 'data-lazy'].forEach(attr => {
            const val = img.getAttribute(attr);
            if (val && isPlaceholderSrc(img)) img.src = val;
          });
          const lazySrcset = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset') || '';
          if (lazySrcset && !img.srcset) img.srcset = lazySrcset;
        });
        document.querySelectorAll('source').forEach(src => {
          const lazy = src.getAttribute('data-srcset') || src.getAttribute('data-src') || '';
          if (lazy && !src.srcset) src.srcset = lazy;
        });
      });
      await new Promise(r => setTimeout(r, 2500)); // 슬라이드 이미지 로딩 대기
    } catch (e) {
      console.warn('Carousel force warning:', e.message);
    }

    // ⑥ DOM 분석
    const features = await page.evaluate(() => {

      // ── 헬퍼 함수 ──────────────────────────────────────
      const SKIP_KW = [
        // 쿠키/동의
        'cookie', 'consent', 'privacy policy', 'manage preference',
        'we use cookies', 'gdpr', 'terms of use',
        // 계정/인증
        'sign in', 'sign up', 'log in', 'create account', 'register',
        'newsletter', 'subscribe',
        // 네비게이션
        'navigation', 'skip to', 'go to homepage', "can't find",
        "page you requested", "page isn't available",
        'search', 'cart', 'checkout', 'wishlist',
        'breadcrumb', 'page not', "we're sorry",
        // 목록 UI
        'view all', 'see all', 'load more', 'show more',
        'sort by', 'filter', 'results',
        // 리뷰/서포트/연락처
        'write a review', 'customer review', 'questions?', 'let us help',
        'contact us', 'find locally', 'find nearby', 'store locator',
        'find a store', 'product support', 'manuals',
        // e-커머스 노이즈
        'limited quantity', 'almost sold out', 'add to cart',
        'summary-member', 'buy now', 'shop now',
        // 추천/관련상품
        'recommended product', 'related product', 'you may also',
        'customers also', 'people also',
        // 리뷰/폼
        'required field', 'ratings', 'write your review', 'overall rating',
        // 기타 노이즈
        'find locally', 'find nearby', 'geolocation',
        'get directions', 'directions to',
        'summary-member', 'limited quantity',
        'limited time', 'offer expires',
        'check your final price', 'final price',
        'what people are saying', 'customer rating',
        'be the first to review', 'first to review',
        'add to compare', 'remove compare',
        'to properly experience', 'use an alternate browser',
        'response to coronavirus', 'covid',
        'passwords must', 'characters left',
        'component-obs', 'iw_component', 'component-update',
        'learn more', // 단독으로 오는 경우
        // AR/360° 뷰어 UI 노이즈
        'experience this product around', 'ar experience',
        'view in your room', 'view in room', '360° view',
        // 소셜/공유 UI
        'share this page', 'share on', 'follow us',
        // 추천/프로모션/지원 노이즈
        'our picks for you', 'picks for you',
        'need more help', 'more help with your product',
        'discover our latest', 'latest promotions', 'latest offers',
        'see all promotions', 'view promotions',
        // LG SA / 지원·FAQ·추천 섹션 (PDP 본문 외 노이즈)
        'frequently asked', 'all spec', 'find the best lg',
        'best qned tv for', 'gaming portal turns', 'find a store',
        'find an installer', 'need help?',
      ];
      function isSkip(text) {
        // \xa0(non-breaking space), \t 등 공백 정규화
        const t = (text || '').replace(/[\xa0\t]+/g, ' ').toLowerCase().trim();
        return SKIP_KW.some(kw => t.includes(kw));
      }

      // CSS 클래스 이름처럼 보이는 텍스트 감지
      // e.g. "component-update-nickname-title", "component-OBScountrySelectDesc"
      function looksLikeClassName(text) {
        if (!text) return false;
        const t = text.trim();
        // 공백 없고 하이픈+영숫자 패턴 (kebab-case or camelCase+hyphen)
        if (/^[a-zA-Z][a-zA-Z0-9]*(-[a-zA-Z0-9]+){1,}$/.test(t)) return true;
        // 전체가 camelCase (소문자시작 + 대문자 섞임, 공백 없음)
        if (/^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]+$/.test(t)) return true;
        return false;
      }

      // 네비게이션 카테고리 목록처럼 보이는 불릿 감지
      function looksLikeNavBullet(text) {
        if (!text) return false;
        // \n\t\n 패턴 (메뉴 항목) 또는 너무 많은 줄바꿈
        if ((text.match(/\n/g) || []).length > 3) return true;
        // TV/AUDIO/VIDEO 같은 카테고리 패턴
        if (/^[A-Z\/&]+(\s[A-Z\/&]+)*$/.test(text.trim())) return true;
        return false;
      }

      // ── 상대 URL → 절대 URL 변환 (핵심 버그 수정) ──────────────
      function abs(u) {
        if (!u) return '';
        u = u.trim();
        if (u.startsWith('data:') || u.startsWith('blob:')) return u;
        if (u.startsWith('//')) return location.protocol + u;
        if (u.startsWith('/'))  return location.origin + u;
        if (!u.startsWith('http')) {
          try { return new URL(u, location.href).href; } catch (_) {}
        }
        return u;
      }

      // srcset 문자열에서 최고 해상도 URL 파싱 (w디스크립터·x디스크립터 모두 지원)
      function parseBestSrcset(ss) {
        if (!ss) return '';
        let bestScore = -1, bestUrl = '';
        ss.split(',').forEach(part => {
          const tokens = part.trim().split(/\s+/);
          const u = tokens[0];
          if (!u) return;
          const descriptor = tokens[1] || '';
          let score = 0;
          if (/^\d+w$/i.test(descriptor)) {
            score = parseInt(descriptor);            // 1440w → 1440
          } else if (/^[\d.]+x$/i.test(descriptor)) {
            score = parseFloat(descriptor) * 1000;  // 2x → 2000 (w보다 낮은 우선순위)
          } else {
            score = 500; // 디스크립터 없는 단독 URL → 중간 우선순위
          }
          if (score > bestScore) { bestScore = score; bestUrl = u; }
        });
        return abs(bestUrl);
      }

      // <source> 가 데스크톱(PC)/모바일 타겟인지 분류
      //   desktop : min-width: 600px+ 가 명시된 경우
      //   mobile  : max-width: 1024px 이하만 있고 min-width 미명시
      //   neutral : media 속성 없음 또는 양쪽 모두 명시
      function classifySource(srcEl) {
        const media = (srcEl.getAttribute('media') || '').toLowerCase();
        if (!media) return 'neutral';
        const minMatch = media.match(/min-width\s*:\s*(\d+)px/);
        const maxMatch = media.match(/max-width\s*:\s*(\d+)px/);
        if (minMatch && parseInt(minMatch[1]) >= 600) return 'desktop';
        if (maxMatch && !minMatch && parseInt(maxMatch[1]) <= 1024) return 'mobile';
        return 'neutral';
      }

      // URL이 모바일 변형 패턴인지 추정
      //   - -M.jpg / _M.png / -m.webp 등 단일 문자 토큰
      //   - -mobile- / _mobile- / /mobile/ 등 명시적 키워드
      //   - -sp.jpg (일본식: smartphone)
      function isMobileUrlPattern(u) {
        if (!u) return false;
        return /[-_]M\.(jpe?g|png|webp|gif)(\?|$)/i.test(u)
            || /[-_]mobile([-_./])/i.test(u)
            || /\/mobile\//i.test(u)
            || /[-_]sp\.(jpe?g|png|webp)(\?|$)/i.test(u);
      }

      // 모바일 URL → 데스크톱 변형 추정 URL
      //   -M.jpg → -D.jpg, -mobile- → -desktop-, -sp.jpg → -pc.jpg
      function guessDesktopUrl(u) {
        if (!u) return u;
        return u
          .replace(/([-_])M(\.(jpe?g|png|webp|gif)(\?|$))/i, (m, sep, ext) => sep + 'D' + ext)
          .replace(/([-_])mobile([-_./])/gi, '$1desktop$2')
          .replace(/\/mobile\//gi, '/desktop/')
          .replace(/([-_])sp(\.(jpe?g|png|webp)(\?|$))/i, '$1pc$2');
      }

      // <picture> 또는 같은 컨테이너 내에서 데스크톱 변형 URL이 실제로 존재하는지 확인
      function existsInDom(url, scope) {
        if (!url || !scope) return false;
        try {
          const html = scope.innerHTML || '';
          // 절대 URL이면 path 부분만 비교
          let needle = url;
          try { needle = new URL(url, location.href).pathname; } catch (_) {}
          return html.indexOf(needle) !== -1;
        } catch (_) { return false; }
      }

      // src가 placeholder(투명 1px 등)인지 판별
      function isSrcPlaceholder(img) {
        const src = img.getAttribute('src') || img.src || '';
        if (!src) return true;
        if (img.naturalWidth <= 1) return true; // 1×1 투명 png / 아직 미로드(0px)
        return /blank|placeholder|transparent|spacer|1x1|\/common\/|loading/i.test(src)
            || src.endsWith('.gif');
      }

      // srcset / picture에서 최고 해상도 URL 추출 — PC(데스크톱) 이미지 최우선
      function bestSrc(img) {
        // 1) <picture> 안의 <source>에서 PC > neutral > mobile 순으로 선택
        //    srcset(IDL) 또는 data-srcset 모두 탐색 (lazy-load 전/후 모두 대응)
        const picture = img.closest('picture');
        if (picture) {
          const sources = Array.from(picture.querySelectorAll('source'));
          // 미디어쿼리 기반 우선순위 그룹핑 (data-srcset 까지 srcset에 채움)
          const desktopSrcs = sources.filter(s => classifySource(s) === 'desktop');
          const neutralSrcs = sources.filter(s => classifySource(s) === 'neutral');
          const mobileSrcs  = sources.filter(s => classifySource(s) === 'mobile');
          const orderedGroups = [desktopSrcs, neutralSrcs, mobileSrcs];

          // 그룹별로 webp → 타입없음 → 나머지 순으로 탐색
          for (const group of orderedGroups) {
            if (!group.length) continue;
            for (const preferType of ['image/webp', '', null]) {
              for (const src of group) {
                if (preferType !== null && src.getAttribute('type') !== preferType) continue;
                const ss = src.srcset || src.getAttribute('srcset') || src.getAttribute('data-srcset') || '';
                const u = parseBestSrcset(ss);
                if (u) return u;
              }
            }
          }
        }

        // 2) img의 srcset / data-srcset
        const imgSrcset = img.srcset || img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
        let fromSrcset = parseBestSrcset(imgSrcset);
        if (fromSrcset) {
          // 모바일 패턴이면 데스크톱 변형이 같은 picture/parent 안에 존재하는지 확인 후 교체
          if (isMobileUrlPattern(fromSrcset)) {
            const desk = guessDesktopUrl(fromSrcset);
            const scope = picture || img.closest('section, article, .component, .c-list__item, .c-floating-contents, .c-media-contents') || img.parentElement;
            if (desk !== fromSrcset && existsInDom(desk, scope)) return desk;
          }
          return fromSrcset;
        }

        // 3) data-src 우선 (naturalWidth ≤ 1 = placeholder or not-loaded → data-src가 실제 URL)
        const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') ||
                        img.getAttribute('data-original') || img.getAttribute('data-lazy') || '';
        if (lazySrc && isSrcPlaceholder(img)) {
          if (isMobileUrlPattern(lazySrc)) {
            const desk = guessDesktopUrl(lazySrc);
            const scope = picture || img.closest('section, article, .component') || img.parentElement;
            if (desk !== lazySrc && existsInDom(desk, scope)) return desk;
          }
          return abs(lazySrc);
        }

        // 4) currentSrc (브라우저가 선택한 실제 URL)
        if (img.currentSrc && !isSrcPlaceholder(img)) {
          const cs = abs(img.currentSrc);
          if (isMobileUrlPattern(cs)) {
            const desk = guessDesktopUrl(cs);
            const scope = picture || img.closest('section, article, .component') || img.parentElement;
            if (desk !== cs && existsInDom(desk, scope)) return desk;
          }
          return cs;
        }

        // 5) src — placeholder 패턴 제외
        const src = img.src || '';
        if (src && !isSrcPlaceholder(img)) {
          const sa = abs(src);
          if (isMobileUrlPattern(sa)) {
            const desk = guessDesktopUrl(sa);
            const scope = picture || img.closest('section, article, .component') || img.parentElement;
            if (desk !== sa && existsInDom(desk, scope)) return desk;
          }
          return sa;
        }

        // 6) data-src fallback (placeholder이더라도 data-src 있으면 사용)
        if (lazySrc) return abs(lazySrc);

        // 7) src 속성 최후 fallback
        return abs(img.getAttribute('src') || '');
      }

      // 이미지와 가장 인접한 텍스트(heading/caption/desc) 추출
      function findNearImageText(img, root) {
        // 0) AEM: c-hero-banner / c-floating-contents / .component.type-X (LG SA) 구조
        //    img → .c-hero-banner__media → .c-floating-contents → c-text-contents
        //    img → .c-media-contents → .c-list__item → .c-text-contents (column-N 카드)
        let cur = img.parentElement;
        for (let i = 0; i < 8; i++) {  // depth 6 → 8 (LG SA 더 깊은 wrapper 대응)
          if (!cur || cur === root) break;
          const cls = (cur.className || '').toString();
          // AEM banner / floating-contents / LG SA component 컨테이너 감지
          if (/c-hero-banner|c-floating|c-text-contents|c-list__item|c-media-contents|component\s/.test(cls) || cur.tagName === 'SECTION') {
            // 이 컨테이너 내 AEM bodycopy 우선
            const bodyP = cur.querySelector('[class*="__bodycopy"] .cmp-text p, [class*="bodycopy"] p, .cmp-text p');
            if (bodyP) {
              const t = bodyP.innerText?.trim();
              if (t && t.length > 10 && !t.startsWith('*')) return t;
            }
            // AEM headline
            const hlEl = cur.querySelector('[class*="__headline"] .cmp-title, .cmp-title__text, .cmp-title');
            if (hlEl) {
              const t = hlEl.innerText?.trim();
              if (t && t.length > 2 && t.length < 200) return t;
            }
          }
          cur = cur.parentElement;
        }

        // 1) <figure> > <figcaption>
        const fig = img.closest('figure');
        if (fig) {
          const cap = fig.querySelector('figcaption')?.innerText?.trim();
          if (cap && cap.length > 2) return cap;
        }
        // 2) 같은 컨테이너의 h3/h4/p (이미지 다음 형제 또는 부모 형제)
        const parent = img.parentElement;
        if (parent) {
          // 형제 중 텍스트 요소 (heading 우선)
          const headingSib = Array.from(parent.children).find(sib => {
            if (sib === img) return false;
            const tag = sib.tagName;
            return tag === 'H2' || tag === 'H3' || tag === 'H4';
          });
          if (headingSib) {
            const t = headingSib.innerText?.trim();
            if (t && t.length > 2 && t.length < 200) return t;
          }
          // 형제 중 텍스트 요소
          for (const sib of Array.from(parent.children)) {
            if (sib === img) continue;
            const t = sib.innerText?.trim();
            if (t && t.length > 2 && t.length < 200) return t;
          }
          // 부모의 형제에서 찾기
          const grandP = parent.parentElement;
          if (grandP && grandP !== root) {
            for (const sib of Array.from(grandP.children)) {
              if (sib.contains(img)) continue;
              const el = sib.querySelector('h2,h3,h4,[class*="__headline"],[class*="-title"],[class*="-desc"]');
              const t = el?.innerText?.trim();
              if (t && t.length > 2 && t.length < 200) return t;
            }
          }
        }
        // 3) img alt 텍스트 (마지막 fallback)
        return img.alt?.trim() || '';
      }

      function extractImgs(root) {
        const rawImgs = [];

        // 1) 일반 <img> 태그
        Array.from(root.querySelectorAll('img')).forEach(img => {
          const src = bestSrc(img);
          if (!src) return;
          // naturalWidth ≤ 1은 placeholder 크기 → 실제 이미지 크기가 아니므로 0으로 처리
          // (크기 필터 'width < 150' 오판 방지)
          const isPlaceholderLoaded = img.naturalWidth <= 1;
          const w = isPlaceholderLoaded ? (+img.getAttribute('width') || 0)
                                        : (img.naturalWidth || +img.getAttribute('width') || 0);
          const h = isPlaceholderLoaded ? (+img.getAttribute('height') || 0)
                                        : (img.naturalHeight || +img.getAttribute('height') || 0);
          const nearText = findNearImageText(img, root);
          // 렌더링된 레이아웃 geometry (행당 이미지 개수 판정용)
          let rw = 0, rt = 0, rl = 0;
          try {
            const r = img.getBoundingClientRect();
            rw = Math.round(r.width);
            rt = Math.round(r.top + (window.scrollY || 0));
            rl = Math.round(r.left + (window.scrollX || 0));
          } catch (_) {}
          rawImgs.push({ url: src, width: w, height: h,
                   ar: w > 0 && h > 0 ? +(w/h).toFixed(3) : 0,
                   alt: img.alt || '', nearText, rw, rt, rl });
        });

        // 2) <video poster="..."> 포스터 이미지
        Array.from(root.querySelectorAll('video[poster]')).forEach(v => {
          const poster = v.getAttribute('poster') || '';
          if (poster && !poster.startsWith('data:')) {
            rawImgs.push({ url: poster, width: 0, height: 0, ar: 1.78, alt: 'Video poster', nearText: '' });
          }
        });

        // 3) YouTube / Vimeo iframe 썸네일
        Array.from(root.querySelectorAll('iframe')).forEach(iframe => {
          const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
          const ytMatch = src.match(/youtube(?:-nocookie)?\.com\/embed\/([^?&/"]+)/);
          const vimeoMatch = src.match(/vimeo\.com\/video\/(\d+)/);
          if (ytMatch) {
            const vid = ytMatch[1];
            rawImgs.push({
              url: `https://img.youtube.com/vi/${vid}/hqdefault.jpg`,
              width: 480, height: 360, ar: 1.33, alt: 'Video', nearText: ''
            });
          } else if (vimeoMatch) {
            // Vimeo는 API가 필요하므로 placeholder URL 사용 (로드 시 대체)
          }
        });

        // 4) data-youtube-id / data-video-id 속성 (커스텀 플레이어)
        Array.from(root.querySelectorAll('[data-youtube-id],[data-video-id],[data-vid]')).forEach(el => {
          const vid = el.dataset.youtubeId || el.dataset.videoId || el.dataset.vid;
          if (vid && /^[a-zA-Z0-9_-]{8,12}$/.test(vid)) {
            rawImgs.push({
              url: `https://img.youtube.com/vi/${vid}/hqdefault.jpg`,
              width: 480, height: 360, ar: 1.33, alt: 'Video', nearText: ''
            });
          }
        });

        // 5) CSS background-image — root 및 모든 하위 요소 스캔 (full-bleed 섹션 대응)
        const bgCandidates = [root, ...Array.from(root.querySelectorAll('*'))];
        bgCandidates.forEach(el => {
          try {
            if (el.offsetWidth < 200 || el.offsetHeight < 80) return; // 너무 작은 요소 제외
            const bg = window.getComputedStyle(el).backgroundImage;
            if (!bg || bg === 'none') return;
            // 여러 레이어 중 첫 url() 추출
            const match = bg.match(/url\(['"]?([^'")\s]+)['"]?\)/);
            if (match) {
              const bgUrl = abs(match[1]);
              if (bgUrl && !bgUrl.startsWith('data:') &&
                  !/icon|logo|\.svg|gradient|pixel|1x1|sprite/.test(bgUrl)) {
                let rw = el.offsetWidth, rt = 0, rl = 0;
                try { const r = el.getBoundingClientRect(); rw = Math.round(r.width); rt = Math.round(r.top + (window.scrollY || 0)); rl = Math.round(r.left + (window.scrollX || 0)); } catch (_) {}
                rawImgs.push({
                  url: bgUrl,
                  width: el.offsetWidth,
                  height: el.offsetHeight,
                  ar: el.offsetWidth > 0 && el.offsetHeight > 0
                    ? +(el.offsetWidth / el.offsetHeight).toFixed(3) : 0,
                  alt: el.getAttribute('aria-label') || el.title || '',
                  nearText: '', rw, rt, rl
                });
              }
            }
          } catch (_) {}
        });

        // 6) 카드 패턴 명시 수집 — h3/h4 + img 반복 구조 (carousel, tab, grid card)
        // 이미 수집된 URL 세트
        const collectedUrls = new Set(rawImgs.map(i => i.url.replace(/[?#].*/, '')));
        const CARD_SELS = [
          '[class*="card"]', '[class*="swiper-slide"]', '[class*="slick-slide"]',
          '[class*="-slide"]', '[class*="-item"]', '[class*="-panel"]',
          '[class*="tab-content"]', 'li',
        ];
        CARD_SELS.forEach(sel => {
          try {
            Array.from(root.querySelectorAll(sel)).forEach(card => {
              if (card.offsetHeight < 50 || card.offsetWidth < 80) return;
              // 카드 내에 heading이 있어야 의미 있는 카드
              if (!card.querySelector('h2,h3,h4,h5,strong,[class*="title"],[class*="tit"],[class*="heading"]')) return;
              const cardImg = card.querySelector('img');
              if (!cardImg) return;
              const src = bestSrc(cardImg);
              if (!src) return;
              const baseUrl = src.replace(/[?#].*/, '');
              if (collectedUrls.has(baseUrl)) return;
              collectedUrls.add(baseUrl);
              const w = cardImg.naturalWidth  || +cardImg.getAttribute('width')  || 0;
              const h = cardImg.naturalHeight || +cardImg.getAttribute('height') || 0;
              const nearText = findNearImageText(cardImg, root);
              let rw = 0, rt = 0, rl = 0;
              try { const r = cardImg.getBoundingClientRect(); rw = Math.round(r.width); rt = Math.round(r.top + (window.scrollY || 0)); rl = Math.round(r.left + (window.scrollX || 0)); } catch (_) {}
              rawImgs.push({ url: src, width: w, height: h,
                ar: w > 0 && h > 0 ? +(w/h).toFixed(3) : 0,
                alt: cardImg.alt || '', nearText, rw, rt, rl });
            });
          } catch (_) {}
        });

        // 필터링
        const filtered = rawImgs.filter(i => {
          if (!i.url || i.url.startsWith('data:')) return false;
          const u = i.url.toLowerCase();
          if (/icon|logo|\.svg|blank|placeholder|spinner|pixel|rating|star/.test(u)) return false;
          const filename = u.split('/').pop() || '';
          if (/^loading|[-_]loading[-_.]|loading\.(gif|png|webp)$/.test(filename)) return false;
          // 아이콘 크기 패턴: _24x24.png 같은 경우
          if (/_(\d{1,2})x(\d{1,2})\.(png|jpg|gif|webp)/.test(u)) return false;
          // naturalWidth가 0이면 아직 로딩 전 → URL 패턴이 괜찮으면 허용
          // naturalWidth가 있으면 150px 미만 아이콘 제외
          if (i.width > 0 && i.width < 150) return false;
          // URL에 고해상도 힌트가 있으면 (1600, 1920 등) 명백히 콘텐츠 이미지
          const isHighRes = /[_-](1\d{3}|2\d{3})x/.test(u) || u.includes('/large/') || u.includes('/full/');
          if (isHighRes) return true;
          return true;
        });

        // 중복 제거
        const seen = new Set();
        return filtered.filter(i => {
          const key = i.url.replace(/[?#].*/, '').replace(/-\d{2,4}x\d{2,4}/, '');
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });
      }

      function extractText(root) {
        // ── Eyebrow (AEM: 헤드라인 위의 짧은 카테고리 태그라인) ──
        let eyebrow = '';
        const eyebrowEl = root.querySelector(
          '[class*="__eyebrow"] .cmp-text, [class*="__eyebrow"]');
        if (eyebrowEl) {
          const t = eyebrowEl.innerText?.trim();
          if (t && t.length > 1 && t.length < 100 && !isSkip(t)) eyebrow = t;
        }

        // ── Headline ──
        let hl = '';
        const hlSels = [
          // AEM 전용
          '[class*="__headline"] .cmp-title__text', '[class*="__headline"] .cmp-title',
          '.cmp-title__text', '.cmp-title',
          // 일반
          'h2', 'h3', '[class*="-title"]:not(button)',
          '[class*="-tit"]:not(button)', '[class*="heading"]',
          '.tit', '.title', '.kv-title'
        ];
        for (const sel of hlSels) {
          const el = root.querySelector(sel);
          const t = el?.innerText?.trim();
          if (t && t.length >= 3 && t.length < 200 &&
              !isSkip(t) && !looksLikeClassName(t)) {
            hl = t; break;
          }
        }

        // ── Subheadline ──
        let sub = '';
        for (const sel of ['h3', 'h4', '[class*="sub-title"]', '[class*="subtitle"]', '.sub-tit']) {
          const el = root.querySelector(sel);
          const t = el?.innerText?.trim();
          if (t && t !== hl && t.length >= 3 && t.length < 200 &&
              !looksLikeClassName(t)) { sub = t; break; }
        }

        // ── Body copy ──
        // 1) AEM 전용 bodycopy 셀렉터 우선
        let body = '';
        const aemBodySels = [
          '[class*="__bodycopy"] .cmp-text p',
          '[class*="bodycopy"] .cmp-text p',
          '[class*="__bodycopy"] .cmp-text',
          '[class*="bodycopy"] p',
          '.cmp-text p',
          '.cmp-text',
        ];
        for (const aemSel of aemBodySels) {
          const els = Array.from(root.querySelectorAll(aemSel));
          const texts = els
            .map(el => el.innerText?.trim())
            .filter(t => t && t.length > 20 && t.length < 1000 &&
                        !isSkip(t) && !looksLikeClassName(t) && !t.startsWith('*'));
          if (texts.length > 0) { body = texts.slice(0, 3).join('\n'); break; }
        }

        // 2) AEM bodycopy 없으면 일반 p/desc (depth 제한 완화: 15)
        if (!body) {
          const bodyEls = Array.from(root.querySelectorAll(
              'p, [class*="-desc"], [class*="-body"], [class*="-text"], [class*="description"]'))
            .filter(el => {
              let depth = 0, cur = el;
              while (cur && cur !== root && depth < 16) { cur = cur.parentElement; depth++; }
              return depth < 15;
            });
          body = bodyEls
            .map(el => el.innerText?.trim())
            .filter(t => t && t.length > 20 && t.length < 1000 &&
                        !isSkip(t) && !looksLikeClassName(t) && !t.startsWith('*'))
            .slice(0, 3).join('\n');
        }

        // ── Footnotes (* 로 시작하는 p 태그) → body에 덧붙이기 ──
        const footnotes = Array.from(root.querySelectorAll('p, [class*="footnote"], [class*="disclaimer"]'))
          .map(el => el.innerText?.trim())
          .filter(t => t && t.startsWith('*') && t.length > 10 && t.length < 500)
          .slice(0, 2);
        if (footnotes.length > 0) {
          body = (body ? body + '\n' : '') + footnotes.join('\n');
        }

        // ── Bullets ──
        const bullets = Array.from(root.querySelectorAll('li'))
          .map(el => el.innerText?.trim())
          .filter(t => t && t.length > 3 && t.length < 200 &&
                       !isSkip(t) && !looksLikeNavBullet(t))
          .slice(0, 8);

        // eyebrow는 sub로 활용 (sub 없을 때)
        return { hl, sub: sub || eyebrow, body, bullets };
      }

      // ── 섹션 후보 선정 ────────────────────────────────
      // 헤더/푸터/내비 조상 요소 감지
      function isNavOrFooter(el) {
        let cur = el;
        while (cur && cur !== document.body) {
          const tag = cur.tagName?.toLowerCase();
          if (tag === 'header' || tag === 'footer' || tag === 'nav') return true;
          const cls = (cur.className || '').toLowerCase();
          const id = (cur.id || '').toLowerCase();
          if (/\b(header|footer|nav|navigation|breadcrumb|sitemap)\b/.test(cls)) return true;
          // pdp-specs-section 이후 섹션 (review, FAQ, 추천상품 등) 제외
          if (/review|faq|frequently|recommend|related|support|accessori|compare|bundle|find-a-store/i.test(id)) return true;
          if (/review|faq|frequently|recommend|related|support|accessori|compare|bundle|find-a-store/i.test(cls)) return true;
          // LG PDP 전용: pdp-review, pdp-faq, pdp-support 등
          if (/pdp-(review|faq|support|recommend|compare|bundle|accessory)/i.test(id)) return true;
          if (/pdp-(review|faq|support|recommend|compare|bundle|accessory)/i.test(cls)) return true;
          cur = cur.parentElement;
        }
        return false;
      }

      // 전략 1: LG 전용 클래스 셀렉터 (가장 정확)
      // 중첩 요소 필터 — 리스트 내 다른 요소의 자손인 경우 제거 (래퍼 vs 리프 구분)
      function filterLeafNodes(els) {
        return els.filter(el =>
          els.every(other => other === el || !other.contains(el))
        );
      }

      const SPECIFIC_SELS = [
        // ─── LG DE/EU AEM: c-wrapper (이미지+텍스트가 함께 포함된 단위) ──────
        // LG DE에서는 c-wrapper가 type-bg-image(이미지) + c-floating-contents(텍스트)를
        // 모두 포함하는 최상위 feature 단위. .component 보다 먼저 매칭해야 함.
        '#pdp-overview-section > .c-wrapper, #pdp-overview-section .c-wrapper',

        // ─── LG SA/GCC/Middle East — .component (AEM single class) ─────────
        // LG SA 모든 섹션이 <div class="component ..."> 단위로 분리됨
        //   - .component.type-{pdp|default|gallery|overlay|slim|text}
        //   - .component.column{2|3|4}, .component.standard
        //   - .component (단독, modifier 없음)도 valid 콘텐츠 섹션
        // → main#contents 또는 #pdp-overview-section 안의 .component 만 선택해
        //   네비/푸터/추천 섹션 노이즈 제외, DOM order 보존
        'main#contents .component, #pdp-overview-section .component, [id="contents"] .component',

        // ─── 구형 LG SA / module-item 패턴 (legacy) ──────────────────────
        '.module-item', '.module-kv', '.module-feature', '[class*="module-item"]',

        // ─── LG Levant / 구형 사이트 ──────────────────────────────────────
        '.iw_component', '.component-wrap', '.feature-area',

        // ─── LG UK/EU AEM: c-floating-contents (feature 섹션 단위) ─────────
        // ⚠️ [class*="c-X"] 와일드카드 최소화:
        //    c-hero-banner → __media, __content 자식도 매칭 → 조기 종료 버그
        //    c-media → .c-media__image 등 매칭 → 동일 문제
        // → 정확한 클래스명(.c-floating-contents)만 사용, 와일드카드는 제거
        '.c-floating-contents',
        '.c-product-feature',
        '.c-info-section',
        '.c-media-carousel__item',

        // ─── LG AEM 공통 teaser ───────────────────────────────────────────
        '.cmp-teaser', '[class*="cmp-teaser"]',
        '.cmp-container > .container', '.aem-container',

        // ─── LG UK/EU 일반 ────────────────────────────────────────────────
        '.pdp-feature-item', '.pdp-feature-section', '.product-feature', '.product-benefit',
        '[class*="feature-item"]', '[class*="feature-block"]', '[class*="feature-section"]',

        // ─── LG US ────────────────────────────────────────────────────────
        '.pdp-feature', '[class*="pdp-feature"]',

        // ─── LG 공통 ──────────────────────────────────────────────────────
        '.kv-area', '.kv-feature', '.highlight__item', '.highlight-item',
        '[class*="highlight"][class*="item"]',
        '[class*="reason"][class*="item"]',
        '[class*="benefit"][class*="item"]',

        // ─── AEM section 단위 ─────────────────────────────────────────────
        '[class*="feature"][class*="section"]',

        // ─── 일반 fallback ─────────────────────────────────────────────────
        '.cont-inner', '.inner-container', '.feature-list__item',
      ];

      let sections = [];

      // Strategy 1: LG 전용 셀렉터 — 이미지가 있는 섹션을 최소 1개 이상 포함해야 채택
      for (const sel of SPECIFIC_SELS) {
        try {
          const raw = Array.from(document.querySelectorAll(sel))
            .filter(el => el.offsetHeight > 80 && el.offsetWidth > 100 && !isNavOrFooter(el));
          const found = filterLeafNodes(raw).filter(el => {
            if (el.offsetHeight < 3000) return true;
            // 캐러셀/탭 컨테이너는 슬라이드 그루핑을 위해 더 큰 높이 허용
            const hasCarousel = el.querySelector(
              '[class*="swiper"],[class*="slick"],[class*="carousel"],[class*="-slide"]'
            );
            return hasCarousel && el.offsetHeight < 8000;
          });
          if (found.length >= 2) {
            // 이미지가 포함된 섹션이 하나 이상 있어야 채택 (텍스트 전용 셀렉터 오매칭 방지)
            const hasImgSection = found.some(el => el.querySelectorAll('img').length > 0 || (() => {
              const bg = window.getComputedStyle(el).backgroundImage;
              return bg && bg !== 'none' && bg.includes('url(');
            })());
            if (hasImgSection) {
              sections = found;
              console.log('[analyze] selector:', sel, found.length);
              break;
            }
          }
        } catch (_) {}
      }

      // 전략 2: iw_section 직계 자식 기반 (LG Levant 구조 대응)
      if (sections.length < 2) {
        const iwRoot = document.querySelector('.iw_viewport-wrapper, .iw_section, [class*="iw_section"]');
        if (iwRoot) {
          const candidates = Array.from(iwRoot.querySelectorAll('.iw_component, .component-wrap > *, div[class*="GPC"]'))
            .filter(el => el.offsetHeight > 100 && el.offsetWidth > 200 &&
                          !isNavOrFooter(el) && el.querySelector('h2,h3'));
          if (candidates.length >= 1) {
            sections = filterLeafNodes(candidates);
            console.log('[analyze] iw-component strategy:', sections.length);
          }
        }
      }

      // 전략 3: 컨텐츠 스코어링 — Strategy 1 결과와 무관하게 항상 보완 실행
      // 이유: Strategy 1이 gram Link 카드(c-floating-contents 클래스 공유)를 먼저 찾아
      //       feature-04~06 같은 핵심 섹션이 누락되는 구조적 문제 방지
      {
        const pageRoot = document.querySelector('main, [role="main"], #main, .main-content, .pdp-main, .iw_viewport-wrapper') || document.body;
        const candidates = Array.from(pageRoot.querySelectorAll(
          'section, article, [class*="section"], [class*="block"], [class*="feature"], [class*="banner"], div[class]'
        )).filter(el =>
          el.offsetHeight > 120 && el.offsetHeight < 4000 &&
          el.offsetWidth > 300 && !isNavOrFooter(el)
        );
        const scored = candidates.map(el => {
          const imgCount = el.querySelectorAll('img').length;
          const hasBgImg = (() => {
            try {
              const bg = window.getComputedStyle(el).backgroundImage;
              return bg && bg !== 'none' && bg.includes('url(') &&
                     el.offsetWidth > 400 && el.offsetHeight > 150;
            } catch (_) { return false; }
          })();
          const hasHl  = !!el.querySelector('h1,h2,h3,h4');
          const hasTxt = (el.innerText?.trim().length || 0) > 30;
          const score  = (imgCount > 0 ? 3 : 0) + (hasBgImg ? 3 : 0) + (hasHl ? 2 : 0) + (hasTxt ? 1 : 0);
          return { el, score };
        }).filter(s => s.score >= 3).sort((a, b) => b.score - a.score);

        if (scored.length >= 2) {
          const scoredSections = filterLeafNodes(scored.map(s => s.el));
          if (sections.length < 2) {
            // Strategy 1/2 실패: Strategy 3을 주 전략으로 사용
            sections = scoredSections;
            console.log('[analyze] content-score primary:', sections.length);
          } else {
            // Strategy 1/2 성공: Strategy 3을 보완으로 사용 (누락된 섹션 추가)
            const existing = new Set(sections);
            const additional = scoredSections.filter(el =>
              !existing.has(el) &&
              // Strategy 1 섹션과 부모-자식 관계가 아닌 것만 추가
              !sections.some(s => s.contains(el) || el.contains(s))
            );
            if (additional.length > 0) {
              sections = [...sections, ...additional];
              console.log('[analyze] content-score supplement:', additional.length, 'added');
            }
          }
        }
      }

      // 전략 4: 페이지 루트 직계 자식 (최후 fallback)
      if (sections.length < 2) {
        const mainEl = document.querySelector('main, [role="main"], #main');
        if (mainEl) {
          sections = Array.from(mainEl.children)
            .filter(el => !['SCRIPT','STYLE','NAV','HEADER'].includes(el.tagName) &&
                          el.offsetHeight > 100 && !isNavOrFooter(el));
          console.log('[analyze] fallback main children:', sections.length);
        }
      }

      // ── 서브섹션 분할 헬퍼 ──────────────────────────────────────────────────
      // 하나의 섹션에 여러 H2 그룹(카드 row, 탭 그룹 등)이 있을 때 분할
      function trySplitSection(sec) {
        const h2list = Array.from(sec.querySelectorAll('h2')).filter(h => {
          const t = h.innerText?.trim() || '';
          return t.length >= 5 && t.length < 300 && !isSkip(t) && !looksLikeClassName(t);
        });
        if (h2list.length < 2) return null;

        // 각 H2를 포함하는 sec의 직접 자식 컨테이너를 찾기
        const seenContainers = new Set();
        const groups = [];
        h2list.forEach(h => {
          let cur = h;
          // sec의 직접 자식까지 올라가기
          while (cur.parentElement && cur.parentElement !== sec) cur = cur.parentElement;
          const container = (cur === sec) ? h.parentElement : cur;
          if (!container || container === sec) return;
          if (seenContainers.has(container)) return;
          seenContainers.add(container);
          groups.push(container);
        });

        // 유효한 그룹 (충분한 콘텐츠) 필터링
        const valid = groups.filter(g =>
          g.offsetHeight > 80 &&
          (g.querySelectorAll('img').length > 0 || (g.innerText?.trim().length || 0) > 40)
        );
        if (valid.length >= 2) return valid;

        // Fallback: sec의 직접 자식 중 heading + (img or 텍스트) 포함하는 블록
        const children = Array.from(sec.children).filter(child =>
          child.offsetHeight > 80 &&
          child.querySelector('h2,h3,h4') &&
          (child.querySelectorAll('img').length > 0 || (child.innerText?.trim().length || 0) > 40)
        );
        if (children.length >= 2) return children;

        return null;
      }

      // ── 카드 그룹 이미지 + 텍스트 추출 헬퍼 ──────────────────────────────
      // 섹션 내 반복 카드(h3/h4+img 패턴)를 모두 모아 items 배열로 반환
      function extractCardItems(sec) {
        // 카드 아이템을 담는 컨테이너 후보 (swiper/slick 포함)
        const CARD_CONTAINER_SELS = [
          // 캐러셀/슬라이더 래퍼 (최우선 — swiper-slide의 직접 부모)
          '[class*="swiper-wrapper"]', '[class*="swiper-container"]',
          '[class*="slick-track"]', '[class*="slick-list"]',
          // LG SA AEM: c-list / cmp-carousel (column-N 내부)
          '.c-list', '.c-list.swiper-wrapper', '.cmp-carousel',
          '.carousel.panelcontainer',
          // 일반 카드 컨테이너
          '[class*="card-list"]', '[class*="cards"]',
          '[class*="tab-content"]', '[class*="slide-content"]',
          '[class*="items"]', '[class*="grid"]', 'ul',
        ];
        // 카드 아이템 후보 (offsetHeight 무조건 체크)
        const CARD_ITEM_SELS = [
          '[class*="swiper-slide"]', '[class*="slick-slide"]',
          // LG SA: c-list__item (swiper-slide와 함께 등장하지만 단독 매칭도 지원)
          '.c-list__item',
          '[class*="card"]', '[class*="-slide"]', '[class*="-item"]', 'li',
        ];
        let cards = [];

        // 1) 카드 컨테이너 → 직접 자식 카드 탐색
        for (const cSel of CARD_CONTAINER_SELS) {
          const cont = sec.querySelector(cSel);
          if (!cont) continue;
          for (const iSel of CARD_ITEM_SELS) {
            const items = Array.from(cont.querySelectorAll(':scope > ' + iSel))
              // offsetHeight > 0 (display:block으로 전환된 슬라이드는 높이 있음)
              .filter(el => el.offsetHeight > 0 && el.querySelector('img'));
            if (items.length >= 2) { cards = items; break; }
          }
          if (cards.length >= 2) break;
        }

        // 2) 컨테이너 없으면 섹션 전체에서 비직접 자식까지 탐색
        if (cards.length < 2) {
          for (const iSel of CARD_ITEM_SELS) {
            const items = Array.from(sec.querySelectorAll(iSel))
              .filter(el => el.offsetHeight > 0 && el.querySelector('img'));
            if (items.length >= 2) {
              // 최상위 카드만 남기기 (중첩 카드 제거)
              const topLevel = items.filter(el =>
                items.every(other => other === el || !other.contains(el))
              );
              if (topLevel.length >= 2) { cards = topLevel; break; }
            }
          }
        }

        if (cards.length < 2) return null;

        return cards.map(card => {
          const img = card.querySelector('img');
          const src = img ? bestSrc(img) : '';
          // LG SA: .c-text-contents 내부 헤드라인/바디 우선 매핑
          const textContents = card.querySelector('.c-text-contents');
          const lookupRoot = textContents || card;
          // AEM cmp-title 우선, 그 다음 일반 heading
          const titleEl =
            lookupRoot.querySelector('[class*="__headline"] .cmp-title__text, [class*="__headline"] .cmp-title, .cmp-title__text, .cmp-title') ||
            lookupRoot.querySelector('h2,h3,h4,h5,strong,[class*="title"],[class*="tit"]');
          // AEM bodycopy 우선
          const bodyEl =
            lookupRoot.querySelector('[class*="__bodycopy"] .cmp-text p, [class*="bodycopy"] p, .cmp-text p') ||
            lookupRoot.querySelector('p,[class*="desc"],[class*="body"]');
          return {
            imageUrl: src || '',
            title: (titleEl?.innerText || '').trim(),
            body:  (bodyEl?.innerText || '').trim(),
          };
        }).filter(item => item.imageUrl || item.title);
      }

      // ── 섹션 → feature 변환 ────────────────────────────
      const result = [];
      const seenHl  = new Set();
      const seenImg = new Set();
      let featureIdx = 0;

      function processSection(sec, extraImgSources = []) {
        const idx = featureIdx++;
        const { hl, sub, body, bullets } = extractText(sec);

        // 스킵 조건들
        if (isSkip(hl) || isSkip(sub)) return;
        if (looksLikeClassName(hl)) return;
        if (hl && /^[A-Z]{2,}$/.test(hl.trim())) return;
        if (!hl && !body && bullets.length === 0) return;
        if (hl && seenHl.has(hl.toLowerCase())) return;

        // body가 디스클레이머/면책 문구로만 구성된 경우 스킵
        // (예: "Features vary by model", "*Product images...", "Design, features and...")
        const bodyDisclaimerPatterns = [
          /^features vary by model/i,
          /^specifications? (are |is )?subject to (change|modification)/i,
          /^design,?\s*features?\s*(and|&)\s*specifications/i,
          /^\*?actual product may/i,
          /^\*?product images? (in|on) the/i,
          /^\*?the images? (above|in this|on this)/i,
          /^please consult/i,
          /^all images are for illustrative/i,
          /^screen images? (are )?simulated/i,
        ];
        const bodyTrim = (body || '').trim();
        if ((!hl || hl.length < 5) && bodyTrim &&
            bodyDisclaimerPatterns.some(p => p.test(bodyTrim))) return;
        // 헤드라인 없이 body가 *(footnote)로만 시작하면 스킵
        if (!hl && bodyTrim.startsWith('*') && bodyTrim.length < 600) return;

        if (hl) seenHl.add(hl.toLowerCase());

        // 카드 아이템 수집 (3~4장 카드 패턴 우선)
        const cardItems = extractCardItems(sec);

        // 모든 카드의 이미지가 SVG 아이콘이면 지원/메뉴 섹션 → 스킵
        if (cardItems && cardItems.length >= 2 &&
            cardItems.every(c => /\.svg(\?|$)/i.test(c.imageUrl || ''))) return;

        // 카드 제목이 모두 "[N inch] LG ..." 같은 제품 추천 패턴이면 스킵
        // (예: "98 Inch LG UHD UT90 4K Smart TV..." — 추천 상품 캐러셀)
        if (cardItems && cardItems.length >= 3 &&
            cardItems.filter(c =>
              /^\d+\s*("|inch|cm)\s+lg\b/i.test((c.title || '').trim())
            ).length >= Math.ceil(cardItems.length * 0.6)) return;

        // 메인 섹션 + 인접 image-only 형제 섹션의 이미지를 함께 수집
        // (LG SG: section-title 컴포넌트가 이미지 컴포넌트와 형제로 분리되는 케이스 대응)
        const allSrcs = [sec, ...(extraImgSources || [])];
        let imgs = allSrcs.flatMap(s => extractImgs(s))
          .filter(i => !seenImg.has(i.url.replace(/[?#].*/, '')))
          .slice(0, 6);

        // LG DE: 섹션에 이미지가 없으면 부모/형제 컨테이너에서 탐색
        if (imgs.length === 0 && typeof _findParentImages === 'function') {
          const parentImgEls = _findParentImages(sec);
          if (parentImgEls.length > 0) {
            const parentImgs = parentImgEls.map(img => {
              const src = bestSrc(img);
              if (!src || seenImg.has(src.replace(/[?#].*/, ''))) return null;
              const w = img.naturalWidth || +img.getAttribute('width') || 0;
              const h = img.naturalHeight || +img.getAttribute('height') || 0;
              return { url: src, width: w, height: h, ar: w > 0 && h > 0 ? +(w/h).toFixed(3) : 0, alt: img.alt || '', nearText: '' };
            }).filter(Boolean);
            imgs = parentImgs.slice(0, 4);
          }
        }

        imgs.forEach(i => seenImg.add(i.url.replace(/[?#].*/, '')));

        if (imgs.length === 0 && !hl && (!body || body.length < 80)) return;
        if (imgs.length === 0 && (!body || body.length < 30) && bullets.length < 2) return;
        if (hl && body && imgs.length === 0) {
          const hlNorm = hl.toLowerCase().replace(/\s+/g, ' ');
          const bodyNorm = body.toLowerCase().replace(/\s+/g, ' ');
          if (bodyNorm.split(hlNorm).length > 2) return;
        }

        let cleanBody = body;
        if (hl && body) {
          const hlNorm = hl.toLowerCase().trim();
          const lines = body.split('\n').filter(line => {
            const l = line.toLowerCase().trim();
            return l !== hlNorm && l.length > 0;
          });
          cleanBody = lines.join('\n').trim();
        }

        const sortedImgs = [...imgs].sort((a, b) => {
          const sa = (a.width || 0) + (a.ar >= 0.5 && a.ar <= 4 ? 1000 : 0);
          const sb = (b.width || 0) + (b.ar >= 0.5 && b.ar <= 4 ? 1000 : 0);
          return sb - sa;
        });

        // ── 레이아웃 분석: 행당 이미지 개수 + 풀폭 여부 ─────────────────
        // PDP 실제 렌더링 기준으로 모듈 선택 (한 행에 N개 → N-image 모듈)
        // imgsPerRow = "가로로 나란히 연속된 이미지 개수" (진짜 가로 행만 카운트).
        //  · 같은 행(rt 근사) + 서로 다른 left(겹치지 않음) + 썸네일 폭(섹션의 절반 이하)
        //  → 캐러셀(같은 위치 겹침)·풀폭 단일 이미지는 행으로 오인하지 않음.
        let layout = { imgsPerRow: 0, fullWidth: false };
        try {
          let secW = 0, secLeft = 0;
          try { const sr = sec.getBoundingClientRect(); secW = Math.round(sr.width); secLeft = Math.round(sr.left + (window.scrollX || 0)); } catch (_) {}
          const secRight = secLeft + secW;
          const withGeo = sortedImgs.filter(i => i.rw > 0 && i.rt >= 0 && typeof i.rl === 'number');
          if (withGeo.length > 0 && secW > 0) {
            // rt(렌더 top) 30px 단위로 묶어 같은 행 그룹핑
            const rowMap = {};
            withGeo.forEach(i => {
              const key = Math.round(i.rt / 30);
              (rowMap[key] = rowMap[key] || []).push(i);
            });
            let maxRow = 1;
            Object.values(rowMap).forEach(row => {
              // 후보: ① 썸네일(섹션 폭 55% 이하) ② 섹션 가시영역 안 (캐러셀 트랙의
              //       화면 밖 슬라이드 제외 — 절반 이상이 섹션 폭 안에 보여야 함)
              const thumbs = row.filter(i =>
                i.rw <= 0.55 * secW &&
                i.rl >= secLeft - i.rw * 0.5 &&
                i.rl + i.rw * 0.5 <= secRight + 1
              );
              if (thumbs.length < 2) return;
              // left 기준 정렬 후 겹치지 않는(서로 다른 위치) 이미지만 카운트
              thumbs.sort((a, b) => a.rl - b.rl);
              let count = 1, lastRight = thumbs[0].rl + thumbs[0].rw;
              for (let k = 1; k < thumbs.length; k++) {
                if (thumbs[k].rl >= lastRight - thumbs[k].rw * 0.4) { // 가로로 분리됨
                  count++;
                  lastRight = thumbs[k].rl + thumbs[k].rw;
                }
              }
              if (count > maxRow) maxRow = count;
            });
            // 풀폭: 이미지 절반 이상이 섹션 너비의 60% 이상을 차지
            const fwCount = withGeo.filter(i => i.rw >= 0.6 * secW).length;
            layout = {
              imgsPerRow: maxRow,
              fullWidth: fwCount >= Math.ceil(withGeo.length / 2),
            };
          }
        } catch (_) {}

        result.push({
          id: `f${idx}`,
          order: idx,
          headline: hl,
          subheadline: sub,
          body: cleanBody,
          bullets,
          images: sortedImgs,
          layout,
          // 카드 아이템이 있으면 포함 (three-img/four-text 모듈에 직접 매핑)
          cardItems: cardItems && cardItems.length >= 2 ? cardItems : undefined,
        });
      }

      // ── 인접 섹션 병합: title-only ↔ image-only 페어링 ───────────────
      // LG SG/일부 PDP는 section-title 컴포넌트와 이미지 컴포넌트를
      // 형제(sibling)로 분리해 작성. 이를 단일 feature 로 병합해야
      // "Select A+ Content Sections"에서 이미지가 누락되지 않음.
      function _hasMeaningfulImg(s) {
        try {
          // <img> 중 sprite/icon 제외, 실측 ≥ 100×80 또는 picture 안에 있는 것
          const imgs = Array.from(s.querySelectorAll('img'));
          if (imgs.some(i => {
            const src = (i.getAttribute('src') || i.currentSrc || '').toLowerCase();
            if (/icon|logo|sprite|\.svg/.test(src)) return false;
            if (i.closest('picture')) return true;
            const w = i.naturalWidth || +i.getAttribute('width') || 0;
            const h = i.naturalHeight || +i.getAttribute('height') || 0;
            return (w >= 200 && h >= 100);
          })) return true;
          // background-image
          const bg = window.getComputedStyle(s).backgroundImage;
          if (bg && bg !== 'none' && bg.includes('url(') &&
              s.offsetWidth >= 400 && s.offsetHeight >= 200) return true;
          return false;
        } catch (_) { return false; }
      }
      function _hasOwnHeading(s) {
        const hs = Array.from(s.querySelectorAll('h1,h2,h3,h4,.cmp-title__text'));
        return hs.some(h => {
          const t = (h.innerText || '').trim();
          return t.length >= 5 && t.length < 300;
        });
      }
      function _isSectionTitleWrapper(s) {
        // c-wrapper 조상 중 type-section-title 클래스 보유
        let cur = s;
        for (let d = 0; d < 4 && cur; d++, cur = cur.parentElement) {
          const cls = (cur.className || '').toString();
          if (/type-section-title|type-template-title|section-title/.test(cls)) return true;
        }
        return false;
      }

      // DOM 순서로 정렬 (compareDocumentPosition)
      const sectionsInDom = [...sections].sort((a, b) => {
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });

      const mergedInto    = new Map();   // titleSec → [imgOnlySec, ...]
      const consumedAsImg = new Set();   // forEach 단계에서 스킵
      let pendingTitle    = null;
      let stepsSincePending = 0;

      sectionsInDom.forEach(sec => {
        if (consumedAsImg.has(sec)) return;
        const hasH = _hasOwnHeading(sec);
        const hasI = _hasMeaningfulImg(sec);

        if (pendingTitle) {
          stepsSincePending++;
          if (stepsSincePending > 10) { pendingTitle = null; stepsSincePending = 0; }
        }

        if (hasH && !hasI) {
          // title-only 섹션: 다음 image-only 섹션을 기다림
          // primary section-title (c-wrapper.type-section-title) 이 sub-card 의 h2 로
          // 덮어써지지 않도록 우선순위 처리
          const candIsPrimary = _isSectionTitleWrapper(sec);
          const pendIsPrimary = pendingTitle && _isSectionTitleWrapper(pendingTitle);
          if (!pendingTitle || candIsPrimary || !pendIsPrimary) {
            pendingTitle = sec;
            stepsSincePending = 0;
          }
          // pendingTitle 이 primary 인데 candIsPrimary 가 아니면 유지
        } else if (!hasH && hasI && pendingTitle) {
          // image-only 섹션: 가장 최근 pending title 에 흡수
          if (!mergedInto.has(pendingTitle)) mergedInto.set(pendingTitle, []);
          mergedInto.get(pendingTitle).push(sec);
          consumedAsImg.add(sec);
          // 한 title 당 최대 3개 흡수 후 페어링 종료
          if (mergedInto.get(pendingTitle).length >= 3) {
            pendingTitle = null;
            stepsSincePending = 0;
          }
        } else if (hasH && hasI) {
          // 자체적으로 완비된 섹션: pending 종료 — 단, primary pending 은
          // sub-card 자체완비 섹션으로 인해 잃지 않도록 보호
          const pendIsPrimary = pendingTitle && _isSectionTitleWrapper(pendingTitle);
          const candIsPrimary = _isSectionTitleWrapper(sec);
          if (!pendIsPrimary || candIsPrimary) {
            pendingTitle = null;
            stepsSincePending = 0;
          }
        }
      });

      console.log('[analyze] section-title ↔ image-only pairs merged:',
        [...mergedInto.values()].reduce((a, v) => a + v.length, 0));

      // c-floating-contents__floating(텍스트) ↔ __floor(이미지) 동일 부모 페어링
      // LG SG: c-floating-contents 안에서 floating(text) 와 floor(image) 가
      // 형제로 분리되어 있는 케이스. floor 를 extras 로 주입.
      function _findFloatingFloorSibling(sec) {
        try {
          const cls = (sec.className || '').toString();
          if (!cls.includes('c-floating-contents__floating')) return null;
          // 부모 c-floating-contents 탐색
          let parent = sec.parentElement;
          for (let d = 0; d < 4 && parent; d++, parent = parent.parentElement) {
            const pc = (parent.className || '').toString();
            if (pc.includes('c-floating-contents') && !pc.includes('__floating') && !pc.includes('__floor')) {
              break;
            }
          }
          if (!parent) return null;
          // 부모 내 __floor 자손 중 첫 번째
          const floor = parent.querySelector('.c-floating-contents__floor, [class*="c-floating-contents__floor"]');
          if (floor && floor !== sec && !sec.contains(floor)) return floor;
          return null;
        } catch (_) { return null; }
      }

      // ── 섹션에 이미지 없을 때 부모/형제에서 이미지 찾기 ──────────────
      // LG DE: c-floating-contents(텍스트)가 component.type-bg-image(이미지) 안에 중첩
      // 또는 형제 c-wrapper/component에 이미지가 있는 경우
      function _findParentImages(sec) {
        const found = [];
        // 1) 부모 체인에서 이미지를 가진 컨테이너 탐색 (최대 6단계)
        let cur = sec.parentElement;
        for (let d = 0; d < 6 && cur && cur !== document.body; d++, cur = cur.parentElement) {
          // 부모의 모든 img 중 현재 섹션 밖에 있는 것
          const imgs = Array.from(cur.querySelectorAll('img'));
          const outsideImgs = imgs.filter(img => !sec.contains(img));
          outsideImgs.forEach(img => {
            const src = img.src || img.getAttribute('data-src') || '';
            if (!src || src.startsWith('data:')) return;
            if (/icon|logo|sprite|\.svg|1x1|loading/i.test(src)) return;
            const nw = img.naturalWidth || 0;
            if (nw > 0 && nw < 80) return; // tiny icons
            found.push(img);
          });
          if (found.length > 0) break;
          
          // 부모의 background-image도 체크
          try {
            const bg = window.getComputedStyle(cur).backgroundImage;
            if (bg && bg !== 'none' && bg.includes('url(') && !bg.includes('gradient') &&
                cur.offsetWidth >= 300 && cur.offsetHeight >= 150) {
              // background-image는 img 요소가 아니므로 extractImgs에서 처리됨
              // 여기서는 부모를 extraImgSources에 추가할 수 있도록 마커만 남김
              found._parentContainer = cur;
              break;
            }
          } catch(_) {}
        }
        
        // 2) 같은 부모의 형제(모든 방향) 탐색
        if (found.length === 0) {
          const parent = sec.parentElement;
          if (parent) {
            Array.from(parent.children).forEach(sibling => {
              if (sibling === sec || sec.contains(sibling)) return;
              sibling.querySelectorAll('img').forEach(img => {
                const src = img.src || img.getAttribute('data-src') || '';
                if (!src || src.startsWith('data:')) return;
                if (/icon|logo|sprite|\.svg|1x1|loading/i.test(src)) return;
                const nw = img.naturalWidth || 0;
                if (nw > 0 && nw < 80) return;
                found.push(img);
              });
            });
          }
        }
        
        // 3) 한 단계 더 위의 부모의 형제도 탐색 (c-wrapper가 형제인 경우)
        if (found.length === 0 && sec.parentElement) {
          const grandParent = sec.parentElement.parentElement;
          if (grandParent && grandParent !== document.body) {
            Array.from(grandParent.children).forEach(sibling => {
              if (sibling.contains(sec)) return;
              sibling.querySelectorAll('img').forEach(img => {
                const src = img.src || img.getAttribute('data-src') || '';
                if (!src || src.startsWith('data:')) return;
                if (/icon|logo|sprite|\.svg|1x1|loading/i.test(src)) return;
                const nw = img.naturalWidth || 0;
                if (nw > 0 && nw < 80) return;
                found.push(img);
              });
            });
          }
        }
        
        return found;
      }

      sections.forEach(sec => {
        if (consumedAsImg.has(sec)) return;
        const extras = mergedInto.get(sec) || [];
        // floating ↔ floor 페어링 추가
        const floor = _findFloatingFloorSibling(sec);
        if (floor) extras.push(floor);
        // 서브섹션 분할 시도 (H2 그룹이 2개 이상인 경우)
        const subSections = trySplitSection(sec);
        if (subSections) {
          console.log('[analyze] split section →', subSections.length, 'sub-sections');
          subSections.forEach(sub => processSection(sub));
        } else {
          processSection(sec, extras);
        }
      });

      return result;
    });

    console.log(`[analyze] ${url} → ${features.length} features`);
    res.json({ features, url });
  } catch (e) {
    console.error('/api/analyze error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    await browser.close();
  }
});

/* ── eBay Clone (콘텐츠 추출 + 레이아웃 감지 + HTML 생성) ── */
require('./ebay-clone-handler')(app, puppeteer);

/* ──────────────────────────────────────────
   eBay 전용 PDP 크롤러 — 부모 wrapper 단위로 이미지+텍스트 매칭
   /api/analyze 의 복잡한 섹션 분할 대신,
   wrapper div 단위로 단순하게 이미지+텍스트를 함께 추출
────────────────────────────────────────── */
app.post('/api/ebay-analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled', '--disable-web-security',
           '--lang=en-US,en']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

    console.log(`[ebay-analyze] Navigating: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
      console.warn('[ebay-analyze] networkidle2 timeout, continuing with loaded content:', e.message);
    }
    // SPA hydration 안정화 대기
    await new Promise(r => setTimeout(r, 5000));

    // Cookie 동의 클릭
    try {
      const cookieBtn = await page.$('[class*="cookie"] button, [id*="cookie"] button, #onetrust-accept-btn-handler, .accept-all, [class*="consent"] button');
      if (cookieBtn) await cookieBtn.click();
    } catch (_) {}

    // 전체 스크롤 (lazy loading 트리거)
    await page.evaluate(async () => {
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const totalHeight = document.body.scrollHeight;
      for (let y = 0; y < totalHeight; y += 600) {
        window.scrollTo(0, y);
        await delay(300);
      }
      window.scrollTo(0, 0);
      await delay(1000);
    });

    // lazy-loaded img src 주입
    await page.evaluate(() => {
      document.querySelectorAll('img').forEach(img => {
        ['data-src', 'data-lazy-src', 'data-original', 'data-lazy'].forEach(attr => {
          const val = img.getAttribute(attr);
          if (val && (!img.src || img.naturalWidth <= 1)) img.src = val;
        });
      });
    });
    await new Promise(r => setTimeout(r, 2000));

    // ── 비디오 프레임 캡처 (poster 없는 video → canvas → base64) ──
    const videoFrames = await page.evaluate(async () => {
      const frames = {};
      const videos = document.querySelectorAll('video');
      for (const vid of videos) {
        try {
          const src = vid.src || (vid.querySelector('source')?.src) || '';
          if (!src) continue;
          // 이미 poster가 있으면 스킵
          if (vid.poster || vid.getAttribute('data-poster')) continue;
          // 비디오 로드
          vid.muted = true;
          vid.crossOrigin = 'anonymous';
          if (vid.readyState < 2) {
            vid.load();
            await new Promise(r => {
              vid.addEventListener('loadeddata', r, { once: true });
              setTimeout(r, 3000); // 최대 3초 대기
            });
          }
          // 1초 지점으로 이동
          vid.currentTime = 1;
          await new Promise(r => {
            vid.addEventListener('seeked', r, { once: true });
            setTimeout(r, 2000);
          });
          // canvas에 프레임 그리기
          const w = vid.videoWidth || vid.offsetWidth || 640;
          const h = vid.videoHeight || vid.offsetHeight || 360;
          if (w < 10 || h < 10) continue;
          const canvas = document.createElement('canvas');
          canvas.width = Math.min(w, 800); // 최대 800px
          canvas.height = Math.round(h * (canvas.width / w));
          const ctx = canvas.getContext('2d');
          ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          // tainted canvas 체크 (CORS 오류 시 빈 이미지)
          if (dataUrl && dataUrl.length > 100) {
            frames[src] = dataUrl;
          }
        } catch (e) {
          // CORS or other error — skip
        }
      }
      return frames;
    });
    console.log(`[ebay-analyze] Captured ${Object.keys(videoFrames).length} video frames`);

    // ── 비디오 프레임을 파일로 저장 (eBay 호환용) ──
    const fs = require('fs');
    const path = require('path');
    const framesDir = path.join(__dirname, 'ebay-listing', 'video-frames');
    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

    const videoFrameUrls = {};
    Object.entries(videoFrames).forEach(([src, dataUrl], idx) => {
      try {
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        const filename = `frame-${Date.now()}-${idx}.jpg`;
        fs.writeFileSync(path.join(framesDir, filename), Buffer.from(base64, 'base64'));
        videoFrameUrls[src] = `/ebay-listing/video-frames/${filename}`;
      } catch (_) {}
    });

    // ── 섹션 추출 (wrapper 단위) ──
    const videoFrameMap = videoFrameUrls; // pass to evaluate via closure
    const features = await page.evaluate((vfMap) => {
      const SKIP_IDS = /review|faq|frequently|recommend|related|support|accessori|compare|bundle|find-a-store|footer|header|nav|breadcrumb/i;

      function isSkipSection(el) {
        let cur = el;
        while (cur && cur !== document.body) {
          if (SKIP_IDS.test(cur.id || '') || SKIP_IDS.test(cur.className || '')) return true;
          const tag = cur.tagName?.toLowerCase();
          if (tag === 'header' || tag === 'footer' || tag === 'nav') return true;
          cur = cur.parentElement;
        }
        return false;
      }

      function bestImgSrc(img) {
        // picture > source (desktop first)
        const picture = img.closest('picture');
        if (picture) {
          const sources = picture.querySelectorAll('source');
          let best = '';
          sources.forEach(s => {
            const media = s.getAttribute('media') || '';
            const srcset = s.srcset || s.getAttribute('data-srcset') || '';
            if (srcset && (!media || media.includes('min-width'))) {
              best = srcset.split(',')[0].trim().split(' ')[0];
            }
          });
          if (best) return best.startsWith('/') ? location.origin + best : best;
        }
        // direct src
        let src = img.src || img.getAttribute('data-src') || img.currentSrc || '';
        if (src.startsWith('/')) src = location.origin + src;
        return src;
      }

      function getImages(container) {
        const imgs = [];
        const seen = new Set();
        
        // 1) <img> elements
        container.querySelectorAll('img').forEach(img => {
          const src = bestImgSrc(img);
          if (!src || src.startsWith('data:') || seen.has(src)) return;
          if (/logo|sprite|1x1|flag/i.test(src)) return;
          if (/\.svg/i.test(src)) {
            const nw = img.naturalWidth || parseInt(img.getAttribute('width')) || 0;
            if (nw > 0 && nw < 40) return;
          }
          if (/loading\.(gif|png|svg)|loading[-_]?(spinner|icon|placeholder|indicator)/i.test(src)) return;
          const nw = img.naturalWidth || parseInt(img.getAttribute('width')) || 0;
          if (nw > 0 && nw < 80) return;
          seen.add(src);
          imgs.push({ url: src, alt: img.alt || '', width: nw });
        });
        
        // 2) <video> poster images + captured video frames
        container.querySelectorAll('video').forEach(vid => {
          const poster = vid.poster || vid.getAttribute('data-poster') || '';
          if (poster && !poster.startsWith('data:') && !seen.has(poster)) {
            let url = poster.startsWith('/') ? location.origin + poster : poster;
            seen.add(url);
            imgs.push({ url, alt: 'video poster', width: 0 });
            return;
          }
          // No poster → use captured video frame
          const vidSrc = vid.src || (vid.querySelector('source')?.src) || '';
          if (vidSrc && vfMap[vidSrc] && !seen.has(vfMap[vidSrc])) {
            const frameUrl = location.origin + vfMap[vidSrc];
            seen.add(frameUrl);
            imgs.push({ url: frameUrl, alt: 'video frame', width: 800 });
          }
        });
        
        // 3) background-image on container AND children
        if (imgs.length === 0) {
          const elements = [container, ...Array.from(container.querySelectorAll('*')).slice(0, 50)];
          for (const el of elements) {
            try {
              const bg = window.getComputedStyle(el).backgroundImage;
              if (bg && bg !== 'none' && bg.includes('url(') && !bg.includes('gradient')) {
                let bgUrl = bg.match(/url\(["']?(.+?)["']?\)/)?.[1] || '';
                if (bgUrl && !bgUrl.startsWith('data:') && !seen.has(bgUrl)) {
                  if (bgUrl.startsWith('/')) bgUrl = location.origin + bgUrl;
                  // Only add if element is reasonably sized (not tiny icons)
                  if (el.offsetWidth >= 100 && el.offsetHeight >= 60) {
                    seen.add(bgUrl);
                    imgs.push({ url: bgUrl, alt: '', width: el.offsetWidth });
                  }
                }
              }
            } catch (_) {}
            if (imgs.length >= 4) break;
          }
        }
        
        return imgs;
      }

      function getText(container) {
        let headline = '';
        let subheadline = '';
        let body = '';

        const h = container.querySelector('h1, h2, h3, h4, .cmp-title__text');
        if (h) headline = h.innerText?.trim() || '';

        // subheadline: p after h, or smaller heading
        const allH = container.querySelectorAll('h1, h2, h3, h4, h5');
        if (allH.length >= 2) subheadline = allH[1].innerText?.trim() || '';

        // body text from paragraphs
        const ps = container.querySelectorAll('p, .cmp-text, [class*="description"], [class*="body-text"]');
        const bodyParts = [];
        ps.forEach(p => {
          const t = (p.innerText || '').trim();
          if (t.length > 10 && t !== headline && t !== subheadline) bodyParts.push(t);
        });
        body = bodyParts.join('\n').substring(0, 800);

        // bullets
        const bullets = [];
        container.querySelectorAll('li').forEach(li => {
          const t = (li.innerText || '').trim();
          if (t.length > 5 && t.length < 300) bullets.push(t);
        });

        return { headline, subheadline, body, bullets: bullets.slice(0, 8) };
      }

      // ── 1. PDP overview 영역 찾기 ──
      const root = document.querySelector('#pdp-overview-section') ||
                   document.querySelector('[class*="pdp-overview"]') ||
                   document.querySelector('main#contents') ||
                   document.querySelector('main') ||
                   document.body;

      // ── 2. 최상위 wrapper 단위로 섹션 분할 ──
      // 우선순위: c-wrapper > component > section > direct children
      let wrappers = [];

      // Strategy A: c-wrapper (LG DE/EU)
      wrappers = Array.from(root.querySelectorAll(':scope > .c-wrapper, :scope > div > .c-wrapper'));
      if (wrappers.length < 2) {
        wrappers = Array.from(root.querySelectorAll('.c-wrapper'));
      }

      // Strategy B: .component (LG SA/GCC)
      if (wrappers.length < 2) {
        wrappers = Array.from(root.querySelectorAll(':scope > .component, :scope > div > .component'));
        if (wrappers.length < 2) {
          wrappers = Array.from(root.querySelectorAll('.component'));
        }
      }

      // Strategy C: section tags
      if (wrappers.length < 2) {
        wrappers = Array.from(root.querySelectorAll(':scope > section, :scope > div > section'));
      }

      // Strategy D: direct div children with meaningful content
      if (wrappers.length < 2) {
        wrappers = Array.from(root.querySelectorAll(':scope > div')).filter(d =>
          d.offsetHeight > 100 && (d.querySelector('img') || d.querySelector('h2, h3'))
        );
      }

      console.log('[ebay-analyze] Found', wrappers.length, 'wrappers');

      // ── 3. 각 wrapper에서 이미지+텍스트 추출 ──
      const result = [];
      const seenImgs = new Set();
      const seenHeadlines = new Set();

      // 중첩 wrapper 제거 (leaf nodes only)
      const rawLeafWrappers = wrappers.filter(w =>
        !wrappers.some(other => other !== w && other.contains(w))
      ).filter(w => w.offsetHeight > 50 && !isSkipSection(w));

      // 빈/disclaimer wrapper 제거 (ST0010 등: 헤드라인도 이미지도 body도 없는 것)
      const leafWrappers = rawLeafWrappers.filter(w => {
        const text = getText(w);
        const imgs = getImages(w);
        const hasContent = text.headline.length > 3 || text.body.length > 20 || imgs.length > 0;
        return hasContent;
      });

      console.log('[ebay-analyze] leafWrappers after filter:', leafWrappers.length);

      // ── 인접 title-only + image-only wrapper 병합 ──
      // LG DE 패턴: ST0003(title) → ST0001(image) — 이제 빈 ST0010이 제거되어 인접
      const merged = [];
      const consumed = new Set();

      leafWrappers.forEach((w, i) => {
        if (consumed.has(i)) return;
        const imgs = getImages(w);
        const text = getText(w);
        const hasImg = imgs.length > 0;
        const hasText = text.headline.length > 3 || text.body.length > 20;

        // Case 1: title-only → 다음에서 image-only 찾기 (최대 2칸 앞)
        if (hasText && !hasImg) {
          for (let j = i + 1; j < Math.min(i + 3, leafWrappers.length); j++) {
            if (consumed.has(j)) continue;
            const nextImgs = getImages(leafWrappers[j]);
            const nextText = getText(leafWrappers[j]);
            if (nextImgs.length > 0 && nextText.headline.length <= 3) {
              // Merge: title from current + images from next
              // Also merge any body/sub from the image wrapper
              const mergedText = {
                headline: text.headline,
                subheadline: text.subheadline || nextText.subheadline,
                body: text.body || nextText.body,
                bullets: [...text.bullets, ...nextText.bullets].slice(0, 8),
              };
              merged.push({ text: mergedText, imgs: nextImgs });
              consumed.add(j);
              consumed.add(i);
              break;
            }
          }
          if (!consumed.has(i)) {
            // No image partner found, push text-only
            merged.push({ text, imgs: [] });
            consumed.add(i);
          }
          return;
        }

        // Case 2: image-only → 이전에서 title 찾기 (이미 병합 안 된 것)
        if (hasImg && !hasText) {
          // Check if already merged by a title wrapper above
          // If not, push as image-only section
          merged.push({ text, imgs });
          consumed.add(i);
          return;
        }

        // Case 3: both image + text in same wrapper (ideal)
        merged.push({ text, imgs });
        consumed.add(i);
      });

      merged.forEach(({ text, imgs }) => {
        const { headline, subheadline, body, bullets } = text;

        // Skip duplicates and noise
        if (headline && seenHeadlines.has(headline.toLowerCase())) return;
        if (!headline && !body && imgs.length === 0) return;
        if (/cookie|consent|privacy|sign in|newsletter|subscribe/i.test(headline + body)) return;
        if (/WEITERE INFORMATION ZUR COMPLIANCE/i.test(body)) return;

        if (headline) seenHeadlines.add(headline.toLowerCase());

        // Deduplicate images
        const uniqueImgs = imgs.filter(img => {
          const key = img.url.replace(/[?#].*/, '');
          if (seenImgs.has(key)) return false;
          seenImgs.add(key);
          return true;
        });

        result.push({
          headline: headline || '',
          subheadline: subheadline || '',
          body: body || '',
          bullets,
          images: uniqueImgs.slice(0, 4),
        });
      });

      return result;
    }, videoFrameMap);

    // ── CCG 컴포넌트 스캔 (별도 pass — 기존 추출 로직 무손상) ─────────────
    // 각 c-wrapper/component의 CCG ID(ST0001·PD0012 등) + 레이아웃 타입을 수집해
    // feature에 매칭 → generate가 닷컴 컴포넌트 레이아웃대로 렌더하게 한다.
    let components = [];
    try {
      components = await page.evaluate(() => {
        const LAYOUT = {
          ST0001:'hero', ST0002:'hero', ST0008:'hero', ST0009:'hero',
          ST0004:'text_over_image', ST0005:'grid', ST0007:'grid',
          ST0011:'image_text_left', ST0013:'image_text_right',
          ST0016:'accordion', ST0027:'icon_grid', ST0036:'tab', ST0048:'carousel',
          PD0012:'product_gallery', PD0033:'tab', PD0008:'spec_table', PD0053:'tab',
        };
        const seenEl = new Set(), out = [];
        document.querySelectorAll('[class*="c-wrapper"], [class*="cmp-"], .component, [class*="ST00"], [class*="PD00"], [class*="CM00"]').forEach(el => {
          const cls = (el.className || '').toString();
          const m = cls.match(/\b((?:ST|PD|CM|PN|CS)\d{4})\b/);
          if (!m || seenEl.has(el)) return;
          seenEl.add(el);
          const typeM = cls.match(/type-([a-z0-9-]+)/i);
          const imgFiles = Array.from(el.querySelectorAll('img'))
            .map(im => (im.currentSrc || im.src || im.getAttribute('data-src') || ''))
            .filter(Boolean).map(u => u.split('/').pop().split('?')[0]).slice(0, 10);
          let hasBg = false;
          try { const bg = getComputedStyle(el).backgroundImage; hasBg = !!bg && bg !== 'none' && /url\(/.test(bg); } catch (_) {}
          const head = ((el.querySelector('h1,h2,h3,.title,[class*="title"]') || {}).innerText || '').trim().slice(0, 60);
          out.push({ id: m[1], layout: LAYOUT[m[1]] || '', type: typeM ? typeM[1] : '', imgFiles, headline: head, hasBg });
        });
        return out;
      });
    } catch (e) { console.warn('[ebay-analyze] component scan skip:', e.message); }

    // feature ↔ component 매칭 (이미지 파일명 우선, 헤드라인 보조)
    const fileOf = u => (u || '').split('/').pop().split('?')[0];
    features.forEach(f => {
      const fImgs = (f.images || []).map(im => fileOf(im.url || im.src)).filter(Boolean);
      let best = components.find(c => c.imgFiles.some(cf => fImgs.includes(cf)));
      if (!best && f.headline) {
        const h = f.headline.trim().toLowerCase();
        best = components.find(c => c.headline && (h.includes(c.headline.toLowerCase().slice(0, 18)) || c.headline.toLowerCase().includes(h.slice(0, 18))));
      }
      if (best) {
        f.componentId = best.id;
        f.layoutType = best.layout || (best.hasBg ? 'text_over_image' : '');
        f.hasBg = best.hasBg;
      }
    });
    const matchedN = features.filter(f => f.componentId).length;
    console.log(`[ebay-analyze] ${url} → ${features.length} features · CCG 매칭 ${matchedN} (컴포넌트 ${components.length}개)`);
    res.json({ features, url });
  } catch (e) {
    console.error('[ebay-analyze] error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    await browser.close();
  }
});

/* ──────────────────────────────────────────
   이미지 자연 크기 프로브 (eBay 렌더 시 원본 이상 확대 방지)
   mirror.json에 width가 없는(크롤 시 DOM 미측정) 이미지는 실제 픽셀 폭을 몰라
   상한(760px)까지 늘어나 로고·아이콘·뱃지가 흐리게 깨진다. 헤더 바이트만 받아
   JPEG/PNG/GIF/WebP 크기를 읽어 디스크에 캐시하고, imgTag가 이 값으로 상한을 건다.
────────────────────────────────────────── */
const _imgDimsCacheFp = require('path').join(__dirname, 'crawler-py', 'out', '.imgdims-cache.json');
let _imgDimsCache = null;
function _loadImgDims() {
  if (_imgDimsCache) return _imgDimsCache;
  try { _imgDimsCache = JSON.parse(require('fs').readFileSync(_imgDimsCacheFp, 'utf8')); }
  catch { _imgDimsCache = {}; }
  return _imgDimsCache;
}
function _saveImgDims() {
  try { require('fs').writeFileSync(_imgDimsCacheFp, JSON.stringify(_imgDimsCache)); } catch { /* noop */ }
}
// 헤더 바이트만으로 이미지 폭/높이 파싱 (JPEG/PNG/GIF/WebP)
function _parseImageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  // WebP (RIFF....WEBP)
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === 'VP8L') {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      return { w: 1 + (((b1 & 0x3f) << 8) | b0),
               h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (fmt === 'VP8X') return { w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
                                 h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) };
  }
  // JPEG — SOF 마커(SOS 이전)에서 크기 판독
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let off = 2;
    while (off < buf.length - 8) {
      if (buf[off] !== 0xFF) { off++; continue; }
      const m = buf[off + 1];
      if (m === 0xFF) { off++; continue; }                       // fill
      if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7)) { off += 2; continue; }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      off += 2 + len;
    }
  }
  return null;
}
async function probeImageSize(url) {
  if (!url) return null;
  const cache = _loadImgDims();
  if (url in cache) return cache[url];                            // 실패(null)도 캐시해 재프로브 방지
  let dims = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(url, { headers: { Range: 'bytes=0-131071' }, signal: ctrl.signal });
    clearTimeout(t);
    if (resp.ok || resp.status === 206)
      dims = _parseImageSize(Buffer.from(await resp.arrayBuffer()));
  } catch { /* 네트워크 실패 → null (상한 그대로 사용) */ }
  cache[url] = dims;
  return dims;
}

/* ──────────────────────────────────────────
   eBay Listing HTML Generator (Template-based, no AI dependency)
────────────────────────────────────────── */
app.post('/api/ebay-generate', async (req, res) => {
  const { features, url } = req.body;
  if (!features || !features.length) return res.status(400).json({ error: 'features required' });

  // ── CCG 경로 우선: 크롤 캐시 mirror에 컴포넌트 정보(component_id/layout_type)가
  //    있으면 ebay_builder.py(CCG 레이아웃 템플릿)로 렌더 — lg.com 디자인 가이드 재현.
  //    실패/미보유 시 아래 기존 JS 템플릿으로 폴백.
  if (url) {
    try {
      const path = require('path');
      const fs = require('fs');
      const slug = url.replace(/https?:\/\//, '').replace(/[^\w]+/g, '-').replace(/-+$/, '');
      const slugDir = path.join(__dirname, 'crawler-py', 'out', slug);
      const mirrorFp = path.join(slugDir, 'mirror.json');
      if (fs.existsSync(mirrorFp)) {
        const mir = JSON.parse(fs.readFileSync(mirrorFp, 'utf8'));
        const hasCcg = (mir.sections || []).some(s => s.component_id);
        if (hasCcg) {
          const venvPy = path.join(__dirname, 'crawler-py', '.venv', 'bin', 'python');
          const py = fs.existsSync(venvPy) ? venvPy : 'python3';
          const script = path.join(__dirname, 'crawler-py', 'ebay_builder.py');
          const { execFileSync } = require('child_process');
          execFileSync(py, [script, slugDir, '--fragment'], { timeout: 60 * 1000 });
          const html = fs.readFileSync(path.join(slugDir, 'ebay_content.html'), 'utf8');
          console.log(`[ebay-generate] CCG 빌더 렌더 완료 (${html.length} chars)`);
          return res.json({ success: true, html, charCount: html.length, engine: 'ccg' });
        }
      }
    } catch (ccgErr) {
      console.warn('[ebay-generate] CCG 빌더 실패 → 기존 템플릿 폴백:', ccgErr.message.slice(0, 200));
    }
  }

  try {
    console.log(`[ebay-generate] Building HTML from ${features.length} sections`);

    // ── LG GP1 Design System 토큰 (claude.ai/design "LG GP1 Design System" 소싱) ──
    // active_red_50이 GP1의 실제 브랜드 액센트. heritage_red(#A50034)는 GP1 readme상
    // LG 로고 마크 내부에만 쓰이는 색이라 일반 UI 액센트로는 쓰지 않는다.
    const GP1_FONT_HEAD = "'LGEIHeadline','LG EI Headline','LGEIText',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";
    const GP1_FONT_BODY = "'LGEIText','LG EI Text',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";
    const GP1 = { headline: '#111111', body: '#2D2D2D', sub: '#697072', accentRed: '#EA1917', stroke: '#F0ECE4', pageBg: '#FFFFFF' };

    // ── Helper: ensure HTTPS ──
    function httpsUrl(u) {
      if (!u) return '';
      return u.replace(/^http:\/\//i, 'https://');
    }

    // ── Helper: escape HTML ──
    function esc(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Helper: 이미지를 '자연 크기'로 렌더 (확대 금지) ──
    // LG.com 컴포넌트 이미지는 아이콘/썸네일/히어로 등 의도된 크기가 제각각인데,
    // 전부 800px로 늘리면 아이콘·UI 스크린샷이 흐리게 깨진다. 자연 폭(naturalWidth)과
    // 상한(capW) 중 작은 값으로 표시해 원본 이상으로 확대하지 않는다.
    function imgUrl(img) { return httpsUrl(img && (img.url || img.src) || ''); }
    function imgNatW(img) { return +(img && img.width) || 0; }
    function imgTag(img, capW, opts) {
      opts = opts || {};
      const u = imgUrl(img);
      if (!u) return '';
      const nat = imgNatW(img);
      const dispW = nat > 0 ? Math.min(nat, capW) : capW;   // 자연 크기 미상이면 상한 사용
      const mAuto = opts.center === false ? '' : 'display:block;margin:0 auto;';
      return `<img src="${u}" alt="${esc(img.alt || opts.alt || '')}" style="width:100%;max-width:${dispW}px;height:auto;${mAuto}${opts.style || ''}">`;
    }
    // 아이콘/소형 판정 — 자연 폭이 작은(≤200px) 이미지
    function isIconImg(img) { const w = imgNatW(img); return w > 0 && w <= 200; }

    // ── 텍스트 블록 (eyebrow/headline/body/bullets) ──
    function textBlock(hl, sub, body, bullets, align) {
      const ta = align || 'left';
      return (
        (sub ? `<p style="font-family:${GP1_FONT_BODY};font-size:24px;color:${GP1.accentRed};font-weight:600;text-align:${ta};margin:0 0 6px 0;letter-spacing:.02em;">${sub}</p>` : '') +
        (hl ? `<h2 style="font-family:${GP1_FONT_HEAD};font-size:36px;font-weight:700;color:${GP1.headline};text-align:${ta};margin:0 0 10px 0;line-height:1.04;">${hl}</h2>` : '') +
        (body ? `<p style="font-family:${GP1_FONT_BODY};font-size:24px;color:${GP1.body};text-align:${ta};margin:0 0 12px 0;line-height:1.36;">${body}</p>` : '') +
        (bullets && bullets.length ? `<ul style="font-family:${GP1_FONT_BODY};font-size:24px;color:${GP1.body};margin:8px 0 0 20px;padding:0;line-height:1.44;">${bullets.slice(0, 6).map(b => `<li style="margin-bottom:4px;">${esc(b)}</li>`).join('')}</ul>` : '')
      );
    }

    // ── 이미지 자연 폭 백필 — width 미상(mirror에 None) 이미지의 원본 폭을 프로브해
    //    imgTag가 원본 이상으로 확대하지 못하도록 한다. 캐시로 재요청 없음. ──
    try {
      const _need = new Map();   // url → [width를 채울 객체들]
      const _add = (obj, u) => { const k = httpsUrl(u); if (!k) return;
        if (!_need.has(k)) _need.set(k, []); _need.get(k).push(obj); };
      features.forEach(f => {
        (f.images || []).forEach(img => { if (img && imgNatW(img) <= 0) _add(img, img.url || img.src); });
        (f.cardItems || []).forEach(c => { if (c && c.imageUrl && !(+c.width > 0)) _add(c, c.imageUrl); });
      });
      const _urls = [..._need.keys()];
      if (_urls.length) {
        const _dims = await Promise.all(_urls.map(u => probeImageSize(u)));
        let _filled = 0;
        _urls.forEach((u, i) => {
          const d = _dims[i];
          if (d && d.w > 0) { _need.get(u).forEach(o => { o.width = d.w; if (d.h) o.height = d.h; }); _filled++; }
        });
        _saveImgDims();
        if (_filled) console.log(`[ebay-generate] 이미지 자연폭 백필 ${_filled}/${_urls.length}건 (확대 방지)`);
      }
    } catch (e) { console.warn('[ebay-generate] 이미지 폭 프로브 스킵:', e.message); }

    // ── Build sections HTML ──
    let sectionsHtml = '';

    features.forEach((f, idx) => {
      const hl = esc(f.headline || '');
      const sub = esc(f.subheadline || '');
      const body = esc(f.body || '').replace(/\n/g, '<br>');
      const imgs = (f.images || []).filter(img => (img.url || img.src));
      const bullets = (f.bullets || []).filter(b => b);
      const cards = f.cardItems || [];
      const lay = f.layout || {};
      const perRow = lay.imgsPerRow || 0;

      // Skip empty sections (카드행만 있는 수상 뱃지 행 등도 렌더)
      if (!hl && !body && imgs.length === 0 && cards.length === 0) return;

      const wrapOpen = `<div style="padding:30px 0;border-bottom:1px solid ${GP1.stroke};">`;

      // ── (A) 카드 그리드: 가로형 카드(이미지 40% / 텍스트 60%)를 세로로 나열 (261007) ──
      if (cards.length >= 2) {
        const n = Math.min(cards.length, 4);
        sectionsHtml += `
${wrapOpen}
  ${hl ? `<h2 style="font-family:${GP1_FONT_HEAD};font-size:36px;font-weight:700;color:${GP1.headline};text-align:center;margin:0 0 20px 0;line-height:1.04;">${hl}</h2>` : ''}
  ${sub ? `<p style="font-family:${GP1_FONT_BODY};font-size:24px;color:${GP1.sub};text-align:center;margin:0 0 20px 0;">${sub}</p>` : ''}
  ${cards.map(c => `
  <table style="width:100%;border-collapse:separate;border:1px solid ${GP1.stroke};border-radius:16px;margin:0 0 16px 0;" cellpadding="0" cellspacing="0"><tr>
    <td style="width:40%;vertical-align:middle;padding:0;">${c.imageUrl ? imgTag({ url: c.imageUrl, alt: c.title, width: c.width }, 300, { style: 'border-radius:16px 0 0 16px;' }) : ''}</td>
    <td style="vertical-align:middle;padding:20px 24px;text-align:left;">
      ${c.title ? `<h3 style="font-family:${GP1_FONT_HEAD};font-size:36px;font-weight:700;color:${GP1.headline};margin:0 0 10px 0;line-height:1.04;">${esc(c.title)}</h3>` : ''}
      ${c.body ? `<p style="font-family:${GP1_FONT_BODY};font-size:24px;color:${GP1.body};margin:0;line-height:1.28;">${esc(c.body)}</p>` : ''}
    </td>
  </tr></table>`).join('')}
</div>`;
        return;
      }

      // ══ CCG 컴포넌트 레이아웃 우선 분기 (analyze가 매칭한 닷컴 컴포넌트 타입대로) ══
      // 매칭이 없으면(layoutType 없음) 아래 (B)~(E) 자연폭 추론으로 폴백.
      const lt = f.layoutType || '';
      const mImg = imgs[0];

      // 배경 이미지 위 텍스트 오버레이 (ST0004 등 bg-image) — 닷컴의 text-over-image 재현
      // eBay가 position을 제거하면 이미지 아래 텍스트로 자연 degrade (DOM 순서 유지)
      if (lt === 'text_over_image' && mImg) {
        sectionsHtml += `
${wrapOpen}
  <div style="position:relative;max-width:${Math.min(imgNatW(mImg) || 760, 760)}px;margin:0 auto;">
    ${imgTag(mImg, 760, { center: false, style: 'border-radius:4px;' })}
    <div style="position:absolute;left:0;right:0;bottom:0;padding:20px 22px;background:linear-gradient(transparent,rgba(0,0,0,.62));border-radius:0 0 4px 4px;">
      ${sub ? `<p style="font-family:${GP1_FONT_BODY};font-size:24px;color:#f0d3dd;font-weight:600;margin:0 0 4px 0;">${sub}</p>` : ''}
      ${hl ? `<h2 style="font-family:${GP1_FONT_HEAD};font-size:36px;font-weight:700;color:#fff;margin:0 0 6px 0;line-height:1.04;text-shadow:0 1px 3px rgba(0,0,0,.55);">${hl}</h2>` : ''}
      ${body ? `<p style="font-family:${GP1_FONT_BODY};font-size:24px;color:#f2f2f2;margin:0;line-height:1.28;text-shadow:0 1px 2px rgba(0,0,0,.55);">${body}</p>` : ''}
    </div>
  </div>
</div>`;
        return;
      }

      // 좌우 배치 (ST0011 image_text_left / ST0013 image_text_right)
      if ((lt === 'image_text_left' || lt === 'image_text_right') && mImg) {
        const imgCell = `<td style="width:48%;vertical-align:middle;padding:0 16px;">${imgTag(mImg, 360)}</td>`;
        const txtCell = `<td style="vertical-align:middle;padding:0 16px;">${textBlock(hl, sub, body, bullets, 'left')}</td>`;
        sectionsHtml += `
${wrapOpen}
  <table style="width:100%;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tr>
    ${lt === 'image_text_right' ? txtCell + imgCell : imgCell + txtCell}
  </tr></table>
</div>`;
        return;
      }

      // 아이콘/키베네핏 그리드 (ST0027 icon_grid, ST0007 grid)
      if ((lt === 'icon_grid' || lt === 'grid') && imgs.length >= 2) {
        const n = Math.min(imgs.length, 4);
        const colW = Math.floor(760 / n);
        sectionsHtml += `
${wrapOpen}
  ${hl ? `<h2 style="font-family:${GP1_FONT_HEAD};font-size:36px;font-weight:700;color:${GP1.headline};text-align:center;margin:0 0 18px 0;line-height:1.04;">${hl}</h2>` : ''}
  <table style="width:100%;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tr>
    ${imgs.slice(0, n).map(im => `<td style="width:${Math.floor(100/n)}%;vertical-align:top;padding:0 8px;text-align:center;">${imgTag(im, colW)}</td>`).join('')}
  </tr></table>
  ${body ? `<p style="font-family:${GP1_FONT_BODY};font-size:24px;color:${GP1.body};text-align:center;margin:14px 0 0 0;line-height:1.36;">${body}</p>` : ''}
</div>`;
        return;
      }

      // 제품 갤러리 (PD0012) — 대표 이미지 + 썸네일 행
      if (lt === 'product_gallery' && imgs.length >= 1) {
        const gMain = imgs[0], rest = imgs.slice(1, 5);
        sectionsHtml += `
${wrapOpen}
  ${hl ? `<h2 style="font-family:${GP1_FONT_HEAD};font-size:36px;font-weight:700;color:${GP1.headline};text-align:center;margin:0 0 16px 0;line-height:1.04;">${hl}</h2>` : ''}
  ${imgTag(gMain, 520, { style: 'margin-bottom:14px;' })}
  ${rest.length ? `<table style="width:100%;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tr>${rest.map(im => `<td style="width:${Math.floor(100/rest.length)}%;padding:0 6px;text-align:center;">${imgTag(im, Math.floor(500/rest.length))}</td>`).join('')}</tr></table>` : ''}
</div>`;
        return;
      }

      // 히어로 풀폭 (ST0001) — 이미지 위 + 텍스트 아래
      if (lt === 'hero' && mImg) {
        sectionsHtml += `
${wrapOpen}
  ${imgTag(mImg, 760, { alt: f.headline, style: 'margin-bottom:20px;' })}
  ${textBlock(hl, sub, body, bullets, 'left')}
</div>`;
        return;
      }

      // ── (B) 다중 이미지 가로 행: imgsPerRow≥2 이거나 소형 이미지(≤420px) 여러 개 ──
      // (LG icon_grid / 3-card / 앱 스크린샷 행 등 — 작은 이미지는 나란히 배치해야 닷컴과 유사)
      const allSmall = imgs.every(im => { const w = imgNatW(im); return w > 0 && w <= 420; });
      if (imgs.length >= 2 && (perRow >= 2 || allSmall)) {
        const n = Math.min(imgs.length, perRow >= 2 ? Math.min(perRow, 4) : 4);
        const colW = Math.floor(760 / n);
        sectionsHtml += `
${wrapOpen}
  ${hl ? `<h2 style="font-family:${GP1_FONT_HEAD};font-size:36px;font-weight:700;color:${GP1.headline};text-align:center;margin:0 0 18px 0;line-height:1.04;">${hl}</h2>` : ''}
  ${sub ? `<p style="font-family:${GP1_FONT_BODY};font-size:24px;color:${GP1.sub};text-align:center;margin:0 0 18px 0;">${sub}</p>` : ''}
  <table style="width:100%;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tr>
      ${imgs.slice(0, n).map(im => `<td style="width:${Math.floor(100/n)}%;vertical-align:top;padding:0 8px;text-align:center;">${imgTag(im, colW)}</td>`).join('')}
  </tr></table>
  ${body ? `<p style="font-family:${GP1_FONT_BODY};font-size:24px;color:${GP1.body};text-align:center;margin:14px 0 0 0;line-height:1.36;">${body}</p>` : ''}
</div>`;
        return;
      }

      const mainImg = imgs[0];
      const nat = imgNatW(mainImg);

      // ── (C) 아이콘/소형 단일 이미지: 작게 중앙 + 텍스트 (LG key benefit/아이콘형) ──
      if (mainImg && isIconImg(mainImg) && !lay.fullWidth) {
        sectionsHtml += `
${wrapOpen}
  <div style="text-align:center;">${imgTag(mainImg, Math.min(nat || 120, 140), { style: 'margin-bottom:14px;' })}</div>
  ${textBlock(hl, sub, body, bullets, 'center')}
</div>`;
        return;
      }

      // ── (D) 좌우 배치: 풀폭 아님 + 본문 있음 + 중형 이미지 (LG side image ST0011/ST0013) ──
      if (mainImg && !lay.fullWidth && (body || bullets.length) && nat > 0 && nat <= 640) {
        const imgCell = `<td style="width:46%;vertical-align:middle;padding:0 16px 0 0;">${imgTag(mainImg, 320)}</td>`;
        const txtCell = `<td style="vertical-align:middle;">${textBlock(hl, sub, body, bullets, 'left')}</td>`;
        sectionsHtml += `
${wrapOpen}
  <table style="width:100%;border-collapse:collapse;" cellpadding="0" cellspacing="0"><tr>
    ${idx % 2 === 1 ? txtCell + imgCell.replace('padding:0 16px 0 0;', 'padding:0 0 0 16px;') : imgCell + txtCell}
  </tr></table>
</div>`;
        return;
      }

      // ── (E) 스택형(기본): 이미지(자연폭) 위 + 텍스트 아래 (LG hero/block content) ──
      sectionsHtml += `
${wrapOpen}
  ${mainImg ? imgTag(mainImg, 760, { alt: f.headline, style: 'margin-bottom:20px;' }) : ''}
  ${textBlock(hl, sub, body, bullets, 'left')}
  ${imgs.length > 1 ? imgs.slice(1, 3).map(im => imgTag(im, 760, { style: 'margin-top:16px;' })).join('') : ''}
</div>`;
    });

    // ── Wrap in eBay-compliant container ──
    const html = `<div style="max-width:800px;margin:0 auto;font-family:${GP1_FONT_BODY};background:#ffffff;color:${GP1.body};">
<!-- LG Product Listing — eBay Compliant HTML -->
<div style="padding:20px 20px 0 20px;">
${sectionsHtml}
<div style="text-align:center;padding:24px 0 16px 0;border-top:1px solid ${GP1.stroke};">
  <p style="font-size:11px;color:${GP1.sub};margin:0;">© LG Electronics. All rights reserved.</p>
</div>
</div>
</div>`;

    console.log(`[ebay-generate] Generated ${html.length} chars of eBay HTML`);
    res.json({ success: true, html, charCount: html.length });
  } catch (err) {
    console.error('[ebay-generate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ──────────────────────────────────────────
   이미지 프록시 (CORS 우회)
────────────────────────────────────────── */
app.get('/api/proxy-image', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('Missing url param');
  try {
    const https = require('https');
    const http = require('http');
    const urlObj = new URL(imageUrl);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    const request = protocol.get(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://www.lg.com/'
      }
    }, (imgRes) => {
      // 리다이렉트 처리
      if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
        res.redirect(`/api/proxy-image?url=${encodeURIComponent(imgRes.headers.location)}`);
        return;
      }
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=3600');
      imgRes.pipe(res);
    });
    request.on('error', (e) => {
      console.error('Proxy error:', e.message);
      res.status(500).send(e.message);
    });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

/* ──────────────────────────────────────────
   PCG 크롤 에이전트 (Firecrawl + Puppeteer geometry)
   — crawler/crawl-agent.js 파이프라인을 API로 노출
   — 뷰어(crawler/viewer.html)가 URL 입력만으로 크롤·검수 가능
────────────────────────────────────────── */
app.post('/api/pcg', async (req, res) => {
  const { url, cache = true, geometry = true } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { crawlToPCG } = require('./crawler/crawl-agent');
    console.log(`[pcg] crawl 시작: ${url} (cache:${cache}, geometry:${geometry})`);
    const pcg = await crawlToPCG(url, { useCache: !!cache, geometry: !!geometry });
    console.log(`[pcg] 완료: 섹션 ${pcg.sections.length}개`);
    res.json(pcg);
  } catch (e) {
    console.error('/api/pcg error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ──────────────────────────────────────────
   PCG Vision (Python 파이프라인 crawler-py/pdp_pipeline.py)
   — Firecrawl 듀얼 크롤 + 스크린샷 + Gemini 융합 + 시각 QA
   — 산출물(final.json)이 이미 있으면 즉시 반환 (force:true 로 재실행)
────────────────────────────────────────── */
app.post('/api/pcg-vision', async (req, res) => {
  const { url, force = false, cacheOnly = false, pro = false, fullAi = false } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  const path = require('path');
  const fs = require('fs');
  const slug = url.replace(/https?:\/\//, '').replace(/[^\w]+/g, '-').replace(/-+$/, '');
  const outDir = path.join(__dirname, 'crawler-py', 'out', slug);
  const finalFp = path.join(outDir, 'final.json');
  const qaFp = path.join(outDir, 'qa_report.json');
  const mirrorFp = path.join(outDir, 'mirror.json');

  const respondFromDisk = () => {
    const base = fs.existsSync(mirrorFp) ? mirrorFp : finalFp;
    const data = JSON.parse(fs.readFileSync(base, 'utf8'));
    let qa = null;
    try { qa = JSON.parse(fs.readFileSync(qaFp, 'utf8')); } catch (_) {}
    res.json({ ...data, _qa: qa, _source: 'crawler-py' });
  };

  // 로컬 캐시 우선
  if (!force && fs.existsSync(mirrorFp)) {
    console.log(`[pcg-vision] 캐시 반환: ${slug}`);
    return respondFromDisk();
  }
  if (cacheOnly) return res.status(404).json({ error: 'no-vision-cache' });

  // 내장 크롤러(crawler-routes.js)로 파이프라인 직접 실행 — 완료까지 대기
  const geminiKey = req.headers['x-gemini-api-key'] || null;
  try {
    console.log(`[pcg-vision] 크롤 시작: ${url}`);
    const { crawl } = require('./crawler-routes');
    const result = await crawl(url, { pro: !!pro, force: !!force, fullAi: !!fullAi, geminiKey });
    res.json({ ...result, _source: 'crawler-py' });
  } catch (e) {
    console.error('[pcg-vision] 크롤 실패:', e.message);
    res.status(500).json({ error: e.message.slice(0, 300) });
  }
});

/* ──────────────────────────────────────────
   PCG Vision 실시간 진행률 조회 API
   — pdp_pipeline.py 가 기록하는 progress.json 을 실시간 수집 및 반환
────────────────────────────────────────── */
app.get('/api/pcg-vision/progress', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  const path = require('path');
  const fs = require('fs');
  const slug = url.replace(/https?:\/\//, '').replace(/[^\w]+/g, '-').replace(/-+$/, '');
  const outDir = path.join(__dirname, 'crawler-py', 'out', slug);
  const progFp = path.join(outDir, 'progress.json');
  if (fs.existsSync(progFp)) {
    try {
      const data = JSON.parse(fs.readFileSync(progFp, 'utf8'));
      return res.json(data);
    } catch (_) {}
  }
  return res.json({ percent: 0, message: "분석 인프라 가동 대기 중..." });
});

const PORT = process.env.PORT || 3001;

/* ──────────────────────────────────────────
   /api/render-slices — 생성된 리스팅 HTML을 이미지 슬라이스 ZIP으로
   Shopee / Lazada 는 상품 상세를 HTML이 아닌 이미지로 올린다.
   한 장이 너무 길면 업로드가 거부되므로 N등분(기본 6)해서 zip으로 내려준다.

   실제 Chrome(puppeteer)으로 렌더한다 — LG 폰트·원격 DAM 이미지·인라인 CSS가
   브라우저와 100% 동일하게 나오고, 브라우저 canvas의 CORS 오염 문제도 없다.
────────────────────────────────────────── */
app.post('/api/render-slices', async (req, res) => {
  const {
    html,
    // 레이아웃 계산용 뷰포트 폭. 실제 잘라내는 폭은 콘텐츠 실측 경계로 정한다
    // (컨테이너가 max-width로 가운데 정렬되면 좌우에 빈 여백이 생기므로 그대로 쓰면 안 된다).
    viewportWidth,
    width,                       // 하위호환: 예전 파라미터명
    outputWidth,                 // 원하는 최종 이미지 폭(px). 비우면 콘텐츠 폭 x2
    slices = 6,
    format = 'jpeg',
    quality = 88,
    name = 'pdp',
  } = req.body || {};

  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'html required' });
  }

  const N = Math.max(1, Math.min(parseInt(slices, 10) || 6, 20));
  const VW = Math.max(600, Math.min(parseInt(viewportWidth ?? width, 10) || 1600, 3000));
  const OW = parseInt(outputWidth, 10) || 0;
  const fmt = format === 'png' ? 'png' : 'jpeg';
  const q = Math.max(40, Math.min(parseInt(quality, 10) || 88, 100));
  const safeName = String(name).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'pdp';

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
             '--disable-gpu', '--font-render-hinting=none'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: VW, height: 1400, deviceScaleFactor: 1 });
    // lg.com DAM은 headless UA를 느리게 응답시키는 경우가 있어 일반 Chrome UA로 요청한다
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
                            + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Referer': 'https://www.lg.com/' });

    // 폰트는 이 서버가 정적으로 서빙하는 css/fonts.css 를 그대로 쓴다
    const doc = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="http://127.0.0.1:${PORT}/css/fonts.css">
<style>
  html, body { margin: 0; padding: 0; background: #FFFFFF; }
  #slice-root { width: ${VW}px; background: #FFFFFF; }
  #slice-root img { max-width: 100%; }
</style></head><body><div id="slice-root">${html}</div></body></html>`;

    // networkidle0 은 DAM 이미지 하나가 연결을 놓지 않으면 통째로 멈춘다.
    // DOM만 먼저 세운 뒤, 이미지를 '개별 타임아웃'으로 기다리는 편이 안전하다.
    await page.setContent(doc, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const loadStat = await page.evaluate(async (perImgMs) => {
      const imgs = Array.from(document.images);
      const settle = img => new Promise(resolve => {
        if (img.complete) return resolve(img.naturalWidth > 0);
        const done = ok => resolve(ok);
        img.addEventListener('load', () => done(true), { once: true });
        img.addEventListener('error', () => done(false), { once: true });
        setTimeout(() => done(img.naturalWidth > 0), perImgMs);   // 느린 이미지는 포기하고 진행
      });
      const results = await Promise.all(imgs.map(settle));
      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 8000))]);
      }
      return { total: imgs.length, loaded: results.filter(Boolean).length };
    }, 25000);

    if (loadStat.total && loadStat.loaded < loadStat.total) {
      console.warn(`[render-slices] 이미지 ${loadStat.total - loadStat.loaded}/${loadStat.total}장 로드 실패 — 해당 영역은 빈칸으로 렌더됩니다`);
    }
    await new Promise(r => setTimeout(r, 400));

    // 전체 높이 + 자를 수 있는 안전 경계 수집.
    //   coarse = 섹션 바닥 (제목·이미지·본문이 한 덩어리로 유지되는 최적 절단선)
    //   fine   = 표 행 / 리스트 / 문단 바닥 (섹션이 한 슬라이스보다 길 때의 대안)
    // 글자 중간을 자르지 않도록 항상 요소 경계에서만 자른다.
    const layout = await page.evaluate(() => {
      const root = document.getElementById('slice-root');
      const H = Math.ceil(root.scrollHeight);
      const rootTop = root.getBoundingClientRect().top + window.scrollY;
      const bottomOf = el => {
        const r = el.getBoundingClientRect();
        return Math.round(r.bottom + window.scrollY - rootTop);
      };
      const collect = sel => {
        const out = [];
        root.querySelectorAll(sel).forEach(el => {
          const b = bottomOf(el);
          if (b > 0 && b < H) out.push(b);
        });
        return Array.from(new Set(out)).sort((a, b) => a - b);
      };
      // 콘텐츠의 실제 좌우 끝 — 가운데 정렬 컨테이너 밖의 빈 여백을 잘라내기 위해.
      // 배경이 칠해진 최상위 자식(예: .lg-container)들의 합집합을 콘텐츠 영역으로 본다.
      let left = Infinity, right = -Infinity;
      Array.from(root.children).forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;          // <style> 등 비시각 요소 제외
        left = Math.min(left, r.left + window.scrollX);
        right = Math.max(right, r.right + window.scrollX);
      });
      const rootRect = root.getBoundingClientRect();
      if (!isFinite(left) || right <= left) {             // 폴백: 루트 전체
        left = rootRect.left + window.scrollX;
        right = rootRect.right + window.scrollX;
      }
      return {
        width: Math.ceil(rootRect.width),
        height: H,
        contentLeft: Math.max(0, Math.floor(left)),
        contentWidth: Math.max(1, Math.ceil(right - left)),
        edges: collect(':scope > *, :scope > * > section, :scope > section'),
        fineEdges: collect('tr, li, p, h1, h2, h3, h4, img, .lg-grid-item'),
      };
    });

    const H = layout.height;
    if (!H) throw new Error('렌더 높이가 0 — HTML이 비어있는지 확인하세요');

    // 콘텐츠 폭이 뷰포트보다 좁으면(가운데 정렬 컨테이너) 그만큼만 잘라내므로
    // 결과 이미지가 작아진다. 선명도를 유지하기 위해 배율을 올려 촬영한다.
    //   outputWidth 지정 시 → 그 폭에 맞는 배율, 없으면 x2
    const scale = OW
      ? Math.max(0.5, Math.min(OW / layout.contentWidth, 4))
      : 2;
    if (scale !== 1) {
      await page.setViewport({ width: VW, height: 1400, deviceScaleFactor: scale });
      await new Promise(r => setTimeout(r, 250));
    }

    // 자를 위치 계산: 이상적인 등분점에서 가장 가까운 섹션 경계로 스냅.
    // 경계가 너무 멀면(등분 높이의 45% 초과) 텍스트 중간을 자르는 대신 등분점을 쓴다.
    const ideal = H / N;
    const cuts = [0];
    const nearest = (list, target, minY, tol) => {
      let best = null;
      for (const e of list) {
        if (e <= minY + 8) continue;
        const d = Math.abs(e - target);
        if (d <= tol && (best === null || d < Math.abs(best - target))) best = e;
      }
      return best;
    };
    for (let k = 1; k < N; k++) {
      const target = Math.round(ideal * k);
      const prev = cuts[cuts.length - 1];
      // ① 섹션 경계 우선 → ② 표 행/문단 경계 → ③ 그래도 없으면 등분점
      const cut = nearest(layout.edges, target, prev, ideal * 0.45)
               ?? nearest(layout.fineEdges, target, prev, ideal * 0.45)
               ?? target;
      cuts.push(Math.max(cut, prev + 8));
    }
    cuts.push(H);

    // 슬라이스별 텍스트(제목/본문) 추출 — 이미지에 들어간 카피를 마켓 등록 시 그대로 쓸 수 있게 (261007).
    // 요소의 위쪽 끝이 속한 슬라이스에 배정. 표는 행 단위 "라벨: 값".
    const textBlocks = await page.evaluate(() => {
      const root = document.getElementById('slice-root');
      const rootTop = root.getBoundingClientRect().top + window.scrollY;
      const out = [];
      root.querySelectorAll('h1, h2, h3, h4, p, li, tr').forEach(el => {
        if (el.closest('li, tr') && el.closest('li, tr') !== el) return;   // 중첩 중복 방지
        const r = el.getBoundingClientRect();
        if (r.height < 1) return;
        const txt = el.tagName === 'TR'
          ? Array.from(el.cells).map(c => c.innerText.trim()).filter(Boolean).join(': ')
          : el.innerText.replace(/\s+/g, ' ').trim();
        if (!txt) return;
        out.push({ top: Math.round(r.top + window.scrollY - rootTop), kind: /^H\d$/.test(el.tagName) ? 'Title' : 'Body', txt });
      });
      return out;
    });
    const sliceTexts = Array.from({ length: N }, () => []);
    textBlocks.forEach(b => {
      let i = cuts.findIndex((c, k) => k < N && b.top >= c && b.top < cuts[k + 1]);
      if (i < 0) i = N - 1;
      sliceTexts[i].push(`${b.kind}: ${b.txt}`);
    });

    const JSZip = require('jszip');
    const zip = new JSZip();
    const manifest = [];
    for (let i = 0; i < N; i++) {
      const y = cuts[i];
      const h = Math.max(1, Math.min(cuts[i + 1], H) - y);
      if (h <= 1) continue;
      const shot = await page.screenshot({
        type: fmt,
        ...(fmt === 'jpeg' ? { quality: q } : {}),
        clip: { x: layout.contentLeft, y, width: layout.contentWidth, height: h },
        captureBeyondViewport: true,
      });
      const fname = `${safeName}-${String(i + 1).padStart(2, '0')}.${fmt === 'jpeg' ? 'jpg' : 'png'}`;
      zip.file(fname, shot);
      const tname = fname.replace(/\.(jpg|png)$/, '.txt');
      zip.file(tname, (sliceTexts[i].join('\n') || '(no text)') + '\n');
      manifest.push({
        file: fname,
        width: Math.round(layout.contentWidth * scale),
        height: Math.round(h * scale),
        css_height: h,
        bytes: shot.length,
        text_file: tname,
        slice: i + 1,
      });
    }
    // 전체 텍스트 한 파일 (슬라이스 순서대로)
    zip.file(`${safeName}-texts.txt`, manifest.map(m =>
      `=== ${String(m.slice).padStart(2, '0')} · ${m.file} ===\n${sliceTexts[m.slice - 1].join('\n') || '(no text)'}`).join('\n\n') + '\n');

    zip.file(`${safeName}-manifest.json`, JSON.stringify({
      viewport_width: VW,
      content_width_css: layout.contentWidth,
      content_left_css: layout.contentLeft,
      scale,
      output_width: Math.round(layout.contentWidth * scale),
      total_height_css: H,
      slices: manifest.length,
      format: fmt, quality: fmt === 'jpeg' ? q : null,
      images_loaded: `${loadStat.loaded}/${loadStat.total}`,
      images: manifest,
    }, null, 2));

    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    console.log(`[render-slices] ${safeName}: 콘텐츠 ${layout.contentWidth}x${H}css (여백 좌 ${layout.contentLeft}px 제외)`
      + ` x${scale} → ${Math.round(layout.contentWidth * scale)}px 폭 ${manifest.length}장, zip ${(buf.length / 1024 / 1024).toFixed(2)}MB`);

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${safeName}-images.zip"`);
    res.set('X-Slice-Manifest', encodeURIComponent(JSON.stringify(manifest)));
    res.set('X-Images-Loaded', `${loadStat.loaded}/${loadStat.total}`);
    res.set('Access-Control-Expose-Headers', 'X-Slice-Manifest, X-Images-Loaded, Content-Disposition');
    return res.send(buf);
  } catch (e) {
    console.error('/api/render-slices error:', e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ A+ Content Generator Server`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   API Key: ${process.env.ANTHROPIC_API_KEY ? '✓ loaded' : '✗ missing'}\n`);
});
