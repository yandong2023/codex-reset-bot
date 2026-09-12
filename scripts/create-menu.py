#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
创建 / 查询 / 删除 公众号自定义菜单

背景：启用「消息推送」（开发模式）后，控制台的自定义菜单编辑器会失效，
      菜单只能通过接口创建。

用法：
  WECHAT_APPID=wx... WECHAT_APPSECRET=... python3 scripts/create-menu.py          # 创建
  WECHAT_APPID=wx... WECHAT_APPSECRET=... python3 scripts/create-menu.py --query  # 查询当前菜单
  WECHAT_APPID=wx... WECHAT_APPSECRET=... python3 scripts/create-menu.py --delete # 删除菜单

注意：调微信接口需要把【本机公网 IP】加入「API IP白名单」（控制台 -> AppSecret 旁）。
      本脚本默认直连（不经代理），确保用的是本机真实出口 IP。
"""
import json
import os
import sys
import urllib.parse
import urllib.request

APPID = os.environ.get("WECHAT_APPID", "")
APPSECRET = os.environ.get("WECHAT_APPSECRET", "")
API = "https://api.weixin.qq.com"

# 菜单结构：两个 click 项，都由 Vercel 函数应答
MENU = {
    "button": [
        {"type": "click", "name": "Codex重置", "key": "CODEX"},
        {"type": "click", "name": "商务合作", "key": "BIZ"},
    ]
}


def req(url, data=None):
    """直连微信 API（绕过本机代理，保证出口 IP 是本机真实 IP）"""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    body = json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None
    r = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with opener.open(r, timeout=25) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    if not APPID or not APPSECRET:
        print("❌ 需要 WECHAT_APPID 和 WECHAT_APPSECRET 环境变量")
        return 1

    # ① 取 access_token
    tok = req(
        f"{API}/cgi-bin/token?grant_type=client_credential"
        f"&appid={APPID}&secret={APPSECRET}"
    )
    if "access_token" not in tok:
        print("❌ 取 access_token 失败：", json.dumps(tok, ensure_ascii=False))
        print("   errcode 40164 = 本机公网 IP 不在白名单（去控制台加一下）")
        return 1
    at = tok["access_token"]
    print("✅ access_token 获取成功")

    mode = sys.argv[1] if len(sys.argv) > 1 else ""

    if mode == "--query":
        out = req(f"{API}/cgi-bin/menu/get?access_token={at}")
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif mode == "--delete":
        out = req(f"{API}/cgi-bin/menu/delete?access_token={at}")
        print("删除结果：", json.dumps(out, ensure_ascii=False))
    else:
        out = req(f"{API}/cgi-bin/menu/create?access_token={at}", MENU)
        print("创建结果：", json.dumps(out, ensure_ascii=False))
        if out.get("errcode") == 0:
            print("🎉 菜单创建成功！")
            print("   按钮1：Codex重置  -> 返回额度状态")
            print("   按钮2：商务合作   -> 返回微信号")
            print("   （用户需取消关注再关注，或等几分钟，菜单才会刷新）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
