#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Codex 额度重置监控 — 盯着 @thsottiaux (OpenAI Codex 负责人 Tibo Sottiaux)

数据源 : xcancel.com (Nitter 镜像，可直连读取)
判定   : DeepSeek LLM 判定 + 中文翻译（应对措辞多变，保留英文原文）
产物   : ① stderr 日志
         ② ~/.hermes/codex-reset-state.json   去重状态
         ③ ~/.hermes/codex-reset-status.json  给「公众号/飞书」读的对外状态
行为   : 有【新的】重置 -> 打印中英双语告警（供 cron 直接推送）
         没有          -> 静默（空 stdout）
         抓取失败      -> stderr + exit 1
"""
import re, html, json, os, sys, time, urllib.request, urllib.error

HOME    = os.path.expanduser("~")
# 本地跑用 ~/.hermes/...；GitHub Actions 里用环境变量指到仓库内
STATE   = os.environ.get("CODEX_STATE") or os.path.join(HOME, ".hermes", "codex-reset-state.json")
STATUS  = os.environ.get("CODEX_STATUS") or os.path.join(HOME, ".hermes", "codex-reset-status.json")
ENV     = os.path.join(HOME, ".hermes", ".env")
SOURCE  = "https://xcancel.com/thsottiaux"
UA      = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
FORCE   = "--force" in sys.argv          # 忽略去重，回填判定（用于质量评估 / demo）
STATUS_OUT = None                        # --status-out <path> 可覆盖输出位置
for i, a in enumerate(sys.argv):
    if a == "--status-out" and i + 1 < len(sys.argv):
        STATUS_OUT = sys.argv[i + 1]


def opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept-Language": "en-US,en;q=0.9"})
    with opener().open(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")


def parse_tweets(doc):
    out = []
    for m in re.finditer(r'<div class="timeline-item[^"]*"(.*?)(?=<div class="timeline-item|'
                         r'</div>\s*</div>\s*<div class="show-more)', doc, re.S):
        block = m.group(1)
        c = re.search(r'<div class="tweet-content[^"]*"[^>]*>(.*?)</div>', block, re.S)
        d = re.search(r'<span class="tweet-date"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*title="([^"]+)"',
                      block, re.S)
        if not c:
            continue
        txt = html.unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', c.group(1)))).strip()
        link = ("https://x.com" + d.group(1).split("#")[0]) if d else ""
        date = d.group(2) if d else ""
        tid = link.rsplit("/", 1)[-1] if link else str(abs(hash(txt)))
        if txt:
            out.append({"id": tid, "text": txt, "date": date, "link": link})
    return out


def deepseek_key():
    if os.path.exists(ENV):
        for line in open(ENV, encoding="utf-8", errors="ignore"):
            if line.strip().startswith("DEEPSEEK_API_KEY"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get("DEEPSEEK_API_KEY", "")


SYS = """You detect whether a tweet announces a RESET of OpenAI Codex / ChatGPT usage limits or quota,
and you translate it into Chinese.

A "reset" = the author (OpenAI Codex lead) telling users that usage limits/quotas/credits have been
reset, refilled, refreshed, restored, or given back — e.g. "A reset", "All reset for everyone",
"we reset the limits", "quotas are back", "limits refreshed", "enjoy, reset done", "refilled".

NOT a reset: password resets, resetting a device/config, "reset" as a general word, product launches,
policy changes, model retirements, hiring, puns, or anything not about granting users more quota.
Be strict: when unsure, answer false.

