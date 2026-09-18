#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""知乎发布驱动 v2: 填标题 + 分段输入正文 + (可选,指定段位)插入配图 + 校验(不自动发布)。
用法:
  python3 zhihu_drive.py --title "..." --body <正文md> [--image <webp>] [--image-at N] --cdp 9222 [--publish]
说明:
  --image-at N: 在第 N 段(1-based)之后插入配图, 不指定则插在中间(len//2)。
  知乎正文是 DraftJS: 必须用 eval .focus() 后 keyboard type; 插图走工具栏「图片」按钮弹层,
  上传到 input[accept='image/*'] 后必须再点弹层「插入图片」按钮, 图片才进正文。
"""
import argparse, subprocess, sys, time, pathlib, re, json, os, tempfile

AB = "agent-browser.cmd"
# 预览截图默认写到系统临时目录(避免写死工作区路径), 可用 --preview 覆盖
PREVIEW = os.path.join(tempfile.gettempdir(), "zhihu_preview.png")

def ab(args, timeout=60000):
    r = subprocess.run([AB, "--cdp", "9222", *args], capture_output=True,
                       timeout=timeout, shell=False,
                       encoding="utf-8", errors="replace")
    return (r.stdout or ""), (r.stderr or ""), r.returncode

def snapshot_text():
    out, _, _ = ab(["snapshot", "-i"])
    return out

def parse_refs(txt):
    refs = {}
    tb = re.findall(r'textbox \[ref=(e\d+)\]', txt)
    m = re.search(r'请写入正文.*?textbox \[ref=(e\d+)\]', txt, re.S)
    body = m.group(1) if m else (tb[-1] if tb else None)
    title = [t for t in tb if t != body]
    refs["title"] = title[0] if title else None
    refs["body"] = body
    m = re.search(r'button "图片" \[[^\]]*ref=(e\d+)\]', txt)
    refs["image"] = m.group(1) if m else None
    m = re.search(r'button "发布" \[[^\]]*ref=(e\d+)\]', txt)
    refs["publish"] = m.group(1) if m else None
    return refs

def fill_title(title):
    refs = parse_refs(snapshot_text())
    tr = refs["title"]
    if not tr:
        print("[ERR] 未找到标题框 ref"); sys.exit(3)
    ab(["fill", f"@{tr}", title], 40000); time.sleep(0.6)
    print(f"[标题] ref={tr} 已 fill 标题")

def focus_body():
    ab(["eval", "document.querySelector('.DraftEditor-root [contenteditable=true]').focus();"], 10000)
    time.sleep(0.25)

def clear_body():
    focus_body()
    ab(["press", "Control+a"], 8000); time.sleep(0.3)
    ab(["press", "Delete"], 8000); time.sleep(0.3)
    chk, _, _ = ab(["eval", "(document.querySelector('.DraftEditor-root [contenteditable=true]').innerText||'').length"], 10000)
    print(f"[正文] 清空后字数: {chk}")

def type_body(body_file, image=None, image_at=None):
    paras = [p for p in pathlib.Path(body_file).read_text(encoding="utf-8").split("\n\n") if p.strip()]
    if image and image_at is None:
        image_at = len(paras) // 2
    clear_body()
    for i, para in enumerate(paras):
        focus_body()
        ab(["keyboard", "type", para], 60000)
        time.sleep(0.35)
        if image and image_at is not None and (i + 1) == image_at:
            # 光标已停在本段末尾: 移到段末并换行, 让图落在本段之后
            ab(["press", "End"], 8000); time.sleep(0.2)
            ab(["press", "Enter"], 10000); time.sleep(0.3)
            insert_image_at_cursor(image)
            print(f"[正文] 第 {i+1} 段后已插图")
        elif i < len(paras) - 1:
            ab(["press", "Enter"], 10000); time.sleep(0.3)
    print(f"[正文] 已输入 {len(paras)} 段" + (f", 插图位={image_at}" if image else ""))

def _j(s):
    s = (s or "").strip()
    try:
        return json.loads(s)
    except Exception:
        try:
            return json.loads(json.loads(s))
        except Exception:
            return None

def insert_image_at_cursor(img):
    """在当前光标处插入配图(不移动光标)。点「图片」按钮->上传->点「插入图片」。"""
    s = snapshot_text()
    refs = parse_refs(s)
    ir = refs["image"]
    if not ir:
        print("[ERR] 未找到图片按钮 ref"); return
    ab(["click", f"@{ir}"]); time.sleep(2.0)
    sel = "input[accept='image/*']"
    ab(["upload", sel, img], 30000)
    print(f"[图片] 已 upload {img} -> {sel}")
    # 上传后弹层需渲染, 重试找「插入图片」按钮(ref 会变)
    m = None
    for _ in range(8):
        time.sleep(1.5)
        s2 = snapshot_text()
        m = re.search(r'button "插入图片" \[[^\]]*ref=(e\d+)\]', s2)
        if m:
            break
        m = re.search(r'button "插入" \[[^\]]*ref=(e\d+)\]', s2)
        if m:
            break
    if m:
        ab(["click", f"@{m.group(1)}"]); print(f"[图片] 已点插入图片 @{m.group(1)}")
    else:
        print("[图片][WARN] 未找到「插入图片」按钮, 可能需手动确认")
    ok = False
    for _ in range(15):
        time.sleep(2.0)
        chk, _, _ = ab(["eval", "document.querySelectorAll('.DraftEditor-root img, [contenteditable=true] img').length"], 15000)
        if chk and chk.strip() not in ("0", ""):
            ok = True; print(f"[图片] 正文内 img 数: {chk}")
            break
    if not ok:
        print("[图片][WARN] 未检测到正文 img, 插入可能失败")

def verify():
    js = ("var ce=document.querySelector('.DraftEditor-root [contenteditable=true]');"
          "var ta=document.querySelector('textarea[placeholder*=\"标题\"]');"
          "var imgs=document.querySelectorAll('.DraftEditor-root img, [contenteditable=true] img');"
          "var pubs=[].filter.call(document.querySelectorAll('button'),function(b){return (b.textContent||'').trim()==='发布';});"
          "var info={bodyLen: ce? (ce.innerText||'').length : -1,"
          "titleLen: ta? (ta.value||'').length : -1,"
          "imgCount: imgs.length,"
          "pubDisabled: pubs.length? pubs[0].disabled : null};"
          "JSON.stringify(info);")
    out, _, _ = ab(["eval", js], 20000)
    print("[校验] CHECK:", out)
    return out

def publish():
    refs = parse_refs(snapshot_text())
    pr = refs["publish"]
    if not pr:
        print("[ERR] 未找到发布按钮 ref"); sys.exit(5)
    ab(["click", f"@{pr}"]); time.sleep(3)
    # 二次确认弹窗(若有第二个发布按钮)
    s = snapshot_text()
    ms = re.findall(r'button "发布" \[[^\]]*ref=(e\d+)\]', s)
    if len(ms) > 1:
        ab(["click", f"@{ms[-1]}"]); time.sleep(4)
    ab(["wait", "--load", "networkidle"], 30000)
    out, _, _ = ab(["get", "url"])
    print("[发布] 当前URL:", out)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", required=True)
    ap.add_argument("--body", required=True)
    ap.add_argument("--image", default=None)
    ap.add_argument("--image-at", type=int, default=None)
    ap.add_argument("--cdp", default="9222")
    ap.add_argument("--publish", action="store_true")
    ap.add_argument("--preview", default=PREVIEW, help="预览截图输出路径")
    args = ap.parse_args()

    ab(["open", "https://zhuanlan.zhihu.com/write"], 30000); time.sleep(3)
    fill_title(args.title)
    time.sleep(0.5)
    type_body(args.body, image=args.image, image_at=args.image_at)
    time.sleep(1)
    verify()
    ab(["screenshot", args.preview])
    print(f"[截图] {args.preview}")
    if args.publish:
        publish()
    else:
        print("[待确认] 未带 --publish，已停在发布前。请查看 zhihu_preview.png 后回复『发布』或加 --publish 重跑。")

if __name__ == "__main__":
    main()
