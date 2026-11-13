// Связь с сервером «Входящие»: Apple Pay / быстрые записи (очередь), облачная копия, уведомления.
const { open, check, finish, MOCK, MOCK_KEY } = require('./lib');
const batch = (body) => fetch(`${MOCK}/batch?key=${MOCK_KEY}`, { method: 'POST', body }).then((r) => r.json());
(async () => {
  console.log('Входящие, копия, уведомления');
  let { browser, page: p, errors } = await open();
  await p.evaluate((k) => { S().settings.inbox = { url: 'https://traty-inbox.traty-758cef38.workers.dev', token: k, autoAdd: true }; Store.save(); }, MOCK_KEY);
  const iso = (ms) => new Date(Date.now() - ms).toISOString().replace('Z', '+00:00');
  const file = `${iso(3 * 36e5)}|quick|450|🛒 Еда|Migros|\n${iso(36e5)}|wallet|₺230,00||STARBUCKS NISANTASI|Ziraat\n`;
  await batch(file);
  const r1 = await p.evaluate(() => Inbox.sync({ force: true }));
  check('быстрая запись — сразу в историю, Apple Pay — во «Входящие»', r1 && r1.added === 1 && r1.pending === 1, r1);
  await batch(file);
  const r2 = await p.evaluate(() => Inbox.sync({ force: true }));
  check('повторная пачка не дублирует', !r2 || (r2.added === 0 && r2.pending === 0), r2);
  await p.click('[data-action="inbox"]'); await p.waitForTimeout(500);
  await p.locator('.ib-item').first().locator('[data-ib-ok]').click(); await p.waitForTimeout(900);
  check('подтверждение во «Входящих» добавляет покупку и запоминает магазин', await p.evaluate(() => S().inbox.length === 0 && Object.keys(S().merchantRules).some((k) => k.includes('starbucks'))));
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  // облачная копия
  await p.evaluate(() => { const st = S(); for (let i = 0; i < 12; i++) st.expenses.push(makeExpense({ amount: 100 + i, currency: 'TRY', rate: 1, categoryId: 'food' })); st.expenses.forEach((e) => { delete e.demo; }); Store.commit(); });
  await p.click('.tab[data-tab="settings"]'); await p.click('[data-action="backup"]'); await p.waitForTimeout(400);
  await p.click('[data-enable]'); await p.waitForTimeout(800);
  const code = await p.textContent('.bk-code.big');
  await p.check('#bk-saved'); await p.click('[data-done]'); await p.waitForTimeout(1500);
  check('копия в облаке включена', (await p.textContent('#bk-status')).includes('включена'));
  check('без изменений повторно не отправляется', (await p.evaluate(() => { S().settings.backup.lastAt = 0; return Backup.upload(); })) === 'same');
  const count = await p.evaluate(() => S().expenses.length);
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  await p.evaluate(() => { Actions.wipe(); }); await p.waitForTimeout(400); await p.click('.sheet .btn-danger'); await p.waitForTimeout(500);
  check('после «Удалить всё» пустая копия не отправляется', (await p.evaluate(() => Backup.upload())) === 'empty');
  await browser.close();
  // «новый телефон»: восстановление по коду
  ({ browser, page: p, errors: errors } = await open());
  await p.click('.tab[data-tab="settings"]'); await p.click('[data-action="backup"]'); await p.waitForTimeout(400);
  await p.click('[data-have]'); await p.waitForTimeout(300);
  await p.fill('#bk-in', code.toLowerCase().replace(/-/g, ' ')); await p.click('[data-go]'); await p.waitForTimeout(900);
  await p.click('.sheet .btn-primary >> nth=-1'); await p.waitForTimeout(900);
  await p.click('.sheet .btn-danger'); await p.waitForTimeout(800);
  check('восстановление по коду на новом телефоне', (await p.evaluate(() => S().expenses.length)) === count);
  // уведомления (подписка подставная — настоящий push нужен iPhone)
  await browser.close();
  const o = await open({ url: 'http://localhost:8000/?standalone' });
  ({ browser, page: p } = o);
  await o.ctx.addInitScript(() => {});
  await p.evaluate(() => {
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    Notification.requestPermission = async () => 'granted';
    const sub = { toJSON: () => ({ endpoint: 'https://push.fake/sub1', keys: { p256dh: 'BKgFCacHYoeMvRHgsLhc7SPu-L4CVL-GuNnvS9GCOmgTkto6ByEoX-j_3C7V7s8u5-SVbDqoPuQ4LiJEf8ithJM', auth: 'AAAAAAAAAAAAAAAAAAAAAA' } }), unsubscribe: async () => true };
    let cur = null;
    Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve({ pushManager: { getSubscription: async () => cur, subscribe: async () => (cur = sub) } }) });
  });
  await p.click('.tab[data-tab="settings"]'); await p.click('[data-action="notify"]'); await p.waitForTimeout(400);
  await p.click('[data-on]'); await p.waitForTimeout(1500);
  check('уведомления включаются', (await p.textContent('#nt-status')).includes('включены'));
  await p.click('[data-test]'); await p.waitForTimeout(800);
  const dbg = await (await fetch(MOCK + '/__debug')).json();
  check('пробное уведомление ушло на сервер', dbg.pushes.length >= 1);
  check('нет ошибок в консоли', errors.length === 0 && o.errors.length === 0, [...errors, ...o.errors]);
  await browser.close();
  finish();
})().catch((e) => { console.log('  ✗ сбой проверки:', e.message.split('\n')[0]); process.exit(1); });
