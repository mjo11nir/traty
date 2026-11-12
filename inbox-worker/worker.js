/* =====================================================================
   «Траты» — сервер «Входящие» (Cloudflare Worker).

   Команды iPhone (автоматизации «Транзакция» и «Сообщение») отправляют сюда
   каждую трату, а приложение при открытии забирает новые и удаляет их.
   Сервер ничего не анализирует и не хранит дольше 30 дней — это просто очередь.

   У каждого человека свой ключ и своя очередь: приложение получает ключ само
   (кнопка «Подключить» → POST /register). По чужому ключу чужие траты не видны.

   Нужно в настройках воркера:
     - KV namespace, привязанный под именем INBOX;
     - секрет TOKEN — ключ владельца сервера (работает всегда, даже без регистрации).
     - необязательно: переменная REGISTER = "off", чтобы запретить новые регистрации.

   API (ключ — заголовок «Authorization: Bearer <ключ>» или параметр ?key=<ключ>):
     POST /register   новый личный ключ → { ok, key }   (без ключа; не больше 5 в день с адреса)
     GET  /           проверка связи → { ok, pending }
     POST /tx         новая трата: JSON (или форма, или параметры URL)
                      { amount, currency?, merchant?, card?, text?, source?, category?, comment?, time? }
                      amount можно передавать текстом как есть: «₺1.234,50»
     POST /batch      пачка трат из файла-очереди «Команд» (работает и после офлайна):
                      по строке на трату: время|источник|сумма|категория|комментарий|карта
                      (или строка JSON). Повторная отправка той же строки не создаёт дубль.
     GET  /tx         свои ожидающие траты → { ok, items: [...] }
     POST /ack        удалить забранные траты: { ids: [...] }
     POST /backup?id= зашифрованная копия (id — из кода восстановления; хранятся 10 последних)
     GET  /backup?id= список копий (без ключа); &v=<версия> — сама копия
     GET  /push/key   открытый ключ VAPID для подписки на уведомления
     POST /push/subscribe | /push/unsubscribe | /push/state | /push/test — уведомления
   Cron (каждые 15 минут): вечернее напоминание и итоги месяца 1-го числа.
   Для уведомлений нужны VAPID_PUBLIC (переменная), VAPID_PRIVATE_JWK (секрет), PUSH_SUBJECT (адрес сервера).
   ===================================================================== */

const TTL_SECONDS = 30 * 24 * 3600; // необработанные траты живут 30 дней
const MAX_ITEMS = 200;
const REG_PER_IP_PER_DAY = 5;
const REG_PER_DAY = 50;
const FIELDS = { amount: 60, currency: 8, merchant: 120, card: 80, text: 1000, source: 16, sender: 80, category: 60, comment: 140, time: 40 };
const BATCH_COLUMNS = ['time', 'source', 'amount', 'category', 'comment', 'card'];
const MAX_BATCH = 100;

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

