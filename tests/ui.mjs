// End-to-end UI test: plays every mission and the exam in a real browser.
//   NODE_PATH=$(npm root -g) node tests/ui.mjs [--shots dir]
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(path.join(here, '..', 'index.html')).href;
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
if (shots) fs.mkdirSync(shots, { recursive: true });

const problems = [];
const ok = (cond, msg) => { if (!cond) { problems.push(msg); console.log('  ✗ ' + msg); } };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });

async function newPage(viewport) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && !/net::ERR/.test(m.text())) problems.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(url);
  return page;
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: false }); };
async function noHScroll(page, label) {
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  ok(w[0] <= w[1], label + ': horizontal scroll (' + w[0] + ' > ' + w[1] + ')');
}
// Click the correct answer for the current question through the real UI.
async function answer(page, correct) {
  const info = await page.evaluate(() => {
    const { R } = window.PQ; let inst;
    if (R.screen === 'exam') inst = R.exam.insts[R.exam.i];
    else { const s = R.run.slots[R.run.i]; inst = s.stage === 'main' ? s.inst : s.stage === 'follow' ? s.fi : s.ri; }
    const B = inst.q;
    const role = R.screen === 'exam' ? 'main' : (() => { const s = R.run.slots[R.run.i]; return s.stage === 'follow' ? 'follow' : s.stage === 'reinf' ? 'reinf' : 'main'; })();
    return { role, type: B.type, ans: B.ans, nopts: B.opts ? B.opts.length : 0, lineAns: B.lineAns, nlines: B.lines ? B.lines.length : 0, expected: B.expected, blanks: B.blanks, bank: B.bank,
      nord: B.ordLines ? B.ordLines.length : 0, perm: B.perm, rows: B.rows && B.rows.map(r => B.choices.indexOf(r.ans)), nch: B.choices && B.choices.length,
      match: B.left && B.left.map(n => B.right.indexOf(B.ansMap[n])), canonChain: B.br && B.br.map((_, i) => i) };
  });
  const click = sel => page.click('#card-' + info.role + ' ' + sel);
  switch (info.type) {
    case 'mcq': await click(`[data-act="opt"][data-i="${correct ? info.ans : (info.ans + 1) % info.nopts}"]`); break;
    case 'line': { let i = info.lineAns[0]; if (!correct) { i = 0; while (info.lineAns.includes(i)) i++; } await click(`[data-act="line"][data-i="${i}"]`); break; }
    case 'type': await page.fill('#card-' + info.role + ' #ans-type', correct ? info.expected : 'wrong answer'); break;
    case 'fill':
      for (let i = 0; i < info.blanks.length; i++) {
        await click(`[data-act="blank"][data-i="${i}"]`);
        const t = correct || i > 0 ? info.blanks[i] : info.bank.find(x => x !== info.blanks[i]);
        await click(`[data-act="chip"][data-t="${t.replace(/"/g, '\\"')}"]`);
      }
      break;
    case 'order': {
      const order = [...Array(info.nord).keys()]; if (!correct) order.reverse();
      for (const i of order) await click(`[data-act="ord-add"][data-i="${i}"]`);
      break;
    }
    case 'chain': {
      if (correct) {
        for (let pass = 0; pass < 6; pass++) {
          const cur = await page.evaluate(() => { const R = window.PQ.R; const s = R.run.slots[R.run.i]; return (s.stage === 'main' ? s.inst : s.ri).sel; });
          const k = cur.findIndex((v, i) => i > 0 && cur[i - 1] > v);
          if (k < 0) break;
          await click(`[data-act="ch-up"][data-k="${k}"]`);
        }
      }
      break;
    }
    case 'table': for (let r = 0; r < info.rows.length; r++) await click(`[data-act="tcell"][data-r="${r}"][data-c="${correct ? info.rows[r] : (info.rows[r] + 1) % info.nch}"]`); break;
    case 'match': {
      const m = correct ? info.match : info.match.slice().reverse();
      for (let i = 0; i < m.length; i++) { await click(`[data-act="m-left"][data-i="${i}"]`); await click(`[data-act="m-right"][data-j="${m[i]}"]`); }
      break;
    }
  }
  return info.type;
}
const state = page => page.evaluate(() => JSON.parse(JSON.stringify(window.PQ.S)));
const runState = page => page.evaluate(() => { const r = window.PQ.R.run; return r && { i: r.i, xp: r.xp, stage: r.slots[r.i].stage, streak: r.streak }; });

