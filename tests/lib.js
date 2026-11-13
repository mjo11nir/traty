// Общие помощники для проверок «Трат» (Playwright уже установлен в облачной среде).
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const APP = process.env.APP_URL || 'http://localhost:8000/';
const MOCK = process.env.MOCK_URL || 'http://localhost:8787';
const INBOX_HOST = 'https://traty-inbox.traty-758cef38.workers.dev';
const AI_HOST = 'https://traty-ai.traty-758cef38.workers.dev';
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

let failed = 0, passed = 0;
/** Проверка: печатает ✓/✗ и запоминает провал. */
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== '' ? ' — ' + JSON.stringify(detail) : ''}`); }
}
function finish() {
  console.log(`  итог: ${passed} ✓, ${failed} ✗`);
  process.exit(failed ? 1 : 0);
}

/**
 * Браузер + страница приложения. Запросы к серверу «Входящие» уходят на локальную копию (tests/servers/mock-inbox.mjs),
 * запросы к ИИ — на подставные ответы (ai: функция (path, body) → объект ответа; по умолчанию — чек Migros).
 */
async function open({ device = 'iPhone 13', scheme = 'light', reducedMotion = 'no-preference', ai = defaultAi, url = APP } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices[device], colorScheme: scheme, reducedMotion });
  await ctx.route(INBOX_HOST + '/**', async (rt) => {
    const req = rt.request(), u = new URL(req.url());
    const res = await fetch(MOCK + u.pathname + u.search, { method: req.method(), headers: req.headers(), body: ['GET', 'OPTIONS'].includes(req.method()) ? undefined : req.postData() });
    rt.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
  await ctx.route(AI_HOST + '/**', async (rt) => {
    const u = new URL(rt.request().url());
    let body = {};
    try { body = JSON.parse(rt.request().postData() || '{}'); } catch (e) { /* GET */ }
    const r = await ai(u.pathname + u.search, body);
    if (r && r.sse) return rt.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream' }, body: r.sse });
    rt.fulfill({ status: (r && r.status) || 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(r) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForTimeout(1800);
  await page.keyboard.press('Escape'); // окно «Добро пожаловать»
  await page.waitForTimeout(300);
  return { browser, ctx, page, errors, shot: (name) => page.screenshot({ path: path.join(OUT, name + '.png') }) };
}
/** SSE-ответ в формате Workers AI (как настоящий поток позиций чека). */
const sse = (text) => text.split(/(?<=\n)/).map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
function defaultAi(p) {
  if (p.startsWith('/api/ai/receipt-items')) return { sse: sse('SÜT 1L|1|42.50\nEKMEK|1|15.00\nPATATES|2.7|116.82\n') };
  if (p.startsWith('/api/ai/receipt')) return { ok: true, result: { amount: 742.5, currency: 'TRY', date: '2026-11-10', merchant: 'MIGROS', comment: 'Migros: молоко, хлеб', categoryId: 'food', tags: ['продукты'], items: [] } };
  if (p.startsWith('/api/ai/suggest')) return { ok: true, result: { amount: 0, currency: '', date: '', merchant: '', comment: '', categoryId: 'home', tags: [], items: [] } };
  return { ok: true, left: 100 };
}
/** Маленькая картинка для выбора «фото чека». */
function receiptFile() {
  const f = path.join(OUT, 'receipt.png');
  fs.writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  return f;
}
const MOCK_KEY = 'secret123secret123';
module.exports = { open, check, finish, sse, receiptFile, MOCK, MOCK_KEY, OUT };
