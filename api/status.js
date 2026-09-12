/**
 * GET /api/status           -> 当前 Codex 重置状态 JSON（给别的渠道复用 / 自测）
 * GET /api/status?probe=1   -> 探测各数据源在【函数内部】的真实耗时（用于选最优数据源）
 */
const STATUS_URL = process.env.STATUS_URL || '';
const HANDLE = process.env.HANDLE || 'thsottiaux';
const REPO_RAW =
  'https://raw.githubusercontent.com/yandong2023/codex-reset-bot/master/public/status.json';

async function timed(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const t = await r.text();
    return { ms: Date.now() - t0, ok: r.ok, bytes: t.length, head: t.slice(0, 80) };
  } catch (e) {
    return { ms: Date.now() - t0, error: String(e).slice(0, 140) };
  }
}

module.exports = async (req, res) => {
  const q = req.query || {};

  if (q.probe === '1') {
    const out = { region: process.env.VERCEL_REGION || '?' };
    out.self_static = await timed('https://codex-reset-bot.vercel.app/status.json');
    out.raw_github = await timed(REPO_RAW);
    out.configured_STATUS_URL = STATUS_URL;
    out.configured_ms = STATUS_URL ? (await timed(STATUS_URL)).ms : null;
    return res.status(200).json(out);
  }

  const out = { handle: '@' + HANDLE, source: `https://xcancel.com/${HANDLE}` };
  if (!STATUS_URL) {
    out.ok = false;
    out.error = 'STATUS_URL 未配置';
    return res.status(200).json(out);
  }
  try {
    const t0 = Date.now();
    const r = await fetch(STATUS_URL, { cache: 'no-store' });
    const j = await r.json();
    return res.status(200).json({ ok: true, fetch_ms: Date.now() - t0, ...j });
  } catch (e) {
    out.ok = false;
    out.error = String(e).slice(0, 200);
    return res.status(200).json(out);
  }
};