async function playMission(page, n, opts = {}) {
  await page.click(`[data-act="start"][data-m="${n}"]`);
  await page.waitForSelector('.brief');
  // step through every lesson, running each example
  for (;;) {
    await page.click('[data-act="lrun"]');
    const term = await page.textContent('.runner .term');
    ok(term && term.length > 0, `mission ${n} lesson output empty`);
    if (await page.$('[data-act="lnext"]')) await page.click('[data-act="lnext"]'); else break;
  }
  if (opts.shotBrief) await shot(page, 'brief-m' + n);
  await page.click('.brief [data-act="brief-skip"]');
  const types = new Set();
  for (let k = 0; k < 8; k++) {
    await page.waitForSelector('.qcard');
    const wrongFirst = opts.wrongAt && opts.wrongAt.includes(k);
    const t = await answer(page, !wrongFirst);
    types.add(t);
    if (opts.shotTypes && !opts.shotTypes.has(t)) { opts.shotTypes.add(t); await shot(page, 'q-' + t); }
    const before = (await runState(page)).xp;
    await page.click('[data-act="check"]');
    // pressing Enter / clicking again must not award XP twice
    await page.keyboard.press('Enter').catch(() => {});
    let rs = await runState(page);
    if (rs.i !== k) { ok(false, 'Enter skipped ahead unexpectedly'); }
    if (wrongFirst) {
      ok(rs.stage === 'main-wrong' || rs.stage === 'reinf', `mission ${n} q${k}: wrong answer not detected (stage ${rs.stage})`);
      ok(rs.xp === before, `mission ${n} q${k}: XP given for a wrong answer`);
      if (rs.stage === 'main-wrong') await page.click('[data-act="next"]');
      if (opts.shotTypes && !opts.shotTypes.has('reinf')) { opts.shotTypes.add('reinf'); await shot(page, 'q-reinforcement'); }
      await answer(page, true);
      await page.click('[data-act="check"]');
    }
    rs = await runState(page);
    if (rs.stage === 'follow') { await answer(page, true); await page.click('[data-act="check"]'); }
    rs = await runState(page);
    ok(rs.stage === 'done', `mission ${n} q${k}: stage is ${rs.stage} after answering`);
    await page.click('[data-act="next"]');
  }
  await page.waitForSelector('.result');
  return types;
}

