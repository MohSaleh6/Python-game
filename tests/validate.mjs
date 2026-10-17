// Validates the Python Quest question bank and interpreter.
//   node tests/validate.mjs
// 1. Structural checks on every mission / exam question and every generator.
// 2. Differential test: every program the game runs is also run with real Python 3,
//    and stdout + error type + error line must match.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const core = /<script id="pq-core">([\s\S]*?)<\/script>/.exec(html)[1];
const ctx = {};
vm.createContext(ctx);
vm.runInContext(core + '\n;globalThis.__x = { PyLite, Core, BANK, EXAM, GEN, LESSONS, MISSIONS, MISSION_GENS, TAGS };', ctx);
const { PyLite, Core, BANK, EXAM, GEN, LESSONS, MISSIONS, MISSION_GENS, TAGS } = ctx.__x;

const errors = [], warnings = [], cases = [];
const fail = (id, msg) => errors.push(id + ': ' + msg);
const warn = (id, msg) => warnings.push(id + ': ' + msg);
const addCase = (id, code, inputs) => { cases.push({ id, code, inputs: (inputs || []).map(String) }); };
const SYNTAX = ['SyntaxError', 'IndentationError'];

function checkBuilt(B, ctxName) {
  const id = ctxName + ' ' + (B.id || '?');
  const def = B.def;
  if (B.code) addCase(id, B.code, B.inputs);
  if (B.result && B.result.error && !def.prefixOpts && !def.bug && !def.allowErr && !def.ansErr && B.type !== 'line') fail(id, 'program errors: ' + B.result.error.text);
  switch (B.type) {
    case 'mcq': {
      if (B.opts.length < 3) fail(id, 'fewer than 3 options');
      const texts = B.opts.map(o => o.text);
      if (new Set(texts).size !== texts.length) fail(id, 'duplicate options: ' + JSON.stringify(texts));
      if (B.opts.filter(o => o.correct).length !== 1) fail(id, 'must have exactly one correct option');
      if (def.run && B.result.error) fail(id, 'computed answer is an error');
      if (ctxName !== 'exam') B.opts.forEach(o => { if (!o.correct && !o.why) fail(id, 'wrong option without explanation: ' + o.text); });
      if (def.codeCheck) {
        B.opts.forEach(o => {
          const code = (def.pre ? def.pre + '\n' : '') + o.text, r = PyLite.run(code, B.inputs);
          addCase(id + ' opt', code, B.inputs);
          if (o.correct && !def.ansErr && r.error) fail(id, 'correct option errors: ' + r.error.text);
          if (o.correct && def.ansErr && !r.error) fail(id, 'correct option should error');
          if (!o.correct && !def.ansErr && !r.error && o.flag !== 'runs') fail(id, 'wrong option runs without error: ' + o.text);
          if (!o.correct && def.ansErr && r.error) fail(id, 'a "correct structure" option errors: ' + o.text);
        });
      }
      if (def.prefixOpts) {
        B.opts.forEach(o => {
          const code = o.text + '\n' + B.code, r = PyLite.run(code, []);
          addCase(id + ' prefix', code, []);
          const shows = Core.outOf(r, 'printed') === def.want;
          if (o.correct !== shows) fail(id, 'prefix option ' + o.text + ' gives ' + JSON.stringify(r.printed));
        });
      }
      break;
    }
    case 'type':
      if (!B.expected) fail(id, 'empty expected output');
      break;
    case 'fill': {
      if (B.result.error) fail(id, 'canonical fill errors: ' + B.result.error.text);
      B.blanks.forEach((b, i) => { if (!B.bank.includes(b)) fail(id, 'blank answer missing from bank: ' + b); });
      const canon = Core.outOf(B.result, 'printed');
      B.blanks.forEach((b, i) => B.bank.forEach(t => {
        if (t === b || (B.alts[i] || []).includes(t)) return;
        const sel = B.blanks.slice(); sel[i] = t;
        const code = Core.fillCode(B, sel), r = PyLite.run(code, B.inputs);
        addCase(id + ' fill-variant', code, B.inputs);
        if (!r.error && Core.outOf(r, 'printed') === canon) warn(id, 'another chip also works at gap ' + i + ': ' + t);
      }));
      break;
    }
    case 'line': {
      if (!B.lineAns.length) fail(id, 'no answer line');
      B.lineAns.forEach(i => { if (i < 0 || i >= B.lines.length) fail(id, 'answer line out of range'); });
      if (def.bug && !def.logic) {
        if (!B.result.error) fail(id, 'bug question code runs without error');
        else if (!B.lineAns.includes(B.result.error.line - 1)) fail(id, 'Python reports line ' + B.result.error.line + ' but answer is ' + B.lineAns.map(x => x + 1));
      }
      if (def.ans === 'print' && B.lineAns.length !== 1) fail(id, 'expected exactly one printed line');
      break;
    }
    case 'order': {
      if (B.expect.some(r => r.error)) fail(id, 'canonical order errors');
      if (B.perm.every((v, i) => B.ordLines[v] === B.ordLines[i])) fail(id, 'shuffled order equals the answer');
      B.tests.forEach(t => addCase(id + ' order', B.code, t));
      break;
    }
    case 'chain': {
      if (!Core.grade(B, B.def.br.map((_, i) => i)).ok) fail(id, 'canonical chain fails its own tests');
      if (Core.grade(B, B.perm).ok) fail(id, 'starting order already passes');
      if (new Set(B.expect).size < B.br.length) warn(id, 'tests do not cover every branch');
      B.tests.forEach(t => addCase(id + ' chain', B.code, t));
      break;
    }
    case 'table':
      B.rows.forEach(r => { if (!B.choices.includes(r.ans)) fail(id, 'row answer not in choices: ' + r.ans); addCase(id + ' table', B.code, r.inputs); });
      if (B.choices.length < 2) fail(id, 'fewer than 2 choices');
      break;
    case 'match': {
      const vals = Object.values(B.ansMap);
      if (new Set(vals).size !== vals.length) fail(id, 'match values are not unique: ' + JSON.stringify(vals));
      if (B.left.length < 2) fail(id, 'fewer than 2 pairs');
      break;
    }
  }
  // grading: the right answer passes, an obviously wrong one fails
  const right = correctSel(B), wrong = wrongSel(B);
  if (!Core.answered(B, right)) fail(id, 'correct selection does not count as answered');
  else if (!Core.grade(B, right).ok) fail(id, 'grading the correct answer fails');
  if (wrong != null && Core.answered(B, wrong) && Core.grade(B, wrong).ok) fail(id, 'grading a wrong answer passes');
  if (B.follow) {
    const f = B.follow;
    if (f.opts.length < 3) fail(id, 'follow-up has fewer than 3 options');
    f.opts.forEach((o, i) => { if (i !== f.ans && !o[1]) fail(id, 'follow-up wrong option without explanation: ' + o[0]); });
    const F = Core.buildFollow(B, 7);
    if (!Core.grade(F, F.ans).ok) fail(id, 'follow-up correct answer fails');
    if (f.replace) {
      const code = Core.patched(F, F.ans), r = PyLite.run(code, B.inputs);
      addCase(id + ' fix', code, B.inputs);
      if (r.error) fail(id, 'the correct fix still errors: ' + r.error.text);
      F.opts.forEach((o, i) => { if (i !== F.ans) addCase(id + ' fix-wrong', Core.patched(F, i), B.inputs); });
    }
  }
}
function correctSel(B) {
  switch (B.type) {
    case 'mcq': return B.ans;
    case 'line': return B.lineAns[0];
    case 'type': return B.expected;
    case 'fill': return B.blanks.slice();
    case 'order': return B.ordLines.map((_, i) => i);
    case 'chain': return B.def.br.map((_, i) => i);
    case 'table': return B.rows.map(r => B.choices.indexOf(r.ans));
    case 'match': { const s = {}; B.left.forEach((n, i) => { s[i] = B.right.indexOf(B.ansMap[n]); }); return s; }
  }
}
function wrongSel(B) {
  switch (B.type) {
    case 'mcq': return (B.ans + 1) % B.opts.length;
    case 'line': { for (let i = 0; i < B.lines.length; i++) if (!B.lineAns.includes(i)) return i; return null; }
    case 'type': return B.expected + ' x';
    case 'fill': { const s = B.blanks.slice(); s[0] = B.bank.find(t => t !== B.blanks[0] && !(B.alts[0] || []).includes(t)); return s; }
    case 'order': return null;
    case 'chain': return B.perm;
    case 'table': { const s = correctSel(B); s[0] = (s[0] + 1) % B.choices.length; return s; }
    case 'match': { const s = correctSel(B); const t = s[0]; s[0] = s[1]; s[1] = t; return s; }
  }
}

