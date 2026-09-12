// 测试两条路径：① 预计算 status.json（快） ② 现场判定（兜底）
const path = require('path');
const fs = require('fs');
const env = fs.readFileSync(process.env.HOME + '/.hermes/.env', 'utf8');
const key = ((env.match(/DEEPSEEK_API_KEY\s*=\s*(.+)/) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
process.env.WECHAT_TOKEN = 'testtoken123';
process.env.DEEPSEEK_API_KEY = key;

const XML = `<xml><ToUserName><![CDATA[gh_abc123]]></ToUserName>
<FromUserName><![CDATA[oUserOpenId888]]></FromUserName><CreateTime>1700000000</CreateTime>
<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[重置]]></Content><MsgId>1</MsgId></xml>`;

function mockRes() {
  return { statusCode: 200, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    send(b) { this.body = b; return this; } };
}
const contentOf = (b) => {
  const m = /<Content><!\[CDATA\[([\s\S]*?)\]\]><\/Content>/.exec(b || '');
  return m ? m[1] : (b || '');
};

(async () => {
  const file = path.resolve(process.argv[2]);

  // ---- ① 预计算路径（STATUS_URL 指向静态 JSON）----
  delete require.cache[file];
  process.env.STATUS_URL = 'http://127.0.0.1:8931/status.json';
  let h = require(file);
  let r = mockRes();
  let t0 = Date.now();
  await h({ method: 'POST', body: XML, query: {} }, r);
  console.log(`\n=== ① 预计算路径（STATUS_URL）— 耗时 ${((Date.now()-t0)/1000).toFixed(2)}s ===`);
  console.log(contentOf(r.body));

  // ---- ② 现场兜底路径（无 STATUS_URL）----
  delete require.cache[file];
  process.env.STATUS_URL = '';
  h = require(file);
  r = mockRes();
  t0 = Date.now();
  await h({ method: 'POST', body: XML, query: {} }, r);
  console.log(`\n=== ② 现场兜底路径（实时抓取+判定 3 条）— 耗时 ${((Date.now()-t0)/1000).toFixed(2)}s ===`);
  console.log(contentOf(r.body));
})();
