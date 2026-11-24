#!/usr/bin/env python3
"""운영 서버에 이미 있는 lg.com 전체 화면 캡처 조회 — GET 만 (새로 찍지 않음)

  python3 -I collect_fullshots.py --sources ../v8/v8-sources.json --out fullshots.json

- GET /api/v1/fullshot?url=<lg.com url>  → {status: ready|none|pending|error, key, src}
- ready 면 GET /media/fullshot/<key>.jpg 로 크기만 읽어 둔다 (crawler-py/fullshot.py: PC 1920px → 폭 960px JPEG)
- 새로 찍는 POST /api/v1/fullshot 은 운영에서 캡처 작업(Firecrawl 포함)이 돌므로 쓰지 않는다.
"""
import argparse, io, json, subprocess, sys, time, urllib.parse

API = 'https://clia-hub-production-699d.up.railway.app'


def curl(url, binary=False):
    r = subprocess.run(['curl', '-s', '-w', '\n%{http_code}', url], capture_output=True)
    body, code = r.stdout.rsplit(b'\n', 1)
    return code.decode(), body if binary else body.decode('utf-8', 'replace')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sources', required=True)
    ap.add_argument('--out', default='fullshots.json')
    a = ap.parse_args()
    from PIL import Image
    res = {}
    for p in json.load(open(a.sources, encoding='utf-8'))['products']:
        code, body = curl(f"{API}/api/v1/fullshot?url={urllib.parse.quote(p['url'], safe='')}")
        time.sleep(1.2)
        st = json.loads(body) if code == '200' else {'status': f'http {code}'}
        item = {'url': p['url'], 'status': st.get('status'), 'key': st.get('key')}
        if st.get('status') == 'ready':
            item['src'] = API + st['src']
            c, img = curl(item['src'], binary=True)
            time.sleep(1.2)
            if c == '200':
                item['width'], item['height'] = Image.open(io.BytesIO(img)).size
        res[p['slug']] = item
        print(f"{p['url'].rstrip('/').rsplit('/', 1)[-1]:14} {item['status']:6} {item.get('width', '')}x{item.get('height', '')}", file=sys.stderr)
    json.dump({'checked_at': time.strftime('%Y-%m-%d %H:%M KST', time.gmtime(time.time() + 9 * 3600)), 'products': res},
              open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
