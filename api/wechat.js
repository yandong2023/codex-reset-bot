/**
 * 微信公众号「服务器配置」接口 — Codex 额度重置查询
 *
 * 用户在公众号发任意消息 → 微信服务器 POST 到这里 → 返回中英双语状态
 *
 * 支持三种消息加密模式（自动识别）：
 *   明文模式  → 收发都是明文 XML
 *   安全模式  → 收发都是 AES 密文（需配 WECHAT_AES_KEY）
 *   兼容模式  → 收到密文回密文，收到明文回明文
 *
 * 环境变量（Vercel 后台配）：
 *   WECHAT_TOKEN       必填  与公众号后台「服务器配置」的 Token 一致
 *   WECHAT_AES_KEY     选填  43 位 EncodingAESKey（安全/兼容模式必填）
 *   STATUS_URL         选填  预计算好的 status.json 地址（有则秒回，强烈推荐）
 *   DEEPSEEK_API_KEY   选填  没配 STATUS_URL 时现场判定
 *   HANDLE             选填  监控对象，默认 thsottiaux
 */
const crypto = require('crypto');

const TOKEN = process.env.WECHAT_TOKEN || '';
const AES_KEY_B64 = process.env.WECHAT_AES_KEY || '';
const STATUS_URL = process.env.STATUS_URL || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const HANDLE = process.env.HANDLE || 'thsottiaux';
// 菜单「商务合作」里返回的微信号（在 Vercel 环境变量 WECHAT_ID 配置，改这个不用改代码）
const BIZ_ID = process.env.WECHAT_ID || '（请联系管理员）';
const SOURCE = `https://xcancel.com/${HANDLE}`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// AES 密钥（43 位 EncodingAESKey -> 32 字节 key，前 16 字节作 iv）
let AES_KEY = null;
let AES_IV = null;
if (AES_KEY_B64 && AES_KEY_B64.length >= 43) {
  AES_KEY = Buffer.from(AES_KEY_B64.slice(0, 43) + '=', 'base64');
  AES_IV = AES_KEY.slice(0, 16);
}

// 进程内缓存：同一实例 2 分钟内不重复抓取（避开微信 5s 限制）
let CACHE = { at: 0, data: null };
const CACHE_TTL = 120 * 1000;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function checkSignature(q) {
  const signature = q.signature || '';
  const timestamp = q.timestamp || '';
  const nonce = q.nonce || '';
  if (!signature || !timestamp || !nonce) return false;
  return sha1([TOKEN, timestamp, nonce].sort().join('')) === signature;
}

/** 微信密文消息签名：sha1(sort(token, timestamp, nonce, encrypt)) */
function msgSignature(token, timestamp, nonce, encrypt) {
  return sha1([token, timestamp, nonce, encrypt].sort().join(''));
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf;
  return buf.slice(0, buf.length - pad);
}

function pkcs7Pad(buf) {
  const blockSize = 32;
  const pad = blockSize - (buf.length % blockSize) || blockSize;
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

/** 解密微信消息 -> { xml, appid } */
function decryptMsg(encryptB64) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, AES_IV);
  decipher.setAutoPadding(false);
  let dec = Buffer.concat([
    decipher.update(Buffer.from(encryptB64, 'base64')),
    decipher.final(),
  ]);
  dec = pkcs7Unpad(dec);
  const msgLen = dec.readUInt32BE(16);          // 前 16 字节随机串，接着 4 字节长度
  const xml = dec.slice(20, 20 + msgLen).toString('utf8');
  const appid = dec.slice(20 + msgLen).toString('utf8').replace(/\0/g, '');
  return { xml, appid };
}

/** 加密回复内容 -> base64 密文 */
function encryptMsg(xml, appid) {
  const rand = crypto.randomBytes(16);
  const msg = Buffer.from(xml, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msg.length, 0);
  const appidBuf = Buffer.from(appid || '', 'utf8');
  const raw = pkcs7Pad(Buffer.concat([rand, lenBuf, msg, appidBuf]));
  const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, AES_IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(raw), cipher.final()]).toString('base64');
}

/** 加上 byte-range 保护地取 XML 字段 */
function pick(xml, tag) {
  const m = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(xml || '');
  if (m) return m[1];
  const m2 = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml || '');
  return m2 ? m2[1] : '';
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

// 编译期打包进函数的状态（0 延迟兜底；每次部署时刷新）
let BUNDLED = null;
try {
  BUNDLED = require('../public/status.json');
} catch (_) {}