// ---- mission bank ----
const ids = new Set();
for (const q of [...BANK, ...EXAM]) { if (ids.has(q.id)) fail(q.id, 'duplicate id'); ids.add(q.id); }
for (const q of BANK) {
  for (const t of q.tags || []) if (!TAGS[t]) fail(q.id, 'unknown tag ' + t);
  if (!q.exp) fail(q.id, 'missing explanation');
  if (!q.hint) warn(q.id, 'no hint');
  for (const seed of [1, 2, 3, 99, 12345]) checkBuilt(Core.build(q, seed), 'bank');
}
for (const m of MISSIONS) {
  const pool = BANK.filter(q => q.m === m.n);
  const byD = [1, 2, 3].map(d => pool.filter(q => q.d === d).length);
  if (byD[0] < 3 || byD[1] < 3 || byD[2] < 2) fail('mission ' + m.n, 'not enough questions per difficulty ' + byD);
  console.log('Mission ' + m.n + ': ' + pool.length + ' questions (easy/medium/hard ' + byD.join('/') + ')');
  let seen = {};
  for (let k = 0; k < 40; k++) {
    const rng = Core.mulberry32(k + 1), picked = Core.pickMission(m.n, seen, rng);
    if (picked.length !== 8 || new Set(picked.map(q => q.id)).size !== 8) fail('mission ' + m.n, 'pick is not 8 unique questions');
    for (let i = 1; i < 8; i++) if (picked[i].d < picked[i - 1].d) fail('mission ' + m.n, 'difficulty not ascending');
    picked.forEach(q => { seen[q.id] = k + 1; });
  }
  // replay variety: two consecutive runs should share few questions
  seen = {};
  const a = Core.pickMission(m.n, seen, Math.random); a.forEach(q => { seen[q.id] = 1; });
  const b = Core.pickMission(m.n, seen, Math.random);
  const overlap = b.filter(q => a.includes(q)).length;
  if (overlap > 2) warn('mission ' + m.n, 'second run repeats ' + overlap + ' questions');
  for (const q of pool) {
    const used = new Set([q.id]);
    for (let k = 0; k < 6; k++) {
      const B = Core.build(q, k + 1), def = Core.similar(B, used, Core.mulberry32(k + 7));
      if (!def) { fail(q.id, 'no similar question'); break; }
      if (def.id === q.id) fail(q.id, 'similar returned the same question');
      if (def.m !== q.m) fail(q.id, 'similar question from another mission');
      checkBuilt(Core.build(def, k + 3), 'similar');
    }
  }
}
// ---- generators ----
for (const [skill, g] of Object.entries(GEN)) {
  for (let k = 0; k < 250; k++) {
    const def = Core.genDef(skill, Core.mulberry32(k * 31 + 5));
    checkBuilt(Core.build(def, k + 1), 'gen ' + skill + '#' + k);
  }
}
for (const [m, list] of Object.entries(MISSION_GENS)) for (const s of list) if (!GEN[s]) fail('gens', 'unknown generator ' + s);
// ---- exam ----
for (const q of EXAM) { if (!q.exp) fail(q.id, 'missing explanation'); for (const seed of [1, 2, 3]) checkBuilt(Core.build(q, seed), 'exam'); }
for (let k = 0; k < 30; k++) {
  const picked = Core.pickExam({}, Core.mulberry32(k + 1));
  if (picked.length !== 15) fail('exam', 'not 15 questions');
  for (const m of [1, 2, 3, 4, 5]) if (picked.filter(q => q.m === m).length !== 3) fail('exam', 'topic ' + m + ' does not have 3 questions');
  for (let i = 1; i < 15; i++) if (picked[i].d < picked[i - 1].d) fail('exam', 'difficulty not ascending');
}
// ---- lessons ----
for (const [m, list] of Object.entries(LESSONS)) list.forEach((Ls, i) => {
  const vals = Ls.vary || [null];
  for (const v of vals) {
    const code = Ls.vary ? Ls.code.split('{v}').join(String(v)) : Ls.code;
    const r = PyLite.run(code, Ls.ask || []);
    addCase('lesson ' + m + '.' + i, code, Ls.ask || []);
    if (!!r.error !== !!Ls.broken) fail('lesson ' + m + '.' + i, Ls.broken ? 'broken example does not error' : 'example errors: ' + r.error.text);
  }
});

