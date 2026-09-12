// 本地模拟微信服务器，测试 api/wechat.js
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// 从 ~/.hermes/.env 读 DeepSeek key
const env = fs.readFileSync(process.env.HOME + '/.hermes/.env', 'utf8');
const key = (env.match(/DEEPSEEK_API_KEY\s*=\s*(.+)/) || [])[1];
process.env.WECHAT_TOKEN = 'testtoken123';
process.env.DEEPSEEK_API_KEY = (key || '').trim().replace(/^["']|["']$/g, '');
process.env.STATUS_URL = '';            // 空 => 走现场判定路径
process.env.HANDLE = 'thsottiaux';

const handler = require(path.resolve(process.argv[2]));

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    send(b) { this.body = b; return this; },
  };
}

(async () => {
  // ① GET 校验
  const ts = '1700000000', nonce = 'abc123';
  const sig = crypto.createHash('sha1').update(['testtoken123', ts, nonce].sort().join('')).digest('hex');
  let r = mockRes();
  await handler({ method: 'GET', query: { signature: sig, timestamp: ts, nonce, echostr: 'HELLO_OK' } }, r);
  console.log('=== ① GET 校验（正确签名）===');
  console.log('status:', r.statusCode, '| body:', r.body);

  r = mockRes();
  await handler({ method: 'GET', query: { signature: 'wrong', timestamp: ts, nonce, echostr: 'x' } }, r);
  console.log('=== ② GET 校验（错误签名，应 401）===');
  console.log('status:', r.statusCode, '| body:', r.body);

  // ③ POST 用户发消息
  const xml = `<xml><ToUserName><![CDATA[gh_abc123]]></ToUserName>
<FromUserName><![CDATA[oUserOpenId888]]></FromUserName>
<CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[重置]]></Content><MsgId>123456</MsgId></xml>`;
  r = mockRes();
  const t0 = Date.now();
  await handler({ method: 'POST', body: xml, query: {} }, r);
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\n=== ③ POST 查询（耗时 ${dt}s / 微信限 5s）===`);
  console.log('status:', r.statusCode, '| content-type:', r.headers['Content-Type']);
  const c = /<Content><!\[CDATA\[([\s\S]*?)\]\]><\/Content>/.exec(r.body || '');
  console.log('\n---- 用户会看到的回复 ----');
  console.log(c ? c[1] : r.body);
  console.log('\n---- 收件人是否正确（应回给 oUserOpenId888）----');
  console.log((r.body || '').slice(0, 240));
})();
