---
name: zhihu-publisher
description: |
  知乎文章自动发布技能。通过隔离 Chrome（isolated-browser skill 拉起）+ agent-browser CLI（CDP 9222）控制 Chrome 完成知乎登录、撰写和发布文章的全流程。
  触发词：发布知乎、知乎文章、zhihu publish、发知乎文章、知乎发文章。
  依赖：isolated-browser skill（未装则从 https://github.com/liuxucai/isolated-browser-skill 安装）。
---

# 知乎文章自动发布

## 依赖与环境

- **浏览器**：通过 `isolated-browser` skill 拉起隔离 Chrome（默认 CDP 端口 9222）。未装该 skill 时从 https://github.com/liuxucai/isolated-browser-skill 安装。
- **驱动 CLI**：`agent-browser`，本机路径 `C:\Users\菠萝\AppData\Roaming\QClaw\npm-global\agent-browser.cmd`（下文以变量 `$AB` 指代，命令统一加 `--cdp 9222`）。
- **登录态**：隔离 Chrome 首次需用户手动登录知乎；登录态由隔离浏览器保管，重开复用。

```powershell
$AB = "C:\Users\菠萝\AppData\Roaming\QClaw\npm-global\agent-browser.cmd"
```

## 文章要求

- 目标字数：**1500 字**（含标点），下限 1200，上限 1800。
- 正文用**纯文本分段**（段落间空行），不要用 Markdown `#` 标记——见下方「核心坑」。

## 流程一：登录（仅需一次）

### 1. 打开登录页
```powershell
& $AB --cdp 9222 open https://www.zhihu.com/signin
```

### 2. 切密码登录 + 取 ref + 填凭据
```powershell
& $AB --cdp 9222 find role button click --name 密码登录
& $AB --cdp 9222 snapshot -i        # 记录账号/密码 textbox、登录按钮的 ref
& $AB --cdp 9222 fill @<账号ref> <账号>
& $AB --cdp 9222 fill @<密码ref> <密码>
& $AB --cdp 9222 click @<登录ref>
```
> ⚠️ 账号密码通过用户输入获取，**禁止写死到文件中**。触发滑块验证时 URL 停留 `/signin`，需用户手动拖动。

### 3. 验证
登录成功：URL 变为 `https://www.zhihu.com/`。

## 流程二：发布文章

### 1. 打开编辑器
```powershell
& $AB --cdp 9222 open https://zhuanlan.zhihu.com/write
& $AB --cdp 9222 wait --load networkidle
& $AB --cdp 9222 snapshot -i
```

### 2. 填标题
```powershell
& $AB --cdp 9222 click @<标题ref>      # 通常 e25/e27，以 snapshot 为准
& $AB --cdp 9222 fill @<标题ref> <标题>
```

### 3. 填正文（✅ 唯一可靠方法：分段 keyboard type + 真实 Enter）

> **为什么不用别的**：知乎专栏正文是 **DraftJS 编辑器**（`.public-DraftEditor-content`）。
> - ❌ `fill` / `execCommand('insertText')` / base64 一次性注入：只改 DOM、不更新 React state → 字数恒为 0 → 发布按钮 disabled。
> - ❌ `clipboard write` + `paste`：长文本触发 CDP 超时（os 10060），paste 写不进去。
> - ❌ 整篇 `keyboard type <含\n文本>`：把 `\n` 当分隔符，只打进第一段（约 35 字）。
> - ✅ **分段 `keyboard type`（每段不含换行）+ 段间真实 `press Enter`**：真实逐字符输入必触发 DraftJS `onChange`，state 同步、字数正常。

**推荐用 skill 自带脚本**（已封装上述逻辑，自包含、无需外部文件）：

```powershell
$AB = "C:\Users\菠萝\AppData\Roaming\QClaw\npm-global\agent-browser.cmd"
# 正文模板见 skill 内 templates/zhihu_body_plain.md（纯文本、按空行分段、无 # 标记）
python3 E:\skills\zhihu-publisher\scripts\zhihu_publish.py `
  --title "<标题>" `
  --body E:\skills\zhihu-publisher\templates\zhihu_body_plain.md `
  --ab $AB --cdp 9222
```
> 脚本会：① 单独填标题框；② 清空正文；③ 按空行分段 `keyboard type` + 段间真实 `Enter` 输入正文；④ 输出 `CHECK:` 含正文 `innerText` 字数与发布按钮状态。
>
> 想自定义文章：复制 `templates/zhihu_body_plain.md` 改内容（**首行放标题、空行、再写正文；正文勿用 `#` Markdown 标记**），把路径传给 `--body`。

**或手写最小步骤**（理解原理用）：

