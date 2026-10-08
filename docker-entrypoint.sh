#!/bin/sh
# 크롤링 결과 영구 보관: DATA_DIR(클라우드 볼륨/디스크 마운트 경로)이 지정되면
#   첫 실행 때 이미지에 들어 있는 캐시를 볼륨으로 복사하고, 이후 크롤 결과는 볼륨에 쌓는다.
#   DATA_DIR 이 없으면 컨테이너 안에 저장 (재배포 시 새로 크롤한 결과는 사라짐).
set -e
if [ -n "$DATA_DIR" ]; then
  for pair in "crawler-py/out:crawler-py-out" "crawler/out:crawler-out"; do
    src="${pair%%:*}"; dst="$DATA_DIR/${pair##*:}"
    mkdir -p "$dst"
    if [ -z "$(ls -A "$dst" 2>/dev/null)" ] && [ -d "$src" ] && [ ! -L "$src" ]; then
      echo "[entrypoint] seeding $dst from bundled $src"
      cp -a "$src"/. "$dst"/
    fi
    rm -rf "$src"
    ln -s "$dst" "$src"
  done
fi
exec "$@"