/* ===== Desktop playthrough ===== */
{
  console.log('Desktop playthrough');
  const page = await newPage({ width: 1280, height: 860 });
  await shot(page, 'intro');
  await page.fill('#agent-name', 'Nova');
  await page.click('[data-form="intro"] button[type="submit"]');
  await page.waitForSelector('.spine');
  await shot(page, 'map-start');
  ok(!(await page.$('[data-act="start"][data-m="2"]')), 'mission 2 should be locked at the start');
  const shotTypes = new Set();
  let xpPrev = 0;
  for (const n of [1, 2, 3, 4, 5]) {
    const types = await playMission(page, n, { wrongAt: n === 1 ? [0, 4] : n === 4 ? [2] : [], shotTypes, shotBrief: n === 5 });
    const S = await state(page);
    ok(S.missions[n].done, `mission ${n} not marked done`);
    const want = n === 1 || n === 4 ? (S.missions[n].best >= 0.9 ? 3 : 2) : 3;
    ok(S.missions[n].stars === want, `mission ${n} stars ${S.missions[n].stars}, expected ${want} (best ${S.missions[n].best})`);
    ok(S.badges[['output-master', 'input-expert', 'variable-wizard', 'decision-maker', 'python-champion'][n - 1]], `mission ${n} badge missing`);
    ok(S.xp > xpPrev, `mission ${n}: XP did not increase`);
    console.log(`  mission ${n}: best ${Math.round(S.missions[n].best * 100)}%, stars ${S.missions[n].stars}, XP ${S.xp}, types ${[...types].join(',')}`);
    xpPrev = S.xp;
    if (n === 5) await shot(page, 'mission-result');
    await page.click('.result [data-act="home"]');
    await page.waitForSelector('.spine');
  }
  await shot(page, 'map-done');
  // reload keeps progress
  await page.reload();
  await page.waitForSelector('.spine');
  const S1 = await state(page);
  ok([1, 2, 3, 4, 5].every(n => S1.missions[n].done), 'progress lost after reload');
  // replay gives half XP and keeps stars
  const xpBeforeReplay = S1.xp;
  await playMission(page, 2);
  const S2 = await state(page);
  ok(S2.missions[2].stars === 3 && S2.xp > xpBeforeReplay && S2.xp - xpBeforeReplay < 160, 'replay XP looks wrong: +' + (S2.xp - xpBeforeReplay));
  console.log('  replay of mission 2 earned +' + (S2.xp - xpBeforeReplay) + ' XP');
  await page.click('.result [data-act="home"]');

  // Exam: answer 12 correctly, skip 3
  await page.click('[data-act="exam-intro"]');
  await page.waitForSelector('.rules');
  await page.click('[data-act="exam-start"]');
  await page.waitForSelector('#exam-timer');
  await shot(page, 'exam');
  const t0 = await page.textContent('#exam-timer');
  ok(/(20:00|19:5\d)/.test(t0), 'timer does not start at 20:00 (' + t0 + ')');
  for (let i = 0; i < 15; i++) {
    if (i < 12) await answer(page, true);
    if (i === 3) await page.click('[data-act="ex-flag"]');
    if (i < 14) await page.click('[data-act="ex-next"]');
  }
  // persistence mid-exam
  await page.reload();
  await page.waitForSelector('.spine');
  await page.click('[data-act="exam-resume"]');
  await page.waitForSelector('#exam-timer');
  const answered = await page.evaluate(() => document.querySelectorAll('.palette button.ans').length);
  ok(answered === 12, 'exam answers not restored after reload: ' + answered);
  ok(await page.$('.palette button.flag'), 'flag not restored');
  await page.click('.topbar [data-act="ex-submit"]');
  await page.waitForSelector('[data-act="confirm-yes"]');
  const confirmText = await page.textContent('.modal');
  ok(/3 questions are not answered/.test(confirmText), 'submit dialog does not warn about unanswered questions');
  await page.click('[data-act="confirm-yes"]');
  await page.waitForSelector('.ring');
  const S3 = await state(page);
  ok(S3.exam.last.score === 80, 'exam score should be 80, got ' + S3.exam.last.score);
  ok(S3.badges.escapee && !S3.badges['exam-ace'], 'exam badges wrong');
  const reviewCount = await page.evaluate(() => document.querySelectorAll('.review details').length);
  ok(reviewCount === 15, 'review should list 15 questions, got ' + reviewCount);
  await shot(page, 'exam-result');
  // Timer expiry auto-submits
  await page.click('.result [data-act="exam-intro"]');
  await page.click('[data-act="exam-start"]');
  await page.waitForSelector('#exam-timer');
  await answer(page, true);
  await page.evaluate(() => { window.PQ.S.exam.cur.end = Date.now() + 1200; });
  await page.waitForSelector('.ring', { timeout: 5000 });
  const S4 = await state(page);
  ok(S4.exam.last.auto === true && S4.exam.last.correct >= 1 && S4.exam.attempts === 2, 'timer expiry did not auto-submit correctly');
  ok(S4.exam.best === 80, 'best score should stay 80');
  // Report
  await page.click('.result [data-act="report"]');
  await page.waitForSelector('.bars');
  await shot(page, 'report');
  const rep = await page.textContent('.brief');
  ok(/Strengths/.test(rep) && /Common slip-ups/.test(rep), 'report sections missing');
  // Code lab with input
  await page.click('[data-act="home"]');
  await page.click('.hero [data-act="lab"]');
  await page.waitForSelector('#lab-code');
  await page.selectOption('#lab-ex', '2');
  await page.click('[data-act="lab-run"]');
  await page.waitForSelector('#lab-input');
  await page.fill('#lab-input', '82');
  await page.press('#lab-input', 'Enter');
  await page.waitForFunction(() => /Silver Medal/.test(document.getElementById('lab-term').textContent));
  await page.click('[data-act="lab-trace"]');
  await page.waitForSelector('.trace-grid');
  for (let i = 0; i < 4; i++) await page.click('[data-act="tr-next"]');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('#modal-root .overlay')).opacity === '1'), 'trace modal not fully visible after stepping');
  await shot(page, 'trace');
  await page.keyboard.press('Escape');
  // own code with an error
  await page.fill('#lab-code', 'score = 50\nprint(Score)');
  await page.click('[data-act="lab-run"]');
  await page.waitForFunction(() => /NameError/.test(document.getElementById('lab-term').textContent));
  await shot(page, 'lab');
  // Settings + reset
  await page.click('[data-act="settings"]');
  await page.click('[data-act="reset"]');
  await page.click('[data-act="confirm-yes"]');
  await page.waitForSelector('#agent-name');
  const S5 = await state(page);
  ok(S5.xp === 0 && !S5.missions[1].done, 'reset did not clear progress');
  await page.close();
}