Reply with ONLY this JSON (no markdown):
{"is_reset": true/false,
 "confidence": "high"|"medium"|"low",
 "reason": "<一句话中文理由>",
 "zh": "<这条推文的中文翻译，保留专有名词英文原样；若推文很短也照译>"}"""


def classify(text):
    """返回 (verdict_dict, tokens_used)。verdict 含 is_reset / confidence / reason(中文) / zh(中文翻译)"""
    key = deepseek_key()
    if not key:
        return {"is_reset": None, "confidence": "n/a", "reason": "缺少 DEEPSEEK_API_KEY", "zh": ""}, 0
    body = {
        "model": "deepseek-flash",
        "messages": [{"role": "system", "content": SYS},
                     {"role": "user", "content": "TWEET:\n" + text}],
        "thinking": {"type": "disabled"},
        "temperature": 0,
        "max_tokens": 500,
    }
    req = urllib.request.Request(
        "https://api.deepseek.com/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with opener().open(req, timeout=90) as r:
            d = json.load(r)
        used = int((d.get("usage") or {}).get("total_tokens") or 0)
        raw = (d["choices"][0]["message"].get("content") or "").strip()
        m = re.search(r'\{.*\}', raw, re.S)
        v = json.loads(m.group(0)) if m else {"is_reset": None, "reason": raw[:120], "zh": ""}
        return v, used
    except Exception as e:
        return {"is_reset": None, "confidence": "n/a",
                "reason": "api_err: " + str(e)[:120], "zh": ""}, 0


def load_state():
    if os.path.exists(STATE):
        try:
            return json.load(open(STATE, encoding="utf-8"))
        except Exception:
            pass
    return {"seen": {}, "last_reset": None}


def save_json(path, obj):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    json.dump(obj, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def iso(ts=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or time.time()))


def write_status(st, ok=True, err=""):
    """对外状态（公众号/飞书读这个）"""
    lr = st.get("last_reset") or {}
    now = time.time()
    reset_today = bool(lr.get("ts") and (now - lr["ts"]) < 86400)
    obj = {
        "updated_at": iso(),
        "ok": ok,
        "error": err,
        "reset_today": reset_today,
        "last_checked": iso(),
        "last_reset": lr,
        "source": SOURCE,
        "handle": "@thsottiaux",
    }
    save_json(STATUS_OUT or STATUS, obj)
    return obj


def main():
    st = load_state()
    seen = st["seen"]
    try:
        tweets = parse_tweets(fetch(SOURCE))
    except Exception as e:
        write_status(st, ok=False, err=str(e)[:200])
        print("⚠️ 抓取失败：" + str(e)[:200], file=sys.stderr)
        sys.exit(1)

    if not tweets:
        write_status(st, ok=False, err="未解析到推文（页面结构可能变了）")
        print("⚠️ 未解析到推文（页面结构可能变了）", file=sys.stderr)
        sys.exit(2)

    new_resets, checked, tokens = [], 0, 0
    for t in tweets[:12]:
        if t["id"] in seen and not FORCE:
            continue
        verdict, used = classify(t["text"])     # 全部新推文都过 LLM（措辞多变，不靠关键词）
        tokens += used
        checked += 1
        seen[t["id"]] = {"reset": bool(verdict.get("is_reset")),
                         "date": t["date"], "link": t["link"],
                         "zh": (verdict.get("zh") or "")[:400],
                         "reason": (verdict.get("reason") or "")[:200],
                         "ts": int(time.time())}
        if verdict.get("is_reset"):
            new_resets.append((t, verdict))

    if new_resets:
        t, v = new_resets[0]
        st["last_reset"] = {"text": t["text"][:400], "date": t["date"], "link": t["link"],
                            "zh": (v.get("zh") or "")[:400],
                            "reason": (v.get("reason") or "")[:200],
                            "ts": int(time.time())}
    save_json(STATE, st)
    write_status(st)

    if "--quiet" not in sys.argv:
        print(f"[info] 判定 {checked} 条 / 命中 {len(new_resets)} 条 / {tokens} tokens", file=sys.stderr)

    if new_resets:
        t, v = new_resets[0]
        print("🔔 **Codex 额度重置了 / Codex quota has been RESET**")
        print(f"🕐 {t['date']}")
        print(f"🇨🇳 {v.get('zh') or v.get('reason') or '(无翻译)'}")
        print(f"🇬🇧 {t['text'][:300]}")
        print(f"🔗 {t['link']}")


if __name__ == "__main__":
    main()
