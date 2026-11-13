// Основное: покупка, шаблон, фраза, доход, цели, долги, аналитика, итоги, бюджет, удаление, импорт/экспорт, перенос старых данных.
const { open, check, finish } = require('./lib');
(async () => {
  const { browser, ctx, page: p, errors } = await open();
  console.log('Приложение');
  const n0 = await p.evaluate(() => S().expenses.length);
  // покупка вручную
  await p.click('#fab'); await p.waitForTimeout(400);
  await p.click('#f-save'); await p.waitForTimeout(80);
  check('пустая сумма — поле «трясётся»', (await p.evaluate(() => getComputedStyle($('.sheet .amount-wrap')).animationName)) === 'shake');
  await p.fill('#f-amount', '77'); await p.click('#f-cats [data-c="food"]'); await p.click('#f-save'); await p.waitForTimeout(500);
  check('покупка добавлена', (await p.evaluate(() => S().expenses.length)) === n0 + 1);
  // шаблон
  await p.click('#home-templates [data-action="tpl"] >> nth=0'); await p.waitForTimeout(600);
  check('шаблон добавляет покупку', (await p.evaluate(() => S().expenses.length)) === n0 + 2);
  // фраза
  const parsed = await p.evaluate(() => [parsePhrase('такси 380 вчера'), parsePhrase('зарплата 45к'), parsePhrase('кофе 3,5 $'), parsePhrase('стрижка в барбершопе 300')]
    .map((r) => [r.kind, r.amount, r.currency, r.categoryId, r.date]));
  check('разбор фраз', parsed[0][0] === 'expense' && parsed[0][1] === 380 && parsed[0][3] === 'transport' && parsed[1][0] === 'income' && parsed[1][1] === 45000 && parsed[2][2] === 'USD' && parsed[3][3] !== 'cafe', parsed);
  await p.fill('#phrase-in', 'такси 380 вчера'); await p.press('#phrase-in', 'Enter'); await p.waitForTimeout(600);
  check('фраза добавляет покупку', (await p.evaluate(() => { const e = S().expenses.at(-1); return e.comment === 'Такси' && e.amount === 380; })));
  // доход
  await p.click('#fab'); await p.waitForTimeout(400);
  await p.click('#f-kind [data-k="income"]'); await p.fill('#f-amount', '45000'); await p.click('#f-cats [data-c="salary"]'); await p.click('#f-save'); await p.waitForTimeout(600);
  check('доход добавлен', (await p.evaluate(() => S().incomes.length)) === 1);
  check('на главной видны «Доходы»', (await p.locator('.hero-inc').count()) === 1);
  // цели
  await p.click('.tab[data-tab="budgets"]'); await p.click('#pl-seg [data-pl="goals"]'); await p.waitForTimeout(400);
  await p.click('#pl-content [data-action="goal-new"]'); await p.waitForTimeout(400);
  await p.fill('#g-name', 'Отпуск'); await p.fill('#g-target', '40000'); await p.fill('#g-saved', '12000'); await p.click('.sheet [data-save]'); await p.waitForTimeout(500);
  await p.click('.goal-card [data-action="goal-topup"]'); await p.waitForTimeout(400);
  await p.click('#gt-quick [data-v] >> nth=-1'); await p.click('.sheet [data-save]'); await p.waitForTimeout(600);
  check('цель пополнена до конца и достигнута', await p.evaluate(() => { const g = S().goals[0]; return g.saved === 40000 && !!g.doneAt; }));
  // долги
  await p.click('#pl-seg [data-pl="debts"]'); await p.waitForTimeout(400);
  await p.click('#pl-content [data-action="debt-new"]'); await p.waitForTimeout(400);
  await p.fill('#d-person', 'Ахмед'); await p.fill('#d-amt', '1200'); await p.click('.sheet [data-save]'); await p.waitForTimeout(500);
  await p.click('.debt-row'); await p.waitForTimeout(400);
  await p.fill('#part-in', '500'); await p.click('[data-part]'); await p.waitForTimeout(300); await p.click('[data-all]'); await p.waitForTimeout(600);
  check('долг: частичный и полный возврат', await p.evaluate(() => { const d = S().debts[0]; return d.paid === 1200 && !!d.closedAt; }));
  // аналитика и итоги
  await p.click('.tab[data-tab="analytics"]'); await p.waitForTimeout(600);
  for (const per of ['week', 'year', 'month']) { await p.click(`#an-seg [data-period="${per}"]`); await p.waitForTimeout(250); }
  check('аналитика: карточки и «Доходы и расходы»', (await p.locator('#an-content .card').count()) >= 4 && (await p.locator('.inc-card').count()) === 1);
  await p.click('.sum-cta'); await p.waitForTimeout(800);
  const png = await p.evaluate(async () => { let n = 0; window.shareOrDownload = async (bl) => { n = bl.size; return true; }; $('.sheet [data-share]').click(); await new Promise((r) => setTimeout(r, 800)); return n; });
  check('итоги месяца: картинка создаётся', png > 50000, png);
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  // бюджет 80%
  await p.evaluate(() => { const st = S(); const c = st.categories.find((x) => x.id === 'transport'); const spent = sumBase(inRange(st.expenses.filter((e) => e.categoryId === 'transport' && !e.demo), monthStart(todayISO()), monthEnd(todayISO()))); c.budget = Math.round((spent + 200) / 0.85); Store.commit(); });
  await p.waitForTimeout(800);
  await p.click('.tab[data-tab="home"]'); await p.fill('#phrase-in', 'такси 250'); await p.press('#phrase-in', 'Enter'); await p.waitForTimeout(1300);
  check('предупреждение «80% бюджета»', (await p.$$eval('.toast span', (els) => els.map((e) => e.textContent).join(' '))).includes('80%'));
  // удаление и отмена
  const before = await p.evaluate(() => S().expenses.length);
  const id = await p.evaluate(() => $('#home-list .tx').dataset.id);
  await p.click(`#home-list .tx[data-id="${id}"]`); await p.waitForTimeout(500); await p.click('#f-del'); await p.waitForTimeout(800);
  check('удаление', (await p.evaluate(() => S().expenses.length)) === before - 1);
  await p.click('.toast button >> nth=-1'); await p.waitForTimeout(500);
  check('«Отменить» возвращает покупку', (await p.evaluate(() => S().expenses.length)) === before);
  // экспорт → импорт с заменой
  const exported = await p.evaluate(async () => { let out; window.shareOrDownload = async (blob) => { out = await blob.text(); return true; }; await exportJSON(); return out; });
  const j = JSON.parse(exported);
  check('экспорт JSON содержит доходы, цели, долги', j.incomes.length === 1 && j.goals.length === 1 && j.debts.length === 1);
  await p.evaluate(() => { const st = S(); st.incomes = []; st.goals = []; st.debts = []; Store.commit(); });
  await p.evaluate((txt) => { handleImportFile(new File([txt], 'b.json', { type: 'application/json' })); }, exported); await p.waitForTimeout(400);
  await p.click('.sheet .btn-danger'); await p.waitForTimeout(500);
  check('импорт с заменой всё возвращает', await p.evaluate(() => S().incomes.length === 1 && S().goals.length === 1 && S().debts.length === 1));
  // перенос данных самой первой версии
  const p2 = await ctx.newPage(); p2.on('pageerror', (e) => errors.push('p2: ' + e.message));
  await p2.goto(p.url()); await p2.evaluate(() => localStorage.setItem('traty.data.v1', JSON.stringify({ v: 1, settings: { baseCurrency: 'TRY', currencies: ['TRY'] }, categories: [], expenses: [{ id: 'a', amount: 10, currency: 'TRY', rate: 1, baseAmount: 10, categoryId: 'food', date: '2026-11-10', createdAt: 1 }], templates: [], meta: {} })));
  await p2.reload(); await p2.waitForTimeout(1500);
  check('старые данные (1.0) открываются', await p2.evaluate(() => S().expenses.length === 1 && Array.isArray(S().incomes) && Array.isArray(S().goals) && !!S().settings.notify));
  for (const t of ['home', 'analytics', 'budgets', 'settings']) { await p2.evaluate((x) => App.go(x), t); await p2.waitForTimeout(150); }
  check('нет ошибок в консоли', errors.length === 0, errors);
  await browser.close();
  finish();
})().catch((e) => { console.log('  ✗ сбой проверки:', e.message.split('\n')[0]); process.exit(1); });
