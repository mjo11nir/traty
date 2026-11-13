// Локальная копия сервера «Входящие» (inbox-worker/worker.js) с поддельным хранилищем KV.
// Уведомления «отправляются» на https://push.fake/… и только запоминаются. Состояние: GET /__debug.
import http from 'node:http';
import crypto from 'node:crypto';
import worker from '../../inbox-worker/worker.js';

const store = new Map(), meta = new Map();
const INBOX = {
  async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: meta.get(name) })), list_complete: true }; },
  async get(k, t) { const v = store.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; },
  async put(k, v, o) { store.set(k, v); if (o && o.metadata) meta.set(k, o.metadata); },
  async delete(k) { store.delete(k); meta.delete(k); },
};
const vk = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const env = {
  INBOX, TOKEN: 'secret123secret123',
  VAPID_PRIVATE_JWK: JSON.stringify(await crypto.webcrypto.subtle.exportKey('jwk', vk.privateKey)),
  VAPID_PUBLIC: Buffer.from(await crypto.webcrypto.subtle.exportKey('raw', vk.publicKey)).toString('base64url'),
  PUSH_SUBJECT: 'https://x.example',
};
const pushes = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).startsWith('https://push.fake/') ? (pushes.push(String(url)), new Response(null, { status: 201 })) : realFetch(url, init));

const port = Number(process.env.PORT || 8787);
http.createServer(async (req, res) => {
  if (req.url === '/__debug') {
    res.end(JSON.stringify({ keys: [...store.keys()], pushes, push: [...store.entries()].filter(([k]) => k.startsWith('push:')).map(([, v]) => { const r = JSON.parse(v); delete r.sub; return r; }) }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const waits = [];
  const r = await worker.fetch(new Request(`http://localhost:${port}` + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : body }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`mock inbox on :${port}`));