/** 拿到状态：① 预计算 JSON（快） ② 打包状态（0延迟） ③ 现场判定（慢但永远可用） */
async function getStatus() {
  const now = Date.now();
  if (CACHE.data && now - CACHE.at < CACHE_TTL) return { ...CACHE.data, cached: true };

  // ① 优先：预计算好的 status.json（STATUS_URL，尽量用 raw GitHub -> 永不过期）
  if (STATUS_URL) {
    try {
      const txt = await fetchText(STATUS_URL, 2500);
      const j = JSON.parse(txt);
      if (j && j.last_reset !== undefined) {
        CACHE = { at: now, data: j };
        return { ...j, cached: false };
      }
    } catch (_) {}
  }

  // ② 兜底：打包进函数的状态（0 延迟，最多旧到上次部署）
  if (BUNDLED && BUNDLED.last_reset !== undefined) {
    CACHE = { at: now, data: BUNDLED };
    return { ...BUNDLED, cached: false, bundled: true };
  }

  // ③ 最后兜底：现场抓最新几条推文判定
  const doc = await fetchText(SOURCE, 6000);
  const tweets = parseTweets(doc, 3);
  if (!tweets.length) throw new Error('未能解析推文');
  const v = await classifyTweets(tweets);
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
  // 微信被动回复有长度上限，控制总长（中英各截一段）
  const en = (lr.text || '').slice(0, 110);
  const zh = (lr.zh || lr.reason || '').slice(0, 150);
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

/** 安全模式回包（外层套 Encrypt + MsgSignature） */
function xmlReplyEncrypted(plainXml) {
  const encrypt = encryptMsg(plainXml, APPID_FROM_MSG);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = msgSignature(TOKEN, ts, nonce, encrypt);
  return `<xml>
<Encrypt><![CDATA[${encrypt}]]></Encrypt>
<MsgSignature><![CDATA[${sig}]]></MsgSignature>
<TimeStamp>${ts}</TimeStamp>
<Nonce><![CDATA[${nonce}]]></Nonce>
</xml>`;
}

// 从收到的密文里解出的 appid，回包加密时复用（避免额外配置 AppID）
let APPID_FROM_MSG = '';

/** 读原始 body —— 微信发的是 text/xml，Vercel 默认不解析，必须自己读流 */
async function readRawBody(req) {
  if (typeof req.body === 'string' && req.body.length) return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') {
    if (req.body.xml && typeof req.body.xml === 'string') return req.body.xml;
    if (Object.keys(req.body).length) return JSON.stringify(req.body);
  }
  if (!req.on) return '';
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
  const raw = await readRawBody(req);
  const q = req.query || {};
  // 诊断日志：区分「微信来的请求」和「本地自测」（微信会带 msg_signature/encrypt_type）
  console.log(
    `[hit] ${req.method} qkeys=${Object.keys(q).sort().join(',')} ` +
    `encrypt_type=${q.encrypt_type || '-'} msg_sig=${q.msg_signature ? 'yes' : 'no'} ` +
    `len=${(raw || '').length} ua=${String((req.headers && req.headers['user-agent']) || '-').slice(0, 50)}`
  );
  let innerXml = raw;
  let encrypted = false;

  const encryptField = pick(raw, 'Encrypt');
  if (encryptField && AES_KEY) {
    // 验签（不一致也继续尝试解密，避免因签名细节差异直接失败）
    const expect = msgSignature(TOKEN, q.timestamp || '', q.nonce || '', encryptField);
    if (q.msg_signature && q.msg_signature !== expect) {
      console.log('[warn] msg_signature mismatch');
    }
    try {
      const dec = decryptMsg(encryptField);
      innerXml = dec.xml;
      APPID_FROM_MSG = dec.appid || '';
      encrypted = true;
    } catch (e) {
      console.log('[error] decrypt failed: ' + String(e));
      return res.status(200).send('');
    }
  }

  const fromUser = pick(innerXml, 'FromUserName') || pick(raw, 'FromUserName'); // 用户 openid
  const toAccount = pick(innerXml, 'ToUserName') || pick(raw, 'ToUserName');   // 公众号

  // 识别消息类型：菜单点击事件 / 关注事件 / 普通文本
  const msgType = (pick(innerXml, 'MsgType') || '').toLowerCase();
  const event = (pick(innerXml, 'Event') || '').toUpperCase();
  const eventKey = pick(innerXml, 'EventKey') || '';
  console.log(`[msg] type=${msgType || '-'} event=${event || '-'} key=${eventKey || '-'}`);

  let content;
  if (msgType === 'event' && event === 'CLICK' && /BIZ/i.test(eventKey)) {
    // 菜单「商务合作」-> 返回微信号
    content = [
      '🤝 商务合作 / Business Inquiries',
      '———————————',
      '微信 / WeChat：' + BIZ_ID,
      '———————————',
      '添加时请备注来意，谢谢！',
      'Please mention your purpose when adding. Thanks!',
    ].join('\n');
  } else if (msgType === 'event' && event === 'SUBSCRIBE') {
    // 关注欢迎语
    content = [
      '👋 欢迎关注 / Welcome',
      '———————————',
      '想查 Codex 额度有没有重置？',
      '点下方菜单「Codex重置」即可。',
      '',
      'Want to check if Codex quota has reset?',
      'Tap the 「Codex重置」 menu below.',
    ].join('\n');
  } else {
    // 菜单「Codex重置」点击 or 用户直接发任意消息 -> 返回额度状态
    try {
      const st = await getStatus();
      content = buildReply(st);
    } catch (e) {
      content =
        '😵 查询失败，请稍后再试\n\nQuery failed, please retry.\n\n(err: ' +
        String(e).slice(0, 80) +
        ')';
    }
  }

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  const plain = xmlReply(fromUser, toAccount, content);
  return res.status(200).send(encrypted ? xmlReplyEncrypted(plain) : plain);
};

// 关键：关掉 Vercel 的 body 解析，保证我们能读到微信的原始 XML
module.exports.config = { api: { bodyParser: false } };
