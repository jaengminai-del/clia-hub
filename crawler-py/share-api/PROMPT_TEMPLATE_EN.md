<!--
This file is meant to be sent to the partner as-is.
The partner pastes this whole file into whatever Claude they use
(Claude Code / claude.ai) and that Claude reads it and wires the
integration into their own project.
The URL changes whenever the tunnel is restarted, so send a freshly
generated copy of this file each time you share.
Issued: {{DATE}} (this URL only stays valid while the issuer's laptop
is on and the tunnel is alive)
-->

# Request: Integrate the LG.com PDP Crawler API

Please integrate the API below into my project. It's an external service
that takes an LG.com product page (PDP) URL and returns **structured JSON
with images and text already paired together** (or a ready-made eBay HTML
fragment). Crawling, bot-evasion, and AI vision analysis are all handled
server-side — all I need to write is **client code that sends a URL and
renders the result**.

## Basics
- **Base URL**: `{{BASE_URL}}`
- **Auth**: none (free test stage)
- **Cost**: covered by the provider (no API key needed on my side)
- **Caution**: this is a temporary tunnel URL. If the provider's machine
  turns off or the tunnel restarts, it will disconnect or change. If you
  keep getting 404s / connection failures, ask them for a fresh URL.

## Call flow — "fire, then poll for the result"

The first crawl of a new URL takes **10–15 minutes** (AI vision analysis +
visual QA loop). An already-crawled URL (cached) returns **immediately**.
Don't hold one HTTP request open the whole time — get a `job_id` and poll
every few seconds; set your overall timeout to 20+ minutes.

### ① Request a crawl
```
POST {{BASE_URL}}/api/v1/crawl
Content-Type: application/json

{ "url": "https://www.lg.com/uk/tvs-soundbars/oled-evo/oled83c6elb/" }
```
Response: `{ "job_id": "job_ab12cd34", "status": "queued" }`
(If the URL was already crawled, you get `"status": "completed"` immediately.)

### ② Poll for the result (every 2–3 seconds until complete)
```
GET {{BASE_URL}}/api/v1/jobs/{job_id}
```
- In progress: `{ "status": "processing", "progress_percent": 65 }`
- Done: `{ "status": "completed", "result": { "product_title": "...", "sections": [...] } }`
- Failed: `{ "status": "failed", "error": "..." }`

### Minimal example (JavaScript)
```javascript
const BASE = "{{BASE_URL}}";

async function crawl(url) {
  const r = await fetch(`${BASE}/api/v1/crawl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  let job = await r.json();
  while (job.status !== "completed") {
    if (job.status === "failed") throw new Error(job.error);
    await new Promise(s => setTimeout(s, 2500));
    job = await (await fetch(`${BASE}/api/v1/jobs/${job.job_id}`)).json();
  }
  return job.result;   // { product_title, sections: [...] }
}
```

## Response shape (result)
```json
{
  "product_title": "83 inch LG OLED evo AI C6 4K Smart TV 2026",
  "sections": [
    {
      "order": 1,
      "text": "Perfect Black & Perfect Color\nDeep blacks and vivid color at the same time...",
      "media": [
        { "pc_url": "https://www.lg.com/.../feature-02-d.jpg",
          "mobile_url": "https://www.lg.com/.../feature-02-m.jpg" }
      ]
    },
    { "order": "3 - disclaimer", "text": "*Images have been simulated...", "media": [] }
  ]
}
```
- If `section.order` contains `disclaimer`, it's legal copy — group these
  at the very bottom of the page.
- `section.text` is LG's original copy verbatim (not AI-generated). **Do
  not alter this text or invent content that isn't there** — leave it
  blank if there's nothing.
- Images come as responsive PC/mobile pairs — pick `pc_url`/`mobile_url`
  based on viewport.

## (Optional) Get a finished eBay HTML fragment directly — no manual rendering needed
```
GET {{BASE_URL}}/api/v1/jobs/{job_id}/ebay-html
GET {{BASE_URL}}/api/v1/ebay-html?url=<PDP URL>     ← works immediately if cached
```
- Response is `text/html` — a fragment you can paste straight into an eBay
  listing description (inline `<style>` only, no `<script>`/`<form>`/
  `<iframe>` — compliant with eBay's active-content policy).
- 404 if the URL hasn't been crawled yet — call `POST /api/v1/crawl` first.

## Optional parameters
```json
{ "url": "...", "force_refresh": false, "use_pro_model": false }
```

## Please follow these when integrating
1. Poll every 2–3 seconds, with an overall timeout of 20+ minutes (the
   first crawl of a URL is slow).
2. Use `section.text` as-is — never have AI invent copy to fill in
   content that isn't present on the source PDP.
3. When rendering images, never upscale beyond the natural size (if the
   response includes a width). If no width is given, treat the
   container width as a ceiling only — don't stretch images past it.
4. No auth header is needed right now, but assume
   `Authorization: Bearer <token>` may be added later — structure your
   code so a header can be added easily.
