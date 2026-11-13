// Скриншоты для просмотра глазами: светлая/тёмная тема, обычный и узкий экран, «уменьшение движения».
// Файлы — в tests/out/. Проверяется только отсутствие ошибок.
const { open, check, finish } = require('./lib');
(async () => {
  console.log('Экраны (скриншоты в tests/out/)');
  for (const [device, scheme, rm] of [['iPhone 13', 'light', 'no-preference'], ['iPhone SE', 'dark', 'reduce']]) {
    const tag = `${device.replace(/\s/g, '')}-${scheme}`;
    const { browser, page: p, errors, shot } = await open({ device, scheme, reducedMotion: rm });
    await p.evaluate(() => { const st = S(); st.incomes.push(Object.assign(makeExpense({ amount: 45000, currency: 'TRY', rate: 1, categoryId: 'salary' }), { kind: 'income' })); st.goals.push(normalizeGoal({ name: 'Отпуск', emoji: '✈️', target: 40000, saved: 12000 })); st.debts.push(normalizeDebt({ person: 'Ахмед', amount: 1200 })); Store.commit(); });
    await p.waitForTimeout(700); await shot(`${tag}-home`);
    await p.click('#fab'); await p.waitForTimeout(500); await shot(`${tag}-form`); await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    await p.click('.tab[data-tab="analytics"]'); await p.waitForTimeout(700); await shot(`${tag}-analytics`);
    for (const pl of ['budgets', 'goals', 'debts']) { await p.click('.tab[data-tab="budgets"]'); await p.click(`#pl-seg [data-pl="${pl}"]`); await p.waitForTimeout(500); await shot(`${tag}-plans-${pl}`); }
    await p.click('.tab[data-tab="settings"]'); await p.waitForTimeout(400); await p.screenshot({ path: require('path').join(__dirname, 'out', `${tag}-settings.png`), fullPage: true });
    check(`${device}, ${scheme}: без ошибок`, errors.length === 0, errors);
    await browser.close();
  }
  finish();
})().catch((e) => { console.log('  ✗ сбой проверки:', e.message.split('\n')[0]); process.exit(1); });
