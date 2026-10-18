// Leaderboard end-to-end test. Needs the game served over http with the API, e.g. `vercel dev`
// or any server that routes /api/leaderboard to api/leaderboard.js.
//   BASE=http://localhost:3000 ADMIN_KEY=... NODE_PATH=$(npm root -g) node tests/leaderboard.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';
const problems = [];
const ok = (c, m) => { if (!c) { problems.push(m); console.log('  ✗ ' + m); } };
const browser = await chromium.launch();
const tag = 'T' + Date.now().toString(36).slice(-5).toUpperCase();   // unique class code so real data is untouched

async function student(name, setup, viewport) {
  const page = await browser.newPage({ viewport: viewport || { width: 1280, height: 900 } });
  page.on('pageerror', e => problems.push(name + ' pageerror: ' + e.message));
  await page.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
  await page.goto(BASE + '/');
  await page.fill('#agent-name', name);
  await page.fill('#agent-class', tag.toLowerCase());
  if (setup.optOut) await page.uncheck('#agent-lb');
  await page.click('[data-form="intro"] button[type="submit"]');
  await page.waitForSelector('.spine');
  // give the student progress, then save via Settings (which syncs)
  await page.evaluate(s => {
    const S = window.PQ.S;
    for (let n = 1; n <= s.done; n++) Object.assign(S.missions[n], { done: true, stars: s.stars[n - 1], best: s.best[n - 1], plays: 1 });
    S.xp = s.xp; if (s.exam != null) S.exam.best = s.exam;
  }, setup);
  await page.click('[data-act="settings"]');
  await page.click('[data-form="name"] button[type="submit"]');
  await page.waitForTimeout(1200);
  return page;
}
const ana = await student('Ana', { done: 5, stars: [3, 3, 3, 2, 3], best: [1, 1, 0.9, 0.85, 1], xp: 1400, exam: 87 });
const ben = await student('Ben', { done: 2, stars: [2, 1], best: [0.8, 0.75, 0, 0, 0], xp: 300 });
const cy = await student('Cy', { done: 5, stars: [3, 3, 3, 3, 3], best: [1, 1, 1, 1, 1], xp: 1700, exam: 93 });
const hidden = await student('Hidden', { done: 1, stars: [1], best: [0.7, 0, 0, 0, 0], xp: 90, optOut: true });

await ben.click('.hero [data-act="leaderboard"]');
await ben.waitForSelector('.lb');
const rows = await ben.$$eval('.lb tbody tr', trs => trs.map(t => [t.querySelector('.rk').textContent, t.querySelector('.nm').textContent, t.className]));
console.log('  class ' + tag + ':', JSON.stringify(rows));
ok(rows.length === 3, 'expected 3 students on the board (opt-out hidden), got ' + rows.length);
ok(rows[0] && rows[0][1] === 'Cy' && rows[1][1] === 'Ana' && rows[2][1] === 'Ben', 'ranking order wrong');
ok(rows[2] && rows[2][2].includes('me'), 'own row not highlighted');
ok(await ben.$('.podium'), 'podium missing');
const quest = await ben.$eval('.lb tbody tr:first-child td.num', td => td.textContent.trim());
ok(quest === '97', 'Cy final score should be round(100/2 + 93/2) = 97, got ' + quest);
await ben.screenshot({ path: process.env.SHOT || '/tmp/lb.png' });
// the opted-out student sees an explanation
await hidden.click('.hero [data-act="leaderboard"]');
await hidden.waitForSelector('.notice');
ok(/chose not to appear/.test(await hidden.textContent('.notice')), 'opt-out notice missing');
// teacher removes Ben
if (process.env.ADMIN_KEY) {
  await cy.click('.hero [data-act="leaderboard"]');
  await cy.waitForSelector('.lb');
  await cy.click('.box summary');
  await cy.fill('#lb-key', 'wrong-key'); await cy.click('[data-form="lb-admin"] button');
  await cy.waitForTimeout(800);
  ok(/not accepted/.test(await cy.textContent('details.box')), 'wrong teacher key not reported');
  await cy.fill('#lb-key', process.env.ADMIN_KEY); await cy.click('[data-form="lb-admin"] button');
  await cy.waitForSelector('[data-act="lb-del"]');
  const del = await cy.$$('[data-act="lb-del"]');
  ok(del.length === 3, 'remove buttons not shown for each student');
  for (const name of ['Ben', 'Ana', 'Cy']) {
    await cy.click(`[data-act="lb-del"][data-n="${name}"]`);
    await cy.click('[data-act="confirm-yes"]');
    await cy.waitForTimeout(900);
  }
  const left = await cy.$$('.lb tbody tr');
  ok(left.length === 0, 'students not removed: ' + left.length);
}
// mobile layout
const m = await student('Mo', { done: 1, stars: [2], best: [0.8, 0, 0, 0, 0], xp: 120 }, { width: 390, height: 844 });
await m.click('.hero [data-act="leaderboard"]');
await m.waitForSelector('.lb');
const w = await m.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
ok(w[0] <= w[1], 'mobile horizontal scroll ' + w);
if (process.env.SHOT) await m.screenshot({ path: process.env.SHOT.replace('.png', '-mobile.png') });
if (process.env.ADMIN_KEY) {
  const id = await m.evaluate(() => window.PQ.S.pid);
  await m.evaluate(async ([id, k]) => fetch('/api/leaderboard?id=' + id, { method: 'DELETE', headers: { 'x-admin-key': k } }), [id, process.env.ADMIN_KEY]);
}
await browser.close();
if (problems.length) { console.log('\nLEADERBOARD PROBLEMS:'); problems.forEach(p => console.log('  - ' + p)); process.exit(1); }
console.log('Leaderboard test passed.');
