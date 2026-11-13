// Серверы без браузера: «Входящие» (очереди, пачки, копии, уведомления) и ИИ (доступ, лимиты, позиции чека).
import inbox from '../inbox-worker/worker.js';
import ai from '../traty-ai-worker/worker.js';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let failed = 0, passed = 0;
const check = (name, ok, d = '') => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name} — ${JSON.stringify(d)}`); } };
const kv = () => {
  const store = new Map(), meta = new Map();
  return { store, async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: meta.get(name) })), list_complete: true }; },
    async get(k, t) { const v = store.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; },
    async put(k, v, o) { store.set(k, v); if (o && o.metadata) meta.set(k, o.metadata); }, async delete(k) { store.delete(k); meta.delete(k); } };
};
const b64u = (b) => Buffer.from(b).toString('base64url');

// ---------- «Входящие» ----------
const INBOX = kv();
const vk = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const env = { INBOX, TOKEN: 'ownerkey1234567890abcdef', VAPID_PRIVATE_JWK: JSON.stringify(await crypto.webcrypto.subtle.exportKey('jwk', vk.privateKey)), VAPID_PUBLIC: b64u(new Uint8Array(await crypto.webcrypto.subtle.exportKey('raw', vk.publicKey))), PUSH_SUBJECT: 'https://x.example' };
const sent = [];
globalThis.fetch = async (url, init) => { sent.push({ url, init }); return new Response(null, { status: 201 }); };
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const call = async (w, e, path, init = {}) => { const r = await w.fetch(new Request('https://w' + path, init), e, ctx); await Promise.all(waits.splice(0)); return [r.status, await r.json().catch(() => null)]; };
const K = '?key=' + env.TOKEN;
console.log('Сервер «Входящие»');
check('без ключа — 401', (await call(inbox, env, '/'))[0] === 401);
const reg = await call(inbox, env, '/register', { method: 'POST', headers: { 'CF-Connecting-IP': '1.1.1.1' } });
check('регистрация выдаёт ключ', reg[1] && /^[a-f0-9]{36}$/.test(reg[1].key), reg);
const friend = '?key=' + reg[1].key;
await call(inbox, env, '/tx' + K, { method: 'POST', body: JSON.stringify({ amount: '₺5', merchant: 'Owner', source: 'wallet' }) });
await call(inbox, env, '/tx' + friend, { method: 'POST', body: JSON.stringify({ amount: '₺7', merchant: 'Friend', source: 'wallet' }) });
const own = (await call(inbox, env, '/tx' + K))[1].items, fr = (await call(inbox, env, '/tx' + friend))[1].items;
check('очереди раздельные', own.length === 1 && own[0].merchant === 'Owner' && fr.length === 1 && fr[0].merchant === 'Friend', { own, fr });
const file = '2026-11-12T09:00:00+03:00|quick|450|🛒 Еда|Migros|\n2026-11-12T09:05:00+03:00|wallet|₺85,00||Kahve|Ziraat\n';
await call(inbox, env, '/batch' + K, { method: 'POST', body: file });
await call(inbox, env, '/batch' + K, { method: 'POST', body: file });
check('повторная отправка пачки не создаёт дублей', (await call(inbox, env, '/tx' + K))[1].items.length === 3);
check('старый способ /tx (команды на iPhone) работает', (await call(inbox, env, '/tx' + K, { method: 'POST', body: JSON.stringify({ amount: '1', merchant: 'x', source: 'wallet' }) }))[0] === 200);
// копии
const bid = 'a'.repeat(32);
for (let i = 0; i < 12; i++) await call(inbox, env, `/backup${K}&id=${bid}`, { method: 'POST', body: JSON.stringify({ v: 1, alg: 'A256GCM', iv: 'x', ct: 'y' + i }) });
const vers = (await call(inbox, env, `/backup?id=${bid}`))[1].versions;
check('копий хранится 10, список без ключа', vers.length === 10, vers.length);
check('копию нельзя записать без ключа', (await call(inbox, env, `/backup?id=${bid}`, { method: 'POST', body: '{}' }))[0] === 401);
// уведомления: шифрование расшифровывается библиотекой http_ece, как в браузере
let ece = null;
try { ece = require('http_ece'); } catch (e) { console.log('  · http_ece не установлен — проверка шифрования пропущена (bash tests/run.sh ставит его сам)'); }
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const auth = crypto.randomBytes(16);
const sub = { endpoint: 'https://push.example.test/abc', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
check('подписка на уведомления', (await call(inbox, env, '/push/subscribe' + K, { method: 'POST', body: JSON.stringify({ sub, tz: 'Europe/Istanbul', remind: '21:00', budget: true }) }))[0] === 200);
sent.length = 0;
await call(inbox, env, '/push/test' + K, { method: 'POST', body: '{}' });
check('пробное уведомление отправлено', sent.length === 1);
if (ece && sent[0]) {
  const txt = ece.decrypt(Buffer.from(sent[0].init.body), { version: 'aes128gcm', privateKey: ua, authSecret: auth }).toString();
  check('уведомление расшифровывается (aes128gcm)', JSON.parse(txt).body.includes('работают'), txt);
  const [h, c, sg] = sent[0].init.headers.Authorization.match(/t=([^,]+)/)[1].split('.');
  check('подпись VAPID верная', await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk.publicKey, Buffer.from(sg, 'base64url'), Buffer.from(h + '.' + c)));
}

// ---------- ИИ ----------
console.log('Сервер ИИ');
const AIKV = kv();
const uid = async (k) => Array.from(new Uint8Array(await crypto.webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(k))).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
const friendKey = 'friendkey1234567890abcd';
await AIKV.put(`user:${await uid(friendKey)}`, '{}');
let answer = JSON.stringify({ amount: '742,50', currency: 'try', date: '2026-11-10', merchant: 'MIGROS', comment: 'Мигрос', categoryId: 'food', tags: ['#продукты'] });
const aienv = { INBOX: AIKV, TOKEN: env.TOKEN, AI: { run: async (model, opts) => (opts.stream ? 'STREAM' : { response: 'Вот ответ: ' + answer + ' готово' }) } };
const aicall = (path, key, body) => call(ai, aienv, path, { method: body ? 'POST' : 'GET', headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
check('ИИ: без ключа — 401', (await aicall('/api/ai/health'))[0] === 401);
check('ИИ: ключ друга пускает', (await aicall('/api/ai/health', friendKey))[1].ok === true);
const cats = [{ id: 'food', name: 'Еда' }, { id: 'other', name: 'Другое' }];
const rc = (await aicall('/api/ai/receipt', friendKey, { image: { mimeType: 'image/jpeg', data: 'AAAA' }, categories: cats, baseCurrency: 'TRY' }))[1];
check('ИИ: ответ приводится к одному виду', rc.ok && rc.result.amount === 742.5 && rc.result.currency === 'TRY' && rc.result.tags[0] === 'продукты', rc);
answer = JSON.stringify({ amount: 1, categoryId: 'не-существует' });
check('ИИ: несуществующая категория → other', (await aicall('/api/ai/suggest', friendKey, { description: 'x', categories: cats }))[1].result.categoryId === 'other');
check('ИИ: плохая картинка — 400', (await aicall('/api/ai/receipt', friendKey, { image: { mimeType: 'image/gif', data: 'A' } }))[0] === 400);
const r = await ai.fetch(new Request('https://w/api/ai/receipt-items?stream=1', { method: 'POST', headers: { Authorization: 'Bearer ' + friendKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ image: { mimeType: 'image/jpeg', data: 'AAAA' } }) }), aienv, ctx);
check('ИИ: позиции чека отдаются потоком', r.headers.get('content-type').includes('event-stream') && (await r.text()) === 'STREAM');
for (let i = 0; i < 130; i++) await aicall('/api/ai/suggest', friendKey, { description: 'x', categories: cats });
check('ИИ: дневной лимит → 429', (await aicall('/api/ai/suggest', friendKey, { description: 'x', categories: cats }))[0] === 429);

console.log(`  итог: ${passed} ✓, ${failed} ✗`);
process.exit(failed ? 1 : 0);
