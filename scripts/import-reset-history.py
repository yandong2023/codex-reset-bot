#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
导入「重置历史」：从 codexresets.com 的日历页取全部历史事件
  - 每个事件：日期 + 原始推文链接（推文 ID = snowflake，可解出精确时间）
  - 顺带取推文正文，用 LLM 翻成中文
  - 与已有 public/reset-history.json 合并（按推文链接去重）

产物：[{ts, utc, date, text, zh, link, type}, ...] 按时间升序
"""
import re
import html
import json
import os
import sys
import time
import datetime
import subprocess

OUT = os.environ.get("HISTORY_OUT", "public/reset-history.json")
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
SRC = "https://codexresets.com"


def curl(url, timeout=60, jina=False):
    cmd = ["curl", "-sL", "--noproxy", "*", "-m", str(timeout)]
    if jina:
        cmd += ["-H", "x-return-format: html"]
    cmd.append(("https://r.jina.ai/" + url) if jina else url)
    p = subprocess.run(cmd, capture_output=True, timeout=timeout + 30)
    return p.stdout.decode("utf-8", "ignore")


def snowflake_ts(tid):
    """X/Twitter snowflake -> unix 秒（精确到秒）"""
    try:
        return ((int(tid) >> 22) + 1288834974657) // 1000
    except Exception:
        return None


def clean_texts(raw):
    """data-tweets 属性是 JSON 数组（可能 HTML 转义）"""
    try:
        arr = json.loads(html.unescape(raw))
        out = []
        for t in arr:
            if not isinstance(t, str):
                continue
            # 去掉 "English: " / "中文：" 之类前缀，只留正文
            t = re.sub(r'^\s*(English|EN|中文)\s*[:：]\s*', '', t).strip()
            if t:
                out.append(t)
        return "\n---\n".join(out)
    except Exception:
        return ""


def parse(doc):
    out = []
    for m in re.finditer(r'<a[^>]*class="[^"]*cal-day--hit[^"]*"[^>]*>', doc):
        tag = m.group(0)
        d = re.search(r'data-date="([\d-]+)"', tag)
        h = re.search(r'href="(https?://x\.com/[^"]+)"', tag)
        tw = re.search(r'data-tweets="([^"]*)"', tag)
        typ = re.search(r'data-reset-type="([^"]*)"', tag)
        if not d or not h:
            continue
        link = h.group(1)
        ts = snowflake_ts(link.rstrip("/").split("/")[-1])
        out.append({"date": d.group(1), "link": link, "ts": ts,
                    "text": clean_texts(tw.group(1)) if tw else "",
                    "type": typ.group(1) if typ else ""})
    return out


def translate(items):
    """批量把英文推文翻成中文，返回 {link: zh}"""
    if not items or not DEEPSEEK_API_KEY:
        return {}
    body_items = "\n".join(
        f'{i}. {(it["text"] or "")[:400]}' for i, it in enumerate(items))
    payload = json.dumps({
        "model": "deepseek-chat",
        "messages": [
            {"role": "system", "content":
             "Translate each numbered English tweet into concise natural Chinese "
             "(keep it short, one line). Return ONLY a JSON object mapping the index "
             'string to the Chinese translation, e.g. {"0":"...","1":"..."}'},
            {"role": "user", "content": body_items}],
        "temperature": 0, "max_tokens": 4000}).encode()
    req = subprocess.run(
        ["curl", "-s", "--noproxy", "*", "-m", "180",
         "-H", "Content-Type: application/json",
         "-H", "Authorization: Bearer " + DEEPSEEK_API_KEY,
         "--data-binary", "@-", "https://api.deepseek.com/v1/chat/completions"],
        input=payload, capture_output=True, timeout=240)
    try:
        d = json.loads(req.stdout.decode("utf-8", "ignore"))
        txt = d["choices"][0]["message"]["content"]
        m = re.search(r'\{[\s\S]*\}', txt)
        mp = json.loads(m.group(0)) if m else {}
        return {items[int(k)]["link"]: v for k, v in mp.items()
                if k.isdigit() and int(k) < len(items)}
    except Exception as e:
        print(f"translate failed: {str(e)[:80]}", file=sys.stderr)
        return {}


def main():
    doc = curl(SRC, jina=True)
    if "cal-day--hit" not in doc:
        doc = curl(SRC)                      # 兜底直连
    if "cal-day--hit" not in doc:
        raise SystemExit("no calendar data fetched")
    fresh = parse(doc)
    print(f"codexresets.com -> {len(fresh)} events")

    # 合并已有
    old = []
    if os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding="utf-8"))
        except Exception:
            old = []
    by_link = {}
    for h in old + fresh:
        k = h.get("link")
        if not k:
            continue
        prev = by_link.get(k)
        if not prev:
            by_link[k] = h
        else:                                # 补全字段
            for f in ("text", "zh", "ts", "type", "date"):
                if not prev.get(f) and h.get(f):
                    prev[f] = h[f]
    hist = [h for h in by_link.values() if h.get("ts")]
    hist.sort(key=lambda h: h["ts"])

    # 补翻译：只翻缺 zh 的（最多 40 条）
    need = [h for h in hist if not h.get("zh") and h.get("text")][:40]
    if need:
        print(f"translating {len(need)} items...")
        zhmap = translate(need)
        for h in hist:
            if not h.get("zh") and h["link"] in zhmap:
                h["zh"] = zhmap[h["link"]]
        time.sleep(1)

    # 补 utc 字符串
    for h in hist:
        if h.get("ts") and not h.get("utc"):
            h["utc"] = datetime.datetime.fromtimestamp(
                h["ts"], datetime.timezone.utc).strftime("%b %d, %Y · %I:%M %p UTC")

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    json.dump(hist, open(OUT, "w"), ensure_ascii=False, indent=1)
    print(f"wrote {OUT}: {len(hist)} resets")

    # 打印间隔统计
    if len(hist) > 1:
        gaps = [(hist[i]["ts"] - hist[i - 1]["ts"]) / 3600 for i in range(1, len(hist))]
        gaps = [g for g in gaps if 0.5 < g < 24 * 30]
        if gaps:
            s = sorted(gaps)
            print(f"gaps: n={len(gaps)} median={s[len(s)//2]:.1f}h "
                  f"avg={sum(gaps)/len(gaps):.1f}h min={min(gaps):.1f}h max={max(gaps):.1f}h")


if __name__ == "__main__":
    main()
