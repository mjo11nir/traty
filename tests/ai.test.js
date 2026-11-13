// ИИ-помощник с подставными ответами: чек → форма, позиции чека (поток), категория по комментарию, фраза, лимит.
const { open, check, finish, receiptFile, sse, MOCK_KEY } = require('./lib');
(async () => {
  console.log('ИИ-помощник');
  let mode = 'ok';
  const ai = (path) => {
    if (mode === 'limit') return { status: 429, ok: false, error: 'limit' };
    if (path.startsWith('/api/ai/receipt-items')) return { sse: sse('SÜT 1L|1|42.50\nEKMEK|1|15.00\nPATATES|2.7|116.82\n') };
    if (path.startsWith('/api/ai/receipt')) return { ok: true, result: { amount: 742.5, currency: 'TRY', date: '2026-11-10', merchant: 'MIGROS', comment: 'Migros: молоко, хлеб', categoryId: 'food', tags: ['продукты'] } };
    return { ok: true, result: { categoryId: 'home', tags: [] } };
  };
  const { browser, page: p, errors } = await open({ ai });
  await p.evaluate((k) => { S().settings.inbox = { url: DEFAULT_INBOX_URL, token: k, autoAdd: true }; Store.save(); }, MOCK_KEY);
  await p.click('.tab[data-tab="settings"]'); await p.waitForTimeout(300);
  const st = await p.locator('#st-content').innerText();
  check('в настройках нет полей ИИ (ключей, адресов)', !/Gemini|Worker|токен/i.test(st));
  await p.click('.tab[data-tab="home"]');
  // чек: форма заполняется, позиции приходят потоком
  await p.click('#fab'); await p.waitForTimeout(400);
  const fc = p.waitForEvent('filechooser'); await p.click('#f-receipt'); await (await fc).setFiles(receiptFile());
  await p.waitForTimeout(1500);
  const form = await p.evaluate(() => [$('#f-amount').value, $('#f-comment').value, $('.cat-tile.on') && $('.cat-tile.on').dataset.c, $('#f-date').value]);
  check('чек заполняет форму', form[0] === '742,5' && form[2] === 'food' && form[3] === '2026-11-10', form);
  check('позиции чека показаны в форме', (await p.locator('#f-items .rc-row').count()) === 3);
  await p.click('#f-save'); await p.waitForTimeout(500);
  check('позиции сохранены с покупкой', (await p.evaluate(() => (S().expenses.at(-1).items || []).length)) === 3);
  await p.fill('#home-search', 'patates'); await p.waitForTimeout(400);
  check('поиск по позиции чека', (await p.locator('#home-list .tx').count()) === 1);
  await p.fill('#home-search', ''); await p.waitForTimeout(300);
  // категория по комментарию: свой словарь, потом ИИ
  await p.click('#fab'); await p.waitForTimeout(400);
  await p.fill('#f-comment', 'латте'); await p.press('#f-comment', 'Enter'); await p.waitForTimeout(300);
  check('категория по словарю (латте → кафе)', (await p.evaluate(() => $('.cat-tile.on') && $('.cat-tile.on').dataset.c)) === 'cafe');
  await p.keyboard.press('Escape'); await p.waitForTimeout(400); await p.click('#fab'); await p.waitForTimeout(400);
  await p.fill('#f-comment', 'вызов сантехника'); await p.press('#f-comment', 'Enter'); await p.waitForTimeout(800);
  check('категория через ИИ', (await p.evaluate(() => $('.cat-tile.on') && $('.cat-tile.on').dataset.c)) === 'home');
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  await p.fill('#phrase-in', 'сантехник 1500'); await p.press('#phrase-in', 'Enter'); await p.waitForTimeout(1200);
  check('фраза: ИИ подобрал категорию, запись добавлена', await p.evaluate(() => { const e = S().expenses.at(-1); return e.amount === 1500 && e.categoryId === 'home'; }));
  // ИИ недоступен
  mode = 'limit';
  await p.fill('#phrase-in', 'сантехник 900'); await p.press('#phrase-in', 'Enter'); await p.waitForTimeout(900);
  check('без ИИ фраза открывает форму', (await p.locator('.sheet-form').count()) === 1);
  const fc2 = p.waitForEvent('filechooser'); await p.click('#f-receipt'); await (await fc2).setFiles(receiptFile()); await p.waitForTimeout(1200);
  check('понятная ошибка при лимите', (await p.textContent('#rc-status')).includes('Лимит'));
  check('нет ошибок в консоли', errors.length === 0, errors);
  await browser.close();
  finish();
})().catch((e) => { console.log('  ✗ сбой проверки:', e.message.split('\n')[0]); process.exit(1); });
