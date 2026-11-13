#!/bin/bash
# Выкладка сервера в Cloudflare с сохранением всех ключей и привязок (keep_bindings).
#   bash scripts/deploy-worker.sh inbox   — сервер «Входящие» (inbox-worker/worker.js → traty-inbox)
#   bash scripts/deploy-worker.sh ai      — ИИ-помощник       (traty-ai-worker/worker.js → traty-ai)
# Нужен API-токен Cloudflare (шаблон «Edit Cloudflare Workers»):
#   - в облачной среде Claude он подставляется сам (сохранён как секрет для api.cloudflare.com);
#   - иначе — переменная окружения CLOUDFLARE_API_TOKEN.
# Ключи (TOKEN, VAPID, привязки KV/AI) НЕ передаются и НЕ меняются — Cloudflare сохраняет существующие.
set -e
cd "$(dirname "$0")/.."
ACCOUNT=8cd5422402427556327aee9efae68602
case "$1" in
  inbox) NAME=traty-inbox; FILE=inbox-worker/worker.js; HOST=https://traty-inbox.traty-758cef38.workers.dev ;;
  ai)    NAME=traty-ai;    FILE=traty-ai-worker/worker.js; HOST=https://traty-ai.traty-758cef38.workers.dev ;;
  *) echo "Использование: bash scripts/deploy-worker.sh inbox|ai"; exit 1 ;;
esac
AUTH=(); [ -n "$CLOUDFLARE_API_TOKEN" ] && AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
API=https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/$NAME

echo "1) Проверяю код…"
node -e "import('./$FILE').then(()=>console.log('   синтаксис ок')).catch(e=>{console.error('   ОШИБКА:',e.message);process.exit(1)})"

echo "2) Выкладываю $NAME (ключи и привязки сохраняются)…"
META=$(mktemp)
echo '{"main_module":"worker.js","compatibility_date":"2025-09-01","keep_bindings":["secret_text","plain_text","kv_namespace","ai"]}' > "$META"
curl -sS "${AUTH[@]}" -X PUT "$API" -F "metadata=@$META;type=application/json" -F "worker.js=@$FILE;type=application/javascript+module" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('   выложено' if d.get('success') else '   ОШИБКА: '+str(d.get('errors')));sys.exit(0 if d.get('success') else 1)"
rm -f "$META"
curl -sS "${AUTH[@]}" "$API/settings" | python3 -c "import sys,json;r=json.load(sys.stdin)['result'];print('   привязки:',', '.join(b['name'] for b in r['bindings']))"

echo "3) Проверяю живой сервер (новая версия расходится до ~30 с)…"
for i in $(seq 1 10); do
  if [ "$1" = inbox ]; then
    A=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$HOST/"); B=$(curl -sS -m 15 "$HOST/push/key" | grep -c '"ok":true' || true)
    [ "$A" = 401 ] && [ "$B" = 1 ] && { echo "   ✓ чужой ключ → 401, ключ уведомлений на месте"; exit 0; }
  else
    A=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$HOST/api/ai/health")
    [ "$A" = 401 ] && { echo "   ✓ ИИ отвечает, без ключа → 401"; exit 0; }
  fi
  sleep 3
done
echo "   ✗ сервер отвечает не так, как ожидалось (или адрес не разрешён в сети этой среды) — проверьте вручную"; exit 1
