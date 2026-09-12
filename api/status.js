/**
 * GET /api/status  ->  返回当前 Codex 重置状态 JSON（方便自测 / 给别的渠道复用）
 * 环境变量同 api/wechat.js（只需 WECHAT_TOKEN 可不配）
 */
const STATUS_URL = process.env.STATUS_URL || '';
const HANDLE = process.env.HANDLE || 'thsottiaux';

module.exports = async (req, res) => {
  const out = { handle: '@' + HANDLE, source: `https://xcancel.com/${HANDLE}` };
  if (!STATUS_URL) {
    out.ok = false;
    out.error = 'STATUS_URL 未配置';
    return res.status(200).json(out);
  }
  try {
    const r = await fetch(STATUS_URL, { cache: 'no-store' });
    const j = await r.json();
    return res.status(200).json({ ok: true, ...j });
  } catch (e) {
    out.ok = false;
    out.error = String(e).slice(0, 200);
    return res.status(200).json(out);
  }
};