// ---- interpreter edge cases ----
const EXTRA = [
  ['print("a", "b", sep="-")', []], ['print("a", end="")\nprint("b")', []], ['x = 7\nprint(x / 2, x // 2, x % 3, -7 // 2, -7 % 3)', []],
  ['print(2 ** 10, 2 ** -1, 10 / 4, 4 / 2, 0.1 + 0.2)', []], ['print(int("  42 "), float("3.5"), str(12) + "!")', []], ['print(int("abc"))', []],
  ['print("ab" * 3, 3 * "x", "" * 4)', []], ['print("5" + 5)', []], ['print(5 + "5")', []], ['print(len("hello"), round(2.5), round(3.5), round(2.675, 2), round(0.125, 2), round(-0.375, 2), round(7.25, 1))', []],
  ['print(True + 1, True == 1, 5 == 5.0, "5" == 5)', []], ['x = 5\nif x > 3 and x < 10:\n    print("mid")', []], ['x = 0\nif not x:\n    print("zero")', []],
  ['print(1 < 2 < 3, 3 > 2 > 2)', []], ['name = "ada"\nprint(name.upper(), name.title(), "  hi ".strip())', []], ['print(type(5), type("a"), type(2.0), type(True))', []],
  ['score = 10\nscore += 5\nscore -= 2\nscore *= 3\nprint(score)', []], ['x = 10\nx /= 4\nprint(x)', []], ['n = int(input())\nprint(n * 2)', ['21']], ['a = input("A? ")\nb = input("B? ")\nprint(a + b)', ['1', '2']],
  ['print(input("x: "))', []], ['x = 5\nif x > 3: print("big")\nelse: print("small")', []], ['if True:\n    pass\nprint("ok")', []],
  ['if x > 5\n    print(1)', []], ['print("hi"\n', []], ['print("hi)', []], ['  print("x")', []], ['if True:\nprint("x")', []],
  ['if True:\n    print(1)\n  print(2)', []], ['else:\n    print(1)', []], ['x = 5\nif x = 5:\n    print(1)', []], ['print "hello"', []], ['2x = 5', []],
  ['my var = 3', []], ['"a" = 3', []], ['x = 3\nif x > 1:\n    print("a")\nelse if x > 0:\n    print("b")', []], ['x = 3\nif x > 1:\n    print("a")\nelse x > 0:\n    print("b")', []],
  ['print(Score)', []], ['score = 1\nprint(Score)', []], ['print(10 / 0)', []], ['print(max(3, 9, 2), min(3, 9, 2), abs(-4))', []], ['x = "7"\nif x > 5:\n    print(1)', []],
  ['age = 15\nif age >= 18:\n    print("A")\nelif age >= 13:\n    print("T")\nelse:\n    print("C")\nprint("end")', []], ['print(f"Hi {1 + 2} and {\'x\'}")', []],
  ['name = "Leo"\nprint(f"Hello {name}!")', []], ['x = 3.0\nprint(x, x * 2, int(x), float(2))', []], ['print(7 // 2.0, 7 % 2.5, 1e3)', []], ['print(-3 ** 2, (-3) ** 2)', []],
  ['print("it\'s", \'say "hi"\')', []], ['x = 1\nif x == 1:\n    print("one")\nelif x == 1:\n    print("never")', []], ['print()', []], ['print("a" "b")', []],
  ['print("Score:" 10)', []], ['x = print("a")\nprint(x)', []], ['print(int(3.9), int(-3.9), int(True))', []], ['print(bool(0), bool("a"), bool(""))', []],
  ['x = 5\nif x > 3:\n    if x > 4:\n        print("deep")', []], ['x = 5\nif x > 3:\n    print("a")\nelif x > 1:\n    print("b")\nelse:\n    print("c")\nelif x > 0:\n    print("d")', []],
  ['print(3 > "2")', []], ['print(1 +)', []], ['print("a",)', []], ['x = 5 +', []], ['for i in range(3):\n    print(i)', []]
];
EXTRA.forEach(([c, i], k) => addCase('extra ' + k, c, i));

