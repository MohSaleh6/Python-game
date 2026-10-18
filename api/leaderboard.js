// Python Quest leaderboard API (Vercel serverless function + Neon Postgres).
//   GET    /api/leaderboard?class=7B&me=<playerId>   → ranked players (top 100) + your own row
//   POST   /api/leaderboard                           → save a player's progress (best values are kept)
//   DELETE /api/leaderboard?id=<playerId>             → teacher only (header x-admin-key)
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const ID_RE = /^[a-z0-9-]{16,48}$/;
const NAME_RE = /^[\p{L}\p{N} .'-]{1,20}$/u;
const CLASS_RE = /^[A-Z0-9-]{0,12}$/;
const BLOCKED = ['fuck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'nigg', 'fag', 'whore', 'slut', 'porn', 'rape', 'nazi', 'hitler', 'retard', 'penis', 'vagina', 'asshole', 'bastard', 'wank'];

const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const cleanName = s => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const cleanClass = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '');

function validate(b) {
  if (!b || typeof b !== 'object') return 'Invalid request.';
  if (!ID_RE.test(String(b.id || ''))) return 'Invalid player id.';
  const name = cleanName(b.name);
  if (!NAME_RE.test(name)) return 'Names can use 1–20 letters, numbers, spaces, dots, hyphens or apostrophes.';
  const flat = name.toLowerCase().replace(/[^a-z]/g, '');
  if (BLOCKED.some(w => flat.includes(w))) return 'Please choose a different name.';
  const cls = cleanClass(b.classCode);
  if (!CLASS_RE.test(cls)) return 'Class codes can use up to 12 letters, numbers or hyphens.';
  const mastery = int(b.mastery, 0, 100), missionsDone = int(b.missionsDone, 0, 5), stars = int(b.stars, 0, 15);
  const xp = int(b.xp, 0, 50000), badges = int(b.badges, 0, 10);
  const bestExam = b.bestExam == null ? null : int(b.bestExam, 0, 100);
  if ([mastery, missionsDone, stars, xp, badges].includes(null) || (b.bestExam != null && bestExam == null)) return 'Invalid scores.';
  if (stars > missionsDone * 3 || stars < missionsDone) return 'Invalid scores.';
  if (bestExam != null && missionsDone < 5) return 'Invalid scores.';
  const questScore = bestExam == null ? null : Math.round(mastery / 2 + bestExam / 2);
  return { id: b.id, name, cls, mastery, missionsDone, stars, xp, badges, bestExam, questScore };
}

const ORDER = 'quest_score DESC NULLS LAST, best_exam DESC NULLS LAST, mastery DESC, stars DESC, xp DESC, created_at ASC';

async function list(cls, me) {
  const rows = await sql.query(
    `WITH ranked AS (
       SELECT id, name, class_code, quest_score, best_exam, mastery, missions_done, stars, xp, badges, created_at, updated_at,
              RANK() OVER (ORDER BY ${ORDER}) AS rank
       FROM players WHERE ($1 = '' OR class_code = $1))
     SELECT * FROM ranked WHERE rank <= 100 OR id = $2 ORDER BY rank, created_at LIMIT 101`,
    [cls, me || '']
  );
  const [{ count }] = await sql.query('SELECT count(*)::int AS count FROM players WHERE ($1 = \'\' OR class_code = $1)', [cls]);
  const classes = await sql.query('SELECT class_code, count(*)::int AS n FROM players WHERE class_code <> \'\' GROUP BY class_code ORDER BY class_code LIMIT 60');
  const pub = r => ({ me: r.id === me, name: r.name, classCode: r.class_code, questScore: r.quest_score, bestExam: r.best_exam, mastery: r.mastery,
    missionsDone: r.missions_done, stars: r.stars, xp: r.xp, badges: r.badges, rank: Number(r.rank), updatedAt: r.updated_at });
  return { players: rows.map(pub), total: count, classes: classes.map(c => ({ code: c.class_code, players: c.n })), _ids: rows.map(r => r.id) };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'The leaderboard database is not configured.' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET') {
      const cls = cleanClass(url.searchParams.get('class'));
      const me = url.searchParams.get('me') || '';
      if (!CLASS_RE.test(cls)) return res.status(400).json({ error: 'Invalid class code.' });
      const out = await list(cls, ID_RE.test(me) ? me : '');
      const isAdmin = !!process.env.ADMIN_KEY && req.headers['x-admin-key'] === process.env.ADMIN_KEY;
      if (isAdmin) out.players.forEach((p, i) => { p.id = out._ids[i]; });
      delete out._ids;
      return res.status(200).json(out);
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
      const v = validate(body);
      if (typeof v === 'string') return res.status(400).json({ error: v });
      await sql.query(
        `INSERT INTO players (id, name, class_code, quest_score, best_exam, mastery, missions_done, stars, xp, badges)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, class_code = EXCLUDED.class_code,
           best_exam = GREATEST(players.best_exam, EXCLUDED.best_exam),
           mastery = GREATEST(players.mastery, EXCLUDED.mastery),
           quest_score = CASE WHEN GREATEST(players.best_exam, EXCLUDED.best_exam) IS NULL THEN NULL
                              ELSE ROUND(GREATEST(players.mastery, EXCLUDED.mastery) / 2.0 + GREATEST(players.best_exam, EXCLUDED.best_exam) / 2.0) END,
           missions_done = GREATEST(players.missions_done, EXCLUDED.missions_done),
           stars = GREATEST(players.stars, EXCLUDED.stars),
           xp = GREATEST(players.xp, EXCLUDED.xp),
           badges = GREATEST(players.badges, EXCLUDED.badges),
           updated_at = now()`,
        [v.id, v.name, v.cls, v.questScore, v.bestExam, v.mastery, v.missionsDone, v.stars, v.xp, v.badges]
      );
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'DELETE') {
      if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'The teacher key is not correct.' });
      const id = url.searchParams.get('id') || '';
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid player id.' });
      await sql.query('DELETE FROM players WHERE id = $1', [id]);
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'The leaderboard is unavailable right now.' });
  }
}