/** Идентификатор очереди: первые 16 символов SHA-256 от ключа (сам ключ на сервере не хранится). */
async function userId(key) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(key)));
  return Array.from(new Uint8Array(buf).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

function newKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Поля траты из произвольного объекта (с обрезкой длины). */
function pickFields(body) {
  const item = {};
  for (const [k, max] of Object.entries(FIELDS)) {
    const v = body[k];
    if (v == null || v === '') continue;
    item[k] = typeof v === 'number' && k === 'amount' ? v : String(typeof v === 'object' ? JSON.stringify(v) : v).trim().slice(0, max);
  }
  // SMS в очереди: текст сообщения приходит в колонке «комментарий»
  if (item.source === 'sms' && !item.text && item.comment) { item.text = item.comment; delete item.comment; }
  return item;
}
const isEmptyItem = (item) => item.amount == null && !item.text && !item.merchant && !item.comment;

/** Строка файла-очереди → поля траты. */
function parseLine(line) {
  if (line.startsWith('{')) { try { return pickFields(JSON.parse(line)); } catch (e) { /* как обычный текст */ } }
  const parts = line.split('|');
  if (parts.length < 3) return pickFields({ text: line });
  const obj = {};
  BATCH_COLUMNS.forEach((k, i) => { if (parts[i] != null) obj[k] = parts[i]; });
  if (parts.length > BATCH_COLUMNS.length) obj.card = parts.slice(BATCH_COLUMNS.length - 1).join('|');
  return pickFields(obj);
}

async function sha16(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
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

async function listItems(env, prefix) {
  const items = [];
  let cursor;
  do {
    const page = await env.INBOX.list({ prefix, cursor, limit: 1000 });
    const values = await Promise.all(page.keys.slice(0, MAX_ITEMS - items.length).map((k) => env.INBOX.get(k.name, 'json')));
    values.forEach((v) => { if (v) items.push(v); });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && items.length < MAX_ITEMS);
  return items;
}

/** Счётчик за сутки (для ограничения регистраций). */
async function bump(env, name) {
  const k = `rl:${name}:${new Date().toISOString().slice(0, 10)}`;
  const n = (Number(await env.INBOX.get(k)) || 0) + 1;
  await env.INBOX.put(k, String(n), { expirationTtl: 2 * 24 * 3600 });
  return n;
}

async function register(request, env) {
  if (String(env.REGISTER || '').toLowerCase() === 'off') return json({ ok: false, error: 'registration_closed' }, 403);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await bump(env, 'ip:' + ip) > REG_PER_IP_PER_DAY) return json({ ok: false, error: 'too_many' }, 429);
  if (await bump(env, 'all') > REG_PER_DAY) return json({ ok: false, error: 'too_many' }, 429);
  const key = newKey();
  await env.INBOX.put(`user:${await userId(key)}`, JSON.stringify({ createdAt: new Date().toISOString() }));
  return json({ ok: true, key });
}

/** Ключ из запроса → id очереди или null. */
async function authorize(request, url, env) {
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const key = auth || url.searchParams.get('key') || '';
  if (!/^[\w-]{16,128}$/.test(key)) return null;
  const uid = await userId(key);
  if (env.TOKEN && safeEqual(key, env.TOKEN)) return uid;
  return (await env.INBOX.get(`user:${uid}`)) ? uid : null;
}

/* =====================================================================
   Облачные копии (зашифрованы в приложении — сервер хранит только шифротекст)
   id копии выводится из кода восстановления (HKDF), сам код на сервер не попадает.
   ===================================================================== */
const BACKUP_KEEP = 10;
const BACKUP_TTL = 180 * 24 * 3600;
const BACKUP_MAX = 5 * 1024 * 1024;
const isBackupId = (id) => /^[a-f0-9]{32}$/.test(id || '');

async function backupList(env, id) {
  const page = await env.INBOX.list({ prefix: `bk:${id}:`, limit: 1000 });
  return page.keys.map((k) => ({ v: k.name.split(':')[2], at: (k.metadata && k.metadata.at) || null, size: (k.metadata && k.metadata.size) || 0 }))
    .sort((a, b) => (a.v < b.v ? 1 : -1));
}
async function backupPut(request, env, id) {
  const body = await request.text();
  if (!body || body.length > BACKUP_MAX) return json({ ok: false, error: body ? 'too_large' : 'empty' }, 400);
  let env1;
  try { env1 = JSON.parse(body); } catch (e) { return json({ ok: false, error: 'bad_envelope' }, 400); }
  if (!env1 || env1.alg !== 'A256GCM' || typeof env1.ct !== 'string' || typeof env1.iv !== 'string') return json({ ok: false, error: 'bad_envelope' }, 400);
  const v = String(Date.now() * 1000 + Math.floor(Math.random() * 1000)).padStart(18, '0'); // время + случайный хвост — без совпадений
  const at = new Date().toISOString();
  await env.INBOX.put(`bk:${id}:${v}`, body, { expirationTtl: BACKUP_TTL, metadata: { at, size: body.length } });
  const list = await backupList(env, id);
  await Promise.all(list.slice(BACKUP_KEEP).map((x) => env.INBOX.delete(`bk:${id}:${x.v}`)));
  return json({ ok: true, v, at });
}

/* =====================================================================
   Уведомления (Web Push): VAPID + шифрование aes128gcm (RFC 8291, RFC 8292)
   ===================================================================== */
const te = new TextEncoder();
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0)),
};
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; arrs.forEach((a) => { out.set(a, o); o += a.length; }); return out; };
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
/** Шифрует полезную нагрузку для подписки (aes128gcm, одна запись). */
async function encryptPush(sub, payload) {
  const uaPub = b64u.dec(sub.keys.p256dh), auth = b64u.dec(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(te.encode(payload), new Uint8Array([2]))));
  const head = new Uint8Array(21 + asPub.length);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPub.length;
  head.set(asPub, 21);
  return concat(head, ct);
}
/** Подпись VAPID (ES256) для службы уведомлений. */
async function vapidAuth(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = (o) => b64u.enc(te.encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.PUSH_SUBJECT || 'mailto:noreply@example.com' })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned));
  return `vapid t=${unsigned}.${b64u.enc(sig)}, k=${env.VAPID_PUBLIC}`;
}
/** Отправка уведомления. Возвращает HTTP-статус службы (404/410 — подписка больше не действует). */
async function sendPush(env, sub, msg) {
  const body = await encryptPush(sub, JSON.stringify(msg));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidAuth(env, sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
    body,
  });
  return res.status;
}
async function pushTo(env, uid, rec, msg) {
  try {
    const status = await sendPush(env, rec.sub, msg);
    if (status === 404 || status === 410) { await env.INBOX.delete(`push:${uid}`); return false; }
    return status >= 200 && status < 300;
  } catch (e) { return false; }
}
const pushReady = (env) => !!(env.VAPID_PRIVATE_JWK && env.VAPID_PUBLIC);
const validSub = (s) => s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
/** Местные дата и время пользователя по его часовому поясу. */
function localNow(tz) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()); }
  catch (e) { return localNow('UTC'); }
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, month: `${g('year')}-${g('month')}`, day: +g('day'), minutes: +g('hour') * 60 + +g('minute') };
}
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** Сумма траты в основной валюте пользователя (если валюта другая или непонятная — null). */
function amountInBase(item, base) {
  const raw = item.amount;
  if (typeof raw === 'number') return raw > 0 ? raw : null;
  const s = String(raw || '').trim();
  if (!s) return null;
  const marks = { TRY: /₺|\bTL\b|\bTRY\b/i, USD: /\$|\bUSD\b/i, EUR: /€|\bEUR\b/i, RUB: /₽|\bRUB\b|руб/i, GBP: /£|\bGBP\b/i, KZT: /₸|\bKZT\b/i, GEL: /₾|\bGEL\b/i };
  const cur = Object.keys(marks).find((c) => marks[c].test(s));
  if (cur && cur !== base) return null;
  let n = s.replace(/[^\d.,]/g, '');
  if (n.includes(',') && n.includes('.')) n = n.lastIndexOf(',') > n.lastIndexOf('.') ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
  else { const sep = (n.match(/[.,]/) || [])[0]; if (sep) { const p = n.split(sep); n = p.length > 2 || p[p.length - 1].length === 3 ? p.join('') : p.join('.'); } }
  const v = Number(n);
  return v > 0 ? v : null;
}
const normName = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Новые траты пришли с iPhone: отмечаем активность и проверяем бюджеты (уведомление при 80 % и 100 %). */
async function onNewItems(env, uid, items) {
  if (!pushReady(env) || !items.length) return;
  const rec = await env.INBOX.get(`push:${uid}`, 'json');
  if (!rec) return;
  const now = localNow(rec.tz);
  rec.lastActivity = now.date;
  const st = rec.state;
  if (rec.budget !== false && st && st.month === now.month) {
    rec.alerted = rec.alerted && rec.alerted.month === now.month ? rec.alerted : { month: now.month, items: {} };
    const level = (spent, limit) => (limit > 0 ? (spent >= limit ? 2 : spent >= limit * 0.8 ? 1 : 0) : 0);
    const fresh = [];
    for (const it of items) {
      if (!['wallet', 'quick', 'phrase'].includes(it.source || 'wallet')) continue;
      const v = amountInBase(it, st.base);
      if (!v) continue;
      if (st.total) st.total.spent = (st.total.spent || 0) + v;
      if (it.category && st.cats) {
        const cn = normName(it.category);
        const key = Object.keys(st.cats).find((k) => normName(st.cats[k].name) === cn);
        if (key) st.cats[key].spent = (st.cats[key].spent || 0) + v;
      }
    }
    const check = (key, name, o) => {
      if (!o) return;
      const lv = level(o.spent || 0, o.limit || 0);
      if (lv > (rec.alerted.items[key] || 0)) { rec.alerted.items[key] = lv; fresh.push({ name, lv }); }
    };
    check('total', 'Общий бюджет', st.total);
    Object.entries(st.cats || {}).forEach(([k, o]) => check(k, `Бюджет «${o.name}»`, o));
    if (fresh.length) {
      fresh.sort((a, b) => b.lv - a.lv);
      const top = fresh[0];
      await pushTo(env, uid, rec, top.lv === 2
        ? { title: '🔴 Лимит превышен', body: `${top.name}: потрачено больше, чем запланировано на месяц.`, tag: 'budget', url: './?tab=budgets' }
        : { title: '⚠️ Потрачено 80% бюджета', body: `${top.name}: осталось меньше пятой части лимита.`, tag: 'budget', url: './?tab=budgets' });
    }
  }
  await env.INBOX.put(`push:${uid}`, JSON.stringify(rec));
}
/** Раз в 15 минут: вечернее напоминание и итоги месяца 1-го числа. */
async function scheduledRun(env) {
  if (!pushReady(env)) return;
  let cursor;
  do {
    const page = await env.INBOX.list({ prefix: 'push:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const uid = k.name.slice(5);
      const rec = await env.INBOX.get(k.name, 'json');
      if (!rec || !validSub(rec.sub)) continue;
      const now = localNow(rec.tz);
      let changed = false;
      if (rec.remind && /^\d{2}:\d{2}$/.test(rec.remind)) {
        const [h, m] = rec.remind.split(':').map(Number), at = h * 60 + m;
        if (now.minutes >= at && now.minutes < at + 30 && rec.lastRemind !== now.date && rec.lastActivity !== now.date) {
          rec.lastRemind = now.date; changed = true;
          await pushTo(env, uid, rec, { title: 'Не забыли внести траты? 🧾', body: 'Сегодня ещё ничего не записано — это займёт пару секунд.', tag: 'remind', url: './' });
        }
      }
      if (rec.summary !== false && now.day === 1 && now.minutes >= 10 * 60 && rec.lastSummary !== now.month) {
        rec.lastSummary = now.month; changed = true;
        const [y, mo] = now.month.split('-').map(Number);
        const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
        await pushTo(env, uid, rec, { title: '📅 Итоги месяца готовы', body: `Посмотрите, на что ушли деньги в ${['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'][+prev.split('-')[1] - 1]}.`, tag: 'summary', url: `./?summary=${prev}` });
      }
      if (changed && await env.INBOX.get(k.name)) await env.INBOX.put(k.name, JSON.stringify(rec));
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledRun(env));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.INBOX) return json({ ok: false, error: 'not_configured' }, 500);

    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/register' && request.method === 'POST') return register(request, env);
    // копии читаются по id из кода восстановления — без ключа (на новом телефоне ключа ещё нет)
    if (path === '/backup' && request.method === 'GET') {
      const id = url.searchParams.get('id'), v = url.searchParams.get('v');
      if (!isBackupId(id)) return json({ ok: false, error: 'bad_id' }, 400);
      if (v) {
        if (!/^\d{18}$/.test(v)) return json({ ok: false, error: 'bad_version' }, 400);
        const body = await env.INBOX.get(`bk:${id}:${v}`);
        return body ? new Response(body, { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }) : json({ ok: false, error: 'not_found' }, 404);
      }
      return json({ ok: true, versions: await backupList(env, id) });
    }
    if (path === '/push/key' && request.method === 'GET') return pushReady(env) ? json({ ok: true, key: env.VAPID_PUBLIC }) : json({ ok: false, error: 'push_not_configured' }, 501);

    const uid = await authorize(request, url, env);
    if (!uid) return json({ ok: false, error: 'unauthorized' }, 401);
    const prefix = `tx:${uid}:`;

    if (path === '/' && request.method === 'GET') {
      const page = await env.INBOX.list({ prefix, limit: 1000 });
      return json({ ok: true, app: 'traty-inbox', pending: page.keys.length });
    }

    if (path === '/batch' && request.method === 'POST') {
      const lines = (await request.text()).replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_BATCH);
      const receivedAt = new Date().toISOString();
      let added = 0;
      const fresh = [];
      for (const line of lines) {
        const item = parseLine(line);
        if (isEmptyItem(item)) continue;
        // id зависит от содержимого строки: повторная отправка перезапишет ту же запись, а приложение её уже знает
        item.id = 'b-' + await sha16(uid + '|' + line);
        item.receivedAt = receivedAt;
        await env.INBOX.put(prefix + item.id, JSON.stringify(item), { expirationTtl: TTL_SECONDS });
        added++;
        fresh.push(item);
      }
      if (fresh.length && ctx) ctx.waitUntil(onNewItems(env, uid, fresh).catch(() => {}));
      return json({ ok: true, added });
    }

    if (path === '/tx' && request.method === 'POST') {
      const body = await readBody(request, url);
      const item = pickFields(body);
      if (isEmptyItem(item)) return json({ ok: false, error: 'empty' }, 400);
      const now = Date.now();
      item.id = `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      item.receivedAt = new Date(now).toISOString();
      await env.INBOX.put(prefix + item.id, JSON.stringify(item), { expirationTtl: TTL_SECONDS });
      if (ctx) ctx.waitUntil(onNewItems(env, uid, [item]).catch(() => {}));
      return json({ ok: true, id: item.id });
    }

    if (path === '/tx' && request.method === 'GET') {
      return json({ ok: true, items: await listItems(env, prefix) });
    }

    if (path === '/ack' && request.method === 'POST') {
      const body = await readBody(request, url);
      const ids = (Array.isArray(body.ids) ? body.ids : String(body.ids || '').split(','))
        .map((x) => String(x).trim()).filter((x) => /^[a-z0-9-]{4,60}$/.test(x)).slice(0, MAX_ITEMS);
      await Promise.all(ids.map((id) => env.INBOX.delete(prefix + id)));
      return json({ ok: true, deleted: ids.length });
    }

    if (path === '/backup' && request.method === 'POST') {
      const id = url.searchParams.get('id');
      if (!isBackupId(id)) return json({ ok: false, error: 'bad_id' }, 400);
      return backupPut(request, env, id);
    }

    if (path.startsWith('/push/') && request.method === 'POST') {
      if (!pushReady(env)) return json({ ok: false, error: 'push_not_configured' }, 501);
      const body = await readBody(request, url);
      const key = `push:${uid}`;
      const rec = (await env.INBOX.get(key, 'json')) || {};
      if (path === '/push/subscribe') {
        if (!validSub(body.sub)) return json({ ok: false, error: 'bad_subscription' }, 400);
        Object.assign(rec, {
          sub: { endpoint: body.sub.endpoint, keys: { p256dh: body.sub.keys.p256dh, auth: body.sub.keys.auth } },
          tz: typeof body.tz === 'string' ? body.tz.slice(0, 64) : 'UTC',
          remind: /^\d{2}:\d{2}$/.test(body.remind || '') ? body.remind : null,
          budget: body.budget !== false, summary: body.summary !== false,
        });
        await env.INBOX.put(key, JSON.stringify(rec));
        return json({ ok: true });
      }
      if (!rec.sub) return json({ ok: false, error: 'not_subscribed' }, 404);
      if (path === '/push/unsubscribe') { await env.INBOX.delete(key); return json({ ok: true }); }
      if (path === '/push/test') {
        const ok = await pushTo(env, uid, rec, { title: 'Траты', body: 'Уведомления работают ✓', tag: 'test', url: './' });
        return json({ ok }, ok ? 200 : 502);
      }
      if (path === '/push/state') {
        // сводку бюджета присылает приложение; уровни уже показанных предупреждений — самые высокие из двух сторон
        const st = body.state && typeof body.state === 'object' ? body.state : null;
        if (st) rec.state = { month: String(st.month || ''), base: String(st.base || ''), total: st.total || null, cats: st.cats && typeof st.cats === 'object' ? st.cats : {} };
        if (typeof body.lastActivity === 'string') rec.lastActivity = body.lastActivity.slice(0, 10);
        const month = rec.state ? rec.state.month : '';
        const mine = rec.alerted && rec.alerted.month === month ? rec.alerted.items : {};
        const theirs = body.alerted && typeof body.alerted === 'object' ? body.alerted : {};
        const items = {};
        new Set([...Object.keys(mine), ...Object.keys(theirs)]).forEach((k) => { items[k] = Math.max(Number(mine[k]) || 0, Number(theirs[k]) || 0); });
        rec.alerted = { month, items };
        await env.INBOX.put(key, JSON.stringify(rec));
        return json({ ok: true, alerted: items });
      }
    }

    return json({ ok: false, error: 'not_found' }, 404);
  },
};
