#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
建立 Codex「重置历史」——翻多页 @thsottiaux 时间线，LLM 判定哪些推文是重置，
产出 public/reset-history.json（给状态页推算"下次大概什么时候重置"）。

在 GitHub Actions 里跑（云端直连 xcancel；本机被 xcancel 反爬拦）。
产物：[{ts, utc, text, zh, link}, ...] 按时间升序
"""
import re
import html
import json
import os
import subprocess
import time
import datetime
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
X = "https://xcancel.com/thsottiaux"
OUT = os.environ.get("HISTORY_OUT", "public/reset-history.json")
PAGES = int(os.environ.get("HISTORY_PAGES", "12"))
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")


def _curl(url, timeout=90, html=False, ua=None):
    """用 curl 抓（实测 urllib 会被 jina 403）。
    ⚠️ 调 jina 时【不要】伪装 Chrome UA —— jina 在 Cloudflare 后面，
    伪装 UA 会触发 challenge 返回 403 "Just a moment..."。"""
    cmd = ["curl", "-sL", "--noproxy", "*", "-m", str(timeout)]
    if ua:
        cmd += ["-A", ua]
    if html:
        cmd += ["-H", "x-return-format: html"]
    cmd.append(url)
    p = subprocess.run(cmd, capture_output=True, timeout=timeout + 30)
    return p.stdout.decode("utf-8", "ignore")


def fetch(url, timeout=90):
    """优先走 r.jina.ai（xcancel 2026-09 起加了反爬验证页，直连拿不到内容）；
    失败再退回直连。返回 HTML 文本。"""
    jina = "https://r.jina.ai/" + url
    last = ""
    for attempt in range(3):
        try:
            d = _curl(jina, timeout=timeout, html=True)   # 不带 UA！
            if "timeline-item" in d:
                return d
            last = f"jina no timeline (len={len(d)})"
        except Exception as e:
            last = str(e)[:90]
        time.sleep(5 * (attempt + 1))          # 退避：jina 免费额度限速
    try:                                        # 兜底：直连（带浏览器 UA）
        return _curl(url, timeout=40, ua=UA)
    except Exception as e:
        raise RuntimeError(f"{last} / direct: {str(e)[:60]}")


def parse(doc):
    out = []
    for m in re.finditer(r'<div class="timeline-item[^"]*"(.*?)(?=<div class="timeline-item|'
                         r'</div>\s*</div>\s*<div class="show-more)', doc, re.S):
        b = m.group(1)
        c = re.search(r'<div class="tweet-content[^"]*"[^>]*>(.*?)</div>', b, re.S)
        d = re.search(r'<span class="tweet-date"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*title="([^"]+)"',
                      b, re.S)
        if not c:
            continue
        txt = html.unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', c.group(1)))).strip()
        link = ("https://x.com" + d.group(1).split("#")[0]) if d else ""
        date = d.group(2) if d else ""
        if txt and date:
            out.append({"text": txt, "date": date, "link": link})
    return out


def cursor_of(doc):
    m = re.search(r'href="([^"]*cursor=[^"]+)"', doc)
    if not m:
        return ""
    c = html.unescape(m.group(1))
    return c if c.startswith("http") else "https://xcancel.com" + c


SYS = """You are given a numbered list of tweets from the OpenAI Codex lead (@thsottiaux).
Return ONLY a JSON array of indexes (0-based integers) of tweets that announce a RESET of
Codex/ChatGPT usage limits or quota — i.e. telling users their limits/quotas/credits were reset,
refilled, refreshed, restored, or given again ("a reset", "all reset", "limits are back",
"reset done", "refilled for everyone"). NOT password resets, config/device resets, product
launches, or generic uses of the word. Be strict. If none, return [].
Output example: [1,4,7]"""


def llm(messages, max_tokens=800):
    body = json.dumps({"model": "deepseek-chat", "messages": messages,
                       "temperature": 0, "max_tokens": max_tokens}).encode()
    req = urllib.request.Request(
        "https://api.deepseek.com/v1/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + DEEPSEEK_API_KEY})
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read().decode())
    return d["choices"][0]["message"]["content"]


def to_ts(date_s):
    try:
        s = date_s.replace("·", "").replace("UTC", "").strip()
        return int(datetime.datetime.strptime(s, "%b %d, %Y %I:%M %p")
                   .replace(tzinfo=datetime.timezone.utc).timestamp())
    except Exception:
        return None


def main():
    # ---------- 1. 翻页抓推文 ----------
    all_t, seen, url, empty = [], set(), X, 0
    for p in range(PAGES):
        try:
            doc = fetch(url)
        except Exception as e:
            print(f"page {p+1} fetch error: {str(e)[:80]}"); break
        ts = parse(doc)
        new = 0
        for t in ts:
            k = t["link"] or t["text"][:50]
            if k not in seen:
                seen.add(k); all_t.append(t); new += 1
        print(f"page {p+1}: {len(ts)} tweets, {new} new")
        url = cursor_of(doc)
        if not url:
            break
        if new == 0:
            empty += 1
            if empty >= 2:
                break
        time.sleep(1.5)
    print(f"total tweets: {len(all_t)}")
    if not all_t:
        raise SystemExit("no tweets fetched")

    # ---------- 2. LLM 判定哪些是重置 ----------
    idxs = []
    CH = 60
    for i in range(0, len(all_t), CH):
        chunk = all_t[i:i + CH]
        items = "\n".join(f'{j}. {t["text"][:240]}' for j, t in enumerate(chunk))
        try:
            out = llm([{"role": "system", "content": SYS}, {"role": "user", "content": items}])
            m = re.search(r'\[[\d,\s]*\]', out)
            got = json.loads(m.group(0)) if m else []
            idxs += [i + j for j in got if 0 <= j < len(chunk)]
        except Exception as e:
            print(f"classify chunk {i} failed: {str(e)[:80]}")
    print(f"classified resets: {len(idxs)}")

    # ---------- 3. 翻译成中文 ----------
    picked = [all_t[i] for i in idxs if 0 <= i < len(all_t)]
    zh_map = {}
    if picked:
        lst = "\n".join(f'{j}. {t["text"][:220]}' for j, t in enumerate(picked))
        try:
            tr = llm([{"role": "system", "content":
                       "Translate each numbered English tweet into concise Chinese. "
                       "Return ONLY a JSON object mapping index string to translation, e.g. "
                       '{"0":"...","1":"..."}'},
                      {"role": "user", "content": lst}], max_tokens=2000)
            m = re.search(r'\{[\s\S]*\}', tr)
            if m:
                zh_map = json.loads(m.group(0))
        except Exception as e:
            print(f"translate failed: {str(e)[:80]}")

    hist = []
    for j, t in enumerate(picked):
        ts = to_ts(t["date"])
        if not ts:
            continue
        hist.append({"ts": ts, "utc": t["date"], "text": t["text"],
                     "zh": zh_map.get(str(j), ""), "link": t["link"]})

    # ---------- 4. 与已有历史合并（防翻页失败导致丢历史）----------
    if os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding="utf-8"))
            by_key = {}
            for h in list(old) + hist:
                k = h.get("link") or h.get("ts")
                if k and k not in by_key:
                    by_key[k] = h
                elif k and not by_key[k].get("zh") and h.get("zh"):
                    by_key[k] = h
            hist = list(by_key.values())
            print(f"merged with existing -> {len(hist)} unique resets")
        except Exception as e:
            print(f"merge skipped: {str(e)[:60]}")

    hist.sort(key=lambda h: h["ts"])

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    json.dump(hist, open(OUT, "w"), ensure_ascii=False, indent=1)
    print(f"wrote {OUT} with {len(hist)} resets")
    for h in hist[-10:]:
        bj = datetime.datetime.fromtimestamp(h["ts"], datetime.timezone(datetime.timedelta(hours=8)))
        print(f'  {bj.strftime("%m-%d %H:%M")} BJT | {h["text"][:60]}')


if __name__ == "__main__":
    main()