// ---- differential test against CPython ----
const uniq = new Map();
for (const c of cases) { const key = c.code + '\u0000' + c.inputs.join('\u0001'); if (!uniq.has(key)) uniq.set(key, c); }
const list = [...uniq.values()].filter(c => !/^\s*(for|while)\b/m.test(c.code));
const py = JSON.parse(execFileSync('python3', [path.join(here, 'py_diff.py')], { input: JSON.stringify(list), maxBuffer: 1 << 28 }).toString());
let mism = 0, msgDiff = 0;
list.forEach((c, k) => {
  const ours = PyLite.run(c.code, c.inputs), real = py[k];
  const oe = ours.error, re = real.error;
  const problems = [];
  if (ours.stdout !== real.stdout) problems.push('stdout ours=' + JSON.stringify(ours.stdout) + ' python=' + JSON.stringify(real.stdout));
  if (!!oe !== !!re) problems.push('error ours=' + (oe ? oe.text : 'none') + ' python=' + (re ? re.type + ': ' + re.msg : 'none'));
  else if (oe && re) {
    if (oe.type !== re.type) problems.push('error type ours=' + oe.type + ' python=' + re.type);
    if (oe.line !== re.line) problems.push('error line ours=' + oe.line + ' python=' + re.line);
    if (oe.msg !== re.msg) { msgDiff++; warnings.push(c.id + ': message differs: ours="' + oe.msg + '" python="' + re.msg + '"'); }
  }
  if (problems.length) { mism++; errors.push(c.id + ' [differential]\n    code: ' + JSON.stringify(c.code) + ' inputs ' + JSON.stringify(c.inputs) + '\n    ' + problems.join('\n    ')); }
});
console.log('Differential test: ' + list.length + ' programs compared with ' + execFileSync('python3', ['--version']).toString().trim() + ', ' + mism + ' mismatches, ' + msgDiff + ' message wording differences');

if (warnings.length) { console.log('\nWarnings (' + warnings.length + '):'); [...new Set(warnings)].slice(0, 60).forEach(w => console.log('  - ' + w)); }
if (errors.length) { console.log('\nERRORS (' + errors.length + '):'); [...new Set(errors)].slice(0, 80).forEach(e => console.log('  ✗ ' + e)); process.exit(1); }
console.log('\nAll checks passed: ' + BANK.length + ' mission questions, ' + EXAM.length + ' exam questions, ' + Object.keys(GEN).length + ' generators.');
