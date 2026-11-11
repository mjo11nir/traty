/* =====================================================================
   «Траты» — сервер «Входящие» (Cloudflare Worker).

   Команды iPhone (автоматизации «Транзакция» и «Сообщение») отправляют сюда
   каждую трату, а приложение при открытии забирает новые и удаляет их.
   Сервер ничего не анализирует и не хранит дольше 30 дней — это просто очередь.

   Нужно в настройках воркера:
     - KV namespace, привязанный под именем INBOX;
     - секрет TOKEN — тот же ключ, что в приложении («Настройки → Траты из Apple Pay и SMS»).

   API (ключ — заголовок «Authorization: Bearer <TOKEN>» или параметр ?key=<TOKEN>):
     GET  /           проверка связи → { ok, pending }
     POST /tx         новая трата: JSON (или форма, или параметры URL)
                      { amount, currency?, merchant?, card?, text?, source? }
                      amount можно передавать текстом как есть: «₺1.234,50»
     GET  /tx         список ожидающих трат → { ok, items: [...] }
     POST /ack        удалить забранные траты: { ids: [...] }
   ===================================================================== */

const TTL_SECONDS = 30 * 24 * 3600; // необработанные траты живут 30 дней
const MAX_ITEMS = 200;
const FIELDS = { amount: 60, currency: 8, merchant: 120, card: 80, text: 1000, source: 16, sender: 80 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/** Сравнение ключей за постоянное время. */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

/** Тело запроса: JSON, форма или ничего (тогда — параметры URL). */
async function readBody(request, url) {
  const out = {};
  for (const [k, v] of url.searchParams) if (k !== 'key') out[k] = v;
  const text = await request.text();
  if (!text) return out;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && !Array.isArray(j)) return { ...out, ...j };
    return { ...out, text: String(j) };
  } catch (e) {
    // форма «a=1&b=2» или просто текст (например, SMS целиком)
    if (/^[\w.-]+=/.test(text)) for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    else out.text = text;
    return out;
  }
}

async function listItems(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.INBOX.list({ prefix: 'tx:', cursor, limit: 1000 });
    const values = await Promise.all(page.keys.slice(0, MAX_ITEMS - items.length).map((k) => env.INBOX.get(k.name, 'json')));
    values.forEach((v) => { if (v) items.push(v); });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && items.length < MAX_ITEMS);
  return items;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.INBOX || !env.TOKEN) return json({ ok: false, error: 'not_configured' }, 500);

    const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const key = auth || url.searchParams.get('key') || '';
    if (!key || !safeEqual(key, env.TOKEN)) return json({ ok: false, error: 'unauthorized' }, 401);

    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' && request.method === 'GET') {
      const page = await env.INBOX.list({ prefix: 'tx:', limit: 1000 });
      return json({ ok: true, app: 'traty-inbox', pending: page.keys.length });
    }

    if (path === '/tx' && request.method === 'POST') {
      const body = await readBody(request, url);
      const item = {};
      for (const [k, max] of Object.entries(FIELDS)) {
        const v = body[k];
        if (v == null || v === '') continue;
        item[k] = typeof v === 'number' && k === 'amount' ? v : String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, max);
      }
      if (item.amount == null && !item.text && !item.merchant) return json({ ok: false, error: 'empty' }, 400);
      const now = Date.now();
      item.id = `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      item.receivedAt = new Date(now).toISOString();
      await env.INBOX.put(`tx:${item.id}`, JSON.stringify(item), { expirationTtl: TTL_SECONDS });
      return json({ ok: true, id: item.id });
    }

    if (path === '/tx' && request.method === 'GET') {
      return json({ ok: true, items: await listItems(env) });
    }

    if (path === '/ack' && request.method === 'POST') {
      const body = await readBody(request, url);
      const ids = (Array.isArray(body.ids) ? body.ids : String(body.ids || '').split(','))
        .map((x) => String(x).trim()).filter((x) => /^[a-z0-9-]{4,60}$/.test(x)).slice(0, MAX_ITEMS);
      await Promise.all(ids.map((id) => env.INBOX.delete(`tx:${id}`)));
      return json({ ok: true, deleted: ids.length });
    }

    return json({ ok: false, error: 'not_found' }, 404);
  },
};