/* ===== Mobile layout ===== */
{
  console.log('Mobile layout (390 × 844)');
  const page = await newPage({ width: 390, height: 844 });
  await noHScroll(page, 'intro');
  await page.click('[data-form="intro"] button[type="submit"]');
  await page.waitForSelector('.spine');
  await noHScroll(page, 'map');
  await shot(page, 'm-map');
  await page.evaluate(() => { window.PQ.A['toggle-teacher'](); });
  for (const n of [1, 2, 3, 4, 5]) {
    await page.click(`[data-act="start"][data-m="${n}"]`);
    await page.waitForSelector('.brief');
    await page.click('[data-act="lrun"]');
    await noHScroll(page, 'brief m' + n);
    if (n === 4) await shot(page, 'm-brief');
    await page.click('.topbar [data-act="brief-skip"]');
    for (let k = 0; k < 8; k++) {
      await page.waitForSelector('.qcard');
      await noHScroll(page, `m${n} q${k} (question)`);
      await answer(page, k % 3 !== 1);
      await page.click('[data-act="check"]');
      await noHScroll(page, `m${n} q${k} (feedback)`);
      if (n === 5 && k === 1) await shot(page, 'm-feedback');
      let rs = await runState(page);
      if (rs.stage === 'main-wrong') { await page.click('[data-act="next"]'); await answer(page, true); await page.click('[data-act="check"]'); }
      rs = await runState(page);
      if (rs.stage === 'follow') { await answer(page, true); await page.click('[data-act="check"]'); await noHScroll(page, `m${n} q${k} (follow)`); }
      await page.click('[data-act="next"]');
    }
    await page.waitForSelector('.result');
    await noHScroll(page, 'result m' + n);
    await page.click('.result [data-act="home"]');
  }
  await page.click('[data-act="exam-intro"]');
  await page.click('[data-act="exam-start"]');
  await page.waitForSelector('#exam-timer');
  await noHScroll(page, 'exam');
  await shot(page, 'm-exam');
  for (let i = 0; i < 15; i++) { await answer(page, i % 2 === 0); await noHScroll(page, 'exam q' + i); if (i < 14) await page.click('[data-act="ex-next"]'); }
  await page.click('.topbar [data-act="ex-submit"]');
  await page.click('[data-act="confirm-yes"]');
  await page.waitForSelector('.ring');
  await noHScroll(page, 'exam result');
  await page.evaluate(() => document.querySelectorAll('.review details').forEach(d => { d.open = true; }));
  await noHScroll(page, 'exam review');
  await page.click('.result [data-act="report"]');
  await noHScroll(page, 'report');
  await page.click('[data-act="home"]');
  await page.click('.hero [data-act="lab"]');
  await page.click('[data-act="lab-run"]');
  await noHScroll(page, 'lab');
  await page.fill('#lab-input', 'Sam'); await page.press('#lab-input', 'Enter');
  await page.click('[data-act="lab-trace"]');
  await noHScroll(page, 'trace modal');
  await shot(page, 'm-trace');
  await page.close();
}
await browser.close();
if (problems.length) { console.log('\nUI PROBLEMS (' + problems.length + '):'); [...new Set(problems)].forEach(p => console.log('  - ' + p)); process.exit(1); }
console.log('\nUI test passed.');
