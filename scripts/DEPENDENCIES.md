# 依赖与环境说明（zhihu-publish-skill v2 · playwright-core 直连）

## 一、运行依赖

| 依赖 | 版本/位置 | 说明 |
|---|---|---|
| 隔离 Chrome | `~/.workbuddy/skills/isolated-browser/scripts/launch.js` | 固定 profile `~/.chrome_qclaw_stable`（知乎登录态已持久化）；CDP 端口默认 9222 |
| Node.js | 22+（本机 `~/.workbuddy/binaries/node/versions/22.22.2-3/node.exe`） | 运行 `scripts/*.js` |
| playwright-core | `~/.workbuddy/binaries/node/workspace/node_modules/playwright-core` | 驱动层；脚本按 `OPENCLAW_NODE_MODULES` → 本机默认路径 → 全局 顺序查找 |

**已弃用（不要再用）**：agent-browser CLI（`agent-browser.cmd`）与其封装的两个 Python 脚本
（`zhihu_drive.py`、`zhihu_publish.py`，已从本 skill 删除）。本机实测其 `keyboard type` 卡死，
13 分钟只打入 1 个字，且 Python `subprocess` 缓冲导致长时间无任何输出。

```bash
# 环境变量（每个新 shell 都要设）
export OPENCLAW_NODE_MODULES="C:/Users/<user>/.workbuddy/binaries/node/workspace/node_modules"
export ISOB_CDP_PORT=9222                       # 可选，默认即 9222

# 后台常驻拉起隔离 Chrome（必须后台 + sleep 保活，否则被沙箱回收）
node "C:/Users/<user>/.workbuddy/skills/isolated-browser/scripts/launch.js" \
     "https://www.zhihu.com/" && sleep 7200
```

## 二、关键事实（全部来自 2026-09-22 / 09-23 实战）

1. **正文是 DraftJS 编辑器**：只能「逐段真实键盘输入 + 段间真实 Enter」。
   `fill` / `execCommand('insertText')` / base64 一次性注入只改 DOM、不更新 React state（字数恒 0）；
   `clipboard write` + `paste` 长文本会触发 CDP 超时（os 10060）。
2. **进编辑器后必须等 4s 草稿恢复**再输入，否则草稿恢复与键盘输入竞争 → 段落乱序、首段丢失。
3. **段落块选择器是 `.public-DraftStyleDefault-block`**（div，不是 `<p>`）。
4. **每段 type 前必须 `editor.focus()`**，否则光标漂移、段落不拆块，配图只能插到开头。
5. **配图三步**：点工具栏「图片」→ `setInputFiles` 到 `input[accept='image/*']`（弹层内有多个 input）
   → **缩略图出现后再等 3s** 点「插入图片」确认键。上传成功 ≠ 已插入正文。
6. **字数可信判据是正文 `innerText.length`**，不是按钮颜色或 `disabled`
   （按钮收到过任意 input 事件就会 enable 并保持）。
7. **正文不要用 `#` Markdown 标记**，会进入「Markdown 语法输入中」待转换态、字数不计入。
8. **发布后 URL 变 `/p/<id>`**；知乎会自动保存草稿，重新打开编辑器时 URL 为 `/p/<id>/edit`，
   该页提交按钮文案是**「更新」**。
9. **`connectOverCDP` 的 `browser.close()` 只断开连接**，不会关闭用户的隔离浏览器，也不会丢草稿。
10. **git-bash 调 node 用 `C:/Users/...` 风格路径**；`/c/Users/...` 会被拼成 `c:\c\Users\...` 报 MODULE_NOT_FOUND。

## 三、脚本一览

| 脚本 | 用途 |
|---|---|
| `zhihu_publish_pw.js` | 主脚本：填标题 + 逐段填正文 + 插图 + 发布/更新（`--edit-url` 走更新流程） |
| `zhihu_probe.js` | 只读探查：URL / 字数 / 图片数 / 块顺序 / 按钮文案，排查用 |
