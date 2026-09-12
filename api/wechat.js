/**
 * 微信公众号「服务器配置」接口 — Codex 额度重置查询
 *
 * 作用：用户在公众号里发任意消息（或点菜单「Codex 重置了吗」）
 *       → 微信服务器 POST 到这里 → 返回中英双语状态
 *
 * 微信要求：5 秒内响应、GET 做签名校验、返回 XML
 *
 * 环境变量（Vercel 后台配）：
 *   WECHAT_TOKEN       必填  与公众号后台「服务器配置」里填的 Token 一致
 *   STATUS_URL         选填  预计算好的 status.json 公网地址（有则秒回，强烈推荐）
 *   DEEPSEEK_API_KEY   选填  没配 STATUS_URL 时用它现场判定
 *   HANDLE             选填  监控对象，默认 thsottiaux
 */
const crypto = require('crypto');

const TOKEN = process.env.WECHAT_TOKEN || '';
const STATUS_URL = process.env.STATUS_URL || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const HANDLE = process.env.HANDLE || 'thsottiaux';
const SOURCE = `https://xcancel.com/${HANDLE}`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 进程内缓存：同一实例 2 分钟内不再重复抓取（避开微信 5s 限制）
let CACHE = { at: 0, data: null };
const CACHE_TTL = 120 * 1000;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function checkSignature(q) {
  const signature = q.signature || '';
  const timestamp = q.timestamp || '';
  const nonce = q.nonce || '';
  if (!signature || !timestamp || !nonce) return false;
  const expect = sha1([TOKEN, timestamp, nonce].sort().join(''));
  return expect === signature;
}

async function fetchText(url, timeout = 9000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctl.signal,
    });
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function unescapeHtml(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从 xcancel(Nitter) HTML 里取最近推文 */
function parseTweets(doc, limit = 3) {
  const out = [];
  const re =
    /<div class="timeline-item[^"]*"([\s\S]*?)(?=<div class="timeline-item|<\/div>\s*<\/div>\s*<div class="show-more)/g;
  let m;
  while ((m = re.exec(doc)) && out.length < limit) {
    const block = m[1];
    const c = /<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const d = /<span class="tweet-date"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*title="([^"]+)"/.exec(block);
    if (!c) continue;
    const text = unescapeHtml(c[1]);
    if (!text) continue;
    const href = d ? d[1].split('#')[0] : '';
    out.push({
      id: href ? href.split('/').pop() : String(text.length),
      text,
      date: d ? d[2] : '',
      link: href ? 'https://x.com' + href : '',
    });
  }
  return out;
}

/** 一次 LLM 调用判定多条推文（省时间，避开微信 5s 限制） */
async function classifyTweets(tweets) {
  if (!DEEPSEEK_API_KEY) return { index: -1, zh: '', reason: '未配置 DEEPSEEK_API_KEY' };
  const sys = [
    'You are given several recent tweets (numbered from 0, newest first) from the OpenAI Codex lead.',
    'Find the NEWEST tweet that announces a RESET of OpenAI Codex / ChatGPT usage limits or quota',
    '(limits/quotas/credits reset, refilled, refreshed, restored or given back).',
    'NOT a reset: password resets, device/config resets, product launches, policy changes, model',
    'retirements, hiring, puns, or anything not about granting users more quota. Be strict.',
    'Reply with ONLY JSON: {"index": <0-based index of the newest reset tweet, or -1 if none>,',
    '"reason":"<一句话中文理由>","zh":"<命中那条推文的中文翻译；若 index=-1 则翻译 [0] 那条。专有名词保留英文>"}',
  ].join(' ');
  const user = tweets.map((t, i) => `[${i}] ${t.text}`).join('\n\n');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + DEEPSEEK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        thinking: { type: 'disabled' },
        temperature: 0,
        max_tokens: 700,
      }),
      signal: ctl.signal,
    });
    const d = await r.json();
    const raw = (d.choices && d.choices[0] && d.choices[0].message.content) || '';
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { index: -1, zh: '', reason: raw.slice(0, 120) };
  } catch (e) {
    return { index: -1, zh: '', reason: '判定失败: ' + String(e).slice(0, 100) };
  } finally {
    clearTimeout(t);
  }
}

/** DeepSeek 判定 + 中文翻译（单条，保留给其它调用方） */
async function classify(text) {
  const v = await classifyTweets([{ text }]);
  return { is_reset: v.index === 0, zh: v.zh, reason: v.reason };
}

