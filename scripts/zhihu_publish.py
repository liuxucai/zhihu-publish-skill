#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
zhihu_publish.py — 知乎专栏发布辅助脚本（已验证可行路径）

功能：
  1. 把纯文本正文（按空行分段）通过「分段 keyboard type + 段间真实 Enter」
     真实输入到知乎 DraftJS 正文编辑器，确保 React state 同步、字数正常统计。
  2. 填标题（纯文本，不用 Markdown # 标记）。
  3. 校验正文 innerText 字数并定位发布按钮 ref。

为何不用 execCommand/clipboard/base64 一次性注入：
  知乎专栏正文是 DraftJS 编辑器，那些方式只改 DOM、不更新 React state，
  导致字数恒为 0、发布按钮 disabled。真实逐字符键盘输入才会触发 onChange。

用法：
  python3 zhihu_publish.py --title "标题" --body templates/zhihu_body_plain.md --ab "<agent-browser路径>" --cdp 9222

依赖：
  - 隔离 Chrome（isolated-browser skill 拉起，CDP 端口 9222）
  - agent-browser CLI
  - 已手动登录知乎且编辑器页 https://zhuanlan.zhihu.com/write 已打开

退出码：0=成功；非0=失败（详见 stderr）
"""
import argparse
import subprocess
import sys
import time
import pathlib

EDITORS = [
    ".DraftEditor-root [contenteditable=true]",
    "[role=textbox]",
    "div[contenteditable=true]",
]


def ab(ab_path, cdp, args, timeout=40000):
    r = subprocess.run(
        [ab_path, "--cdp", str(cdp), *args],
        capture_output=True, timeout=timeout, shell=True,
        encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        sys.stderr.write(f"[ab:{args[0]}] rc={r.returncode} err={(r.stderr or '')[:200]}\n")
    return (r.stdout or "").strip(), (r.stderr or "").strip(), r.returncode


def body_selector_js(expr, arg=""):
    sels = ",".join(f"'{s}'" for s in EDITORS)
    return (
        f"var sels=[{sels}];"
        f"var ed=null;"
        f"for(var i=0;i<sels.length&&!ed;i++){{ed=document.querySelector(sels[i]);}}"
        f"{expr}"
    ).replace("__ARG__", arg)


def clear_body(ab_path, cdp):
    js = body_selector_js(
        "if(!ed){return 'NO_EDITOR';}"
        "ed.focus();"
        "document.execCommand('selectAll',false,null);"
        "document.execCommand('delete',false,null);"
        "return 'cleared';"
    )
    out, _, _ = ab(ab_path, cdp, ["eval", js], 20000)
    return out


def type_body(ab_path, cdp, body_text):
    paras = [p for p in body_text.split("\n\n") if p.strip()]
    for i, para in enumerate(paras):
        # 跳过可能混入的标题行（首段若是标题且已单独填过，调用方应传入已去标题的正文）
        out, err, rc = ab(ab_path, cdp, ["keyboard", "type", para], 60000)
        if rc != 0:
            sys.stderr.write(f"[type] 段{i} 失败: {err[:120]}\n")
            return False
        if i < len(paras) - 1:
            ab(ab_path, cdp, ["press", "Enter"], 10000)
        time.sleep(0.4)
    return True


def fill_title(ab_path, cdp, title):
    # 先取标题框 ref（snapshot 中 placeholder 含"标题"的 input/textbox）
    out, _, _ = ab(ab_path, cdp, ["snapshot", "-i"], 20000)
    ref = None
    for line in out.splitlines():
        if "标题" in line and ("textbox" in line or "input" in line):
            # 形如: - textbox "标题" [ref=e25]
            import re
            m = re.search(r"ref=(e\d+)", line)
            if m:
                ref = m.group(1)
                break
    if not ref:
        sys.stderr.write("[fill_title] 未找到标题输入框 ref\n")
        return False
    ab(ab_path, cdp, ["click", f"@{ref}"], 15000)
    ab(ab_path, cdp, ["fill", f"@{ref}", title], 15000)
    return True


def check(ab_path, cdp):
    js = body_selector_js(
        "var pubs=[...document.querySelectorAll('button')].filter(function(b){return (b.textContent||'').trim()==='发布';});"
        "var info={len: ed? (ed.innerText||'').length : -1,"
        "pubDisabled: pubs.length? pubs[0].disabled : null};"
        "if(pubs.length){var r=pubs[0].getBoundingClientRect();info.pubRef='x'+Math.round(r.x+r.width/2)+'y'+Math.round(r.y+r.height/2);}"
        "JSON.stringify(info);"
    )
    out, _, _ = ab(ab_path, cdp, ["eval", js], 20000)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", required=True, help="文章标题")
    ap.add_argument("--body", required=True, help="纯文本正文 md 路径（按空行分段，勿含 # 标记）")
    ap.add_argument("--ab", required=True, help="agent-browser 可执行文件路径")
    ap.add_argument("--cdp", default="9222", help="CDP 端口，默认 9222")
    ap.add_argument("--no-title", action="store_true", help="正文文件已含标题且无需单独填标题框时跳过")
    args = ap.parse_args()

    body_text = pathlib.Path(args.body).read_text(encoding="utf-8")

    # 标题单独填；正文去掉首段（若首段是标题）
    paras = [p for p in body_text.split("\n\n") if p.strip()]
    if not args.no_title and paras and len(paras[0]) <= 50 and "\n" not in paras[0]:
        # 首段疑似标题：单独填标题框，正文从第二段起
        if not fill_title(args.ab, args.cdp, args.title or paras[0]):
            # 回退：用 --title
            if not fill_title(args.ab, args.cdp, args.title):
                sys.stderr.write("填标题失败\n")
        body_for_type = "\n\n".join(paras[1:]) if (args.title or len(paras) > 1) else body_text
    else:
        body_for_type = body_text

    if clear_body(args.ab, args.cdp) != "cleared":
        sys.stderr.write("[warn] 清空正文未确认，继续尝试输入\n")

    if not type_body(args.ab, args.cdp, body_for_type):
        sys.stderr.write("正文输入失败\n")
        sys.exit(2)

    result = check(args.ab, args.cdp)
    sys.stdout.write("CHECK: " + result + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