```python
import subprocess, time, pathlib
AB = r"C:\Users\菠萝\AppData\Roaming\QClaw\npm-global\agent-browser.cmd"
PORT = "9222"
def ab(args, t=40000):
    r = subprocess.run([AB, "--cdp", PORT, *args], capture_output=True,
                       timeout=t, shell=True, encoding="utf-8", errors="replace")
    return r.stdout.strip(), r.stderr.strip(), r.returncode

plain = pathlib.Path(r"E:\skills\zhihu-publisher\templates\zhihu_body_plain.md").read_text(encoding="utf-8")
paras = [p for p in plain.split("\n\n") if p.strip()]
body = paras[1:]   # 跳过首段（标题已在标题框，勿重复）

# 清空正文
js_clear = ("var ed=document.querySelector('.DraftEditor-root [contenteditable=true]')"
            "||document.querySelector('[role=textbox]')"
            "||document.querySelector('div[contenteditable=true]');"
            "ed.focus();document.execCommand('selectAll',false,null);"
            "document.execCommand('delete',false,null);'cleared';")
ab(["eval", js_clear], 20000)

# 逐段真实输入（每段不含换行），段间真实回车
for i, para in enumerate(body):
    ab(["keyboard", "type", para], 40000)
    if i < len(body) - 1:
        ab(["press", "Enter"], 10000)
    time.sleep(0.4)

# 校验：正文 innerText 字数应≈正文长度；发布按钮应 enabled
js_chk = ("var ce=document.querySelector('.DraftEditor-root [contenteditable=true]')"
          "||document.querySelector('[role=textbox]');"
          "var pubs=[...document.querySelectorAll('button')].filter(b=>(b.textContent||'').trim()==='发布');"
          "JSON.stringify({len:(ce?ce.innerText:'').length,"
          "pubDisabled:pubs.length?pubs[0].disabled:null});")
ab(["eval", js_chk], 20000)
```

> ⚠️ **字数可信判据 = 正文 `innerText.length`**，不是发布按钮颜色 / `disabled` / `pubDisabled`（按钮一旦收到过任意 input 事件就会切到 enabled 并保持，即使内容后来丢失）。

### 4. 智能排版（可选）
```powershell
& $AB --cdp 9222 snapshot -i          # 找「智能排版」按钮 ref
& $AB --cdp 9222 click @<智能排版ref>
```

### 5. 发布
```powershell
& $AB --cdp 9222 snapshot -i          # 找「发布」按钮 ref（通常 e38）
& $AB --cdp 9222 click @<发布ref>
& $AB --cdp 9222 wait --load networkidle
```
成功标志：URL 变为 `https://zhuanlan.zhihu.com/p/<ID>`，出现「发布成功 感谢你的第 N 篇创作」弹窗。

> 本账号实测封面未强制拦截即可发布；若需规范封面，发布前用创作助手「AI 配图」或上传本地图先设封面。

## 核心规则

| 规则 | 说明 |
|------|------|
| 正文必用分段 keyboard type + 真实 Enter | DraftJS 编辑器，禁用 `fill` / `execCommand('insertText')` / base64 一次性注入（字数恒 0） |
| 正文用纯文本分段，勿用 `#` Markdown 标记 | `#` 会触发「Markdown 语法输入中」待转换态，字数不统计 |
| ref 每次刷新 | 每步前 `snapshot -i`，ref 只在同一会话内有效 |
| 字数判据 = `innerText.length` | 不以按钮颜色 / disabled 为准 |
| 长操作拆段 + 重试 | 绕过 CDP 偶发超时（os 10060）；单段 < 400 字 |
| 发布前截图确认无浮层 | 右下角评分/满意度弹窗会遮挡发布按钮，先用 eval 点掉或等其消失 |
| 用 snapshot ref 点击，别用坐标 | agent-browser eval 返回的 JSON 常被转义包装，直接解析易错 |
| PowerShell 长 JS / 长中文用 .py 脚本 | 避开管道 GBK 编码损坏与多行 `node -e` 吞输出 |

## 附录：踩坑与解决清单（实践记录）

1. **skillhub install 失败** → 改用 `git clone` 手动装到 `skills/zhihu-publisher/`。
2. **SKILL.md 硬编码非本机路径** → 统一改为本机 `agent-browser` + CDP 9222 引用规格。
3. **git clone 报错 + PowerShell GBK 损坏文件** → 用 Python `utf-8` 读写绕开。
4. **base64 一次性插入 Markdown 正文 → 字数 0** → 去掉 `#` 标记，改纯文本。
5. **`execCommand('insertText')` 只改 DOM、不更新 React state（字数恒 0）** → DraftJS 不触发 onChange，禁用。
6. **`clipboard write` 超时（10060）→ paste 失效** → 长文本 CDP 不稳，弃用。
7. **`keyboard type` 整篇被 `\n` 截断到 35 字** → type 不处理换行，弃用整篇。
8. **✅ 分段 `keyboard type` + 真实 `Enter`** → 正文完整进入、字数正常、发布启用（最终方案）。
9. **右下角评分弹窗遮挡发布按钮** → eval 点掉 / 等其消失，发布前截图确认。
10. **「视觉蓝色但 DOM disabled」误判** → 以 `innerText.length` 实际字数为准。
11. **点击发布要求封面（coverRequired）** → 本账号未强制，直接发布；需规范先设封面。
12. **agent-browser eval 返回 JSON 被转义包装** → 改用 `snapshot -i` 取 ref 再 `click @ref`。
13. **CDP 偶发超时（10060）** → 长操作拆 <400 字/段 + 段间 sleep + 失败重试 + 写独立 `.py` 跑。