/** 拿到状态：优先预计算 JSON（快），否则现场判定（慢但可用） */
async function getStatus() {
  const now = Date.now();
  if (CACHE.data && now - CACHE.at < CACHE_TTL) return { ...CACHE.data, cached: true };

  // ① 优先：预计算好的 status.json
  if (STATUS_URL) {
    try {
      const txt = await fetchText(STATUS_URL, 4000);
      const j = JSON.parse(txt);
      if (j && j.last_reset !== undefined) {
        CACHE = { at: now, data: j };
        return { ...j, cached: false };
      }
    } catch (_) {}
  }

  // ② 兜底：现场抓最新几条推文判定（找最近一次真正的重置，而不是只看最新那条）
  const doc = await fetchText(SOURCE, 8000);
  const tweets = parseTweets(doc, 3);
  if (!tweets.length) throw new Error('未能解析推文');
  const v = await classifyTweets(tweets);          // 一次调用判定全部（省时）
  const idx = Number.isInteger(v.index) && v.index >= 0 && v.index < tweets.length ? v.index : -1;
  const isReset = idx >= 0;
  const picked = tweets[isReset ? idx : 0];
  const data = {
    ok: true,
    updated_at: new Date().toISOString(),
    reset_today: isReset,
    last_reset: {
      text: picked.text.slice(0, 400),
      zh: v.zh || '',
      reason: v.reason || '',
      date: picked.date,
      link: picked.link,
      ts: Date.now() / 1000,
    },
    live: true,
  };
  CACHE = { at: now, data };
  return { ...data, cached: false };
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}

/** 组装中英双语回复 */
function buildReply(st) {
  const lr = st.last_reset || {};
  const en = (lr.text || '').slice(0, 180);
  const zh = (lr.zh || lr.reason || '').slice(0, 260);
  const lines = [];
  lines.push('📊 Codex 额度状态 / Codex Quota Status');
  lines.push('———————————');
  if (st.reset_today) {
    lines.push('✅ 最近 24 小时内重置过 / RESET within 24h');
  } else {
    lines.push('❌ 最近 24 小时没重置 / No reset in 24h');
  }
  if (lr.date) lines.push('🕐 ' + lr.date + (lr.ts ? '（' + ago(lr.ts) + '）' : ''));
  if (zh) lines.push('🇨🇳 ' + zh);
  if (en) lines.push('🇬🇧 ' + en);
  if (lr.link) lines.push('🔗 ' + lr.link);
  lines.push('———————————');
  lines.push('👀 盯的是 @' + HANDLE + '（OpenAI Codex 负责人）');
  if (st.live) lines.push('⚠️ 实时查询（可能略有延迟）');
  return lines.join('\n');
}

function xmlReply(to, from, content) {
  return `<xml>
<ToUserName><![CDATA[${to}]]></ToUserName>
<FromUserName><![CDATA[${from}]]></FromUserName>
<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
}

/** 读原始 body —— 微信发的是 text/xml，Vercel 默认不解析，必须自己读流 */
async function readRawBody(req) {
  if (typeof req.body === 'string' && req.body.length) return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') {
    if (req.body.xml && typeof req.body.xml === 'string') return req.body.xml;
    if (Object.keys(req.body).length) return JSON.stringify(req.body);
  }
  if (!req.on) return '';
  // 从流里读（加超时防止 body 已被消费时卡死）
  return await new Promise((resolve) => {
    let d = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(d); } };
    const timer = setTimeout(finish, 3000);
    req.on('data', (c) => { d += c; });
    req.on('end', () => { clearTimeout(timer); finish(); });
    req.on('error', () => { clearTimeout(timer); finish(); });
  });
}

module.exports = async (req, res) => {
  // ① 微信服务器配置校验（一次性）
  if (req.method === 'GET') {
    const q = req.query || {};
    if (!TOKEN) return res.status(500).send('WECHAT_TOKEN not configured');
    if (checkSignature(q)) return res.status(200).send(q.echostr || '');
    return res.status(401).send('invalid signature');
  }

  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  // ② 用户在公众号发消息 -> 回状态
  const body = await readRawBody(req);
  const g = (tag) => {
    const m = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(body);
    return m ? m[1] : '';
  };
  const fromUser = g('FromUserName');  // 用户 openid
  const toAccount = g('ToUserName');   // 公众号

  let content;
  try {
    const st = await getStatus();
    content = buildReply(st);
  } catch (e) {
    content =
      '😵 查询失败，请稍后再试\n\nQuery failed, please retry.\n\n(err: ' +
      String(e).slice(0, 80) +
      ')';
  }
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  return res.status(200).send(xmlReply(fromUser, toAccount, content));
};

// 关键：关掉 Vercel 的 body 解析，保证我们能读到微信的原始 XML
module.exports.config = { api: { bodyParser: false } };
