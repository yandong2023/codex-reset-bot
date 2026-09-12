# Codex 重置 Bot

盯着 **@thsottiaux**（OpenAI Codex 负责人 Tibo Sottiaux）的 X 帖子；他每次宣布**额度重置**，
就推送提醒；公众号里也能随时查到状态（**中英双语**）。

## 架构

```
① 监控  monitor.py / Hermes cron
   抓 xcancel.com/thsottiaux → DeepSeek 判定+翻译 → 写 status.json
        ↓
② 发布  publish.sh → public/status.json → git push → Vercel 自动部署
        ↓
③ 查询  Vercel 函数 /api/wechat（读 status.json，0.05s 返回）
        ↓
④ 公众号 后台「服务器配置」指向 https://<项目>.vercel.app/api/wechat
```

## 接口

| 路径 | 用途 |
|---|---|
| `GET /api/wechat` | 微信服务器配置的**签名校验**（自动） |
| `POST /api/wechat` | 用户发消息 → 返回 Codex 状态（中英双语 XML） |
| `GET /api/status` | 纯 JSON 状态（自测 / 给别的渠道复用） |
| `GET /status.json` | 预计算状态（Vercel 函数优先读它 → 秒回） |

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `WECHAT_TOKEN` | ✅ | 必须与公众号后台「服务器配置」里填的 Token **完全一致** |
| `STATUS_URL` | 推荐 | `https://<项目>.vercel.app/status.json`，配了就是 0.05s 秒回 |
| `DEEPSEEK_API_KEY` | 选填 | 只在 `STATUS_URL` 不可用时启用现场判定（约 3.4s） |
| `HANDLE` | 选填 | 监控对象，默认 `thsottiaux` |

> ⚠️ **微信要求 5 秒内响应**：一定配 `STATUS_URL`。没配时走现场判定（约 3.4s），
> 网络慢就可能超时。

## 公众号后台配置（一次性）

1. 登录 [微信公众平台](https://mp.weixin.qq.com) → 左侧 **设置与开发 → 基本配置**
2. **服务器配置** → 修改配置：
   - **URL**：`https://<项目>.vercel.app/api/wechat`
   - **Token**：任意字符串（要跟环境变量 `WECHAT_TOKEN` 一致）
   - **EncodingAESKey**：随机生成（选「明文模式」即可）
   - **消息加解密方式**：**明文模式**
3. 点「提交」→ 微信会 GET 你的 URL 校验签名（本接口已实现）→ 通过即生效
4. 用户发**任意消息**（或点菜单「Codex 重置了吗」）→ 立刻收到状态

### ⚠️ 已知坑：开启服务器配置后自定义菜单会消失
顺序必须是：
1. **先停用**服务器配置 → 2. 去「内容与互动 → 自定义菜单」改好菜单 →
3. **再启用**服务器配置 → 4. 左侧底部「+ 新的功能」→ 已开通里找到「自定义菜单」→ **重新启用**
> 少最后两步，菜单不会生效。

## 同步状态（每次监控跑完）

```bash
./publish.sh          # 把 ~/.hermes/codex-reset-status.json 复制到 public/ 并推送
```

## 本地测试

```bash
node test/wechat_local.js      # 模拟微信 GET 校验 + POST 消息
```
