#!/bin/bash
# Все проверки «Трат» одной командой:  bash tests/run.sh            — всё
#                                     bash tests/run.sh app ai      — только выбранные (workers, app, sync, ai, screens)
# Поднимает приложение на :8000 и копию сервера «Входящие» на :8787, после — гасит.
cd "$(dirname "$0")/.." || exit 1
[ -d tests/node_modules/http_ece ] || npm install --prefix tests --silent >/dev/null 2>&1 || echo "· не удалось поставить http_ece — проверка шифрования уведомлений будет пропущена"
python3 -m http.server 8000 >/dev/null 2>&1 & APP=$!
node tests/servers/mock-inbox.mjs >/dev/null 2>&1 & MOCK=$!
trap 'kill $APP $MOCK 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null localhost:8000/ && curl -s -o /dev/null localhost:8787/__debug && break; sleep 0.3; done
SUITES=${*:-workers app sync ai screens}
FAIL=0
for s in $SUITES; do
  f=tests/$s.test.js; [ -f "$f" ] || f=tests/$s.test.mjs
  echo "── $s"
  NODE_PATH="tests/node_modules:$(npm root -g)" timeout 300 node "$f" > /tmp/traty-test.log 2>&1 || FAIL=1
  grep -v 'agent-proxy\|connect_rejected\|For details\|more)$\|oldest' /tmp/traty-test.log
done
echo
[ $FAIL = 0 ] && echo "ВСЁ ХОРОШО ✓" || echo "ЕСТЬ ОШИБКИ ✗"
exit $FAIL
