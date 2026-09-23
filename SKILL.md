---
name: zhihu-publisher
description: |
  知乎文章自动发布技能（playwright-core 直连版）。通过隔离 Chrome（isolated-browser skill 拉起，CDP 9222）+ playwright-core 直连驱动，完成知乎登录检查、撰写文章、插入配图、发布/更新全流程。
  触发词：发布知乎、知乎文章、zhihu publish、发知乎文章、知乎发文章。
  依赖：isolated-browser skill（未装则从 https://github.com/liuxucai/isolated-browser-skill 安装）+ playwright-core。
  版本说明：v2 起**彻底放弃 agent-browser CLI 驱动**（本机实测卡死），改为 playwright-core 直连 CDP。
---

# 知乎文章自动发布（playwright-core 直连版）

> **v2 重构（2026-09-22 实战验证）**：原 agent-browser CLI 路线（`zhihu_drive.py` / `zhihu_publish.py`）
> 在本机出现 `keyboard type` 卡死（13 分钟仅输入 1 个字），两个 Python 脚本已**删除**，
> 全流程改为 **playwright-core `connectOverCDP` 直连**。如需旧脚本可从 git 历史取回：
> `git -C D:\skills\zhihu-publish-skill show c4df2aa:scripts/zhihu_drive.py > zhihu_drive.py`

## 一、依赖与环境

| 依赖 | 本机位置 / 值 | 说明 |
|---|---|---|
| 隔离 Chrome | `~/.workbuddy/skills/isolated-browser/scripts/launch.js` | 固定 profile `~/.chrome_qclaw_stable`，知乎登录态已持久化 |
| CDP 端口 | `9222` | 环境变量 `ISOB_CDP_PORT` 可覆盖 |
| 驱动层 | `playwright-core`（`~/.workbuddy/binaries/node/workspace/node_modules`） | 环境变量 `OPENCLAW_NODE_MODULES` 指向该目录 |
| Node | 22+ | 本机 `~/.workbuddy/binaries/node/versions/22.22.2-3/node.exe` |

```bash
# 1) 后台常驻拉起隔离 Chrome —— 必须 run_in_background，且带 sleep 保活
#    （沙箱会在命令结束时回收 detached 子进程，前台调用会导致 Chrome 立刻被杀）
node "C:/Users/<user>/.workbuddy/skills/isolated-browser/scripts/launch.js" "https://www.zhihu.com/" && sleep 7200

# 2) 给驱动脚本设置环境变量（每个新 shell 都要设）
export OPENCLAW_NODE_MODULES="C:/Users/<user>/.workbuddy/binaries/node/workspace/node_modules"
```

> ⚠️ **路径风格**：git-bash 下调用 node 一律用 `C:/Users/...` 风格路径；
> 写成 `/c/Users/...` 会被拼成 `c:\c\Users\...` 报 MODULE_NOT_FOUND。

## 二、文章要求

- 目标字数：**1500 字**（含标点），下限 1200，上限 1800。
- 标题**单独传参**（`--title` 或 `--title-file`），**正文文件里不要再写标题**。
- 正文用**纯文本分段**：段落之间空一行，**不要用 `#` 等 Markdown 标记**——见踩坑清单第 9 条。
- 单段建议 < 400 字，避免单次输入过长。

## 三、流程一：登录（仅需一次）

- 隔离 Chrome 首次需用户手动登录（触发滑块时也需人工拖动）。**禁止把账号密码写进文件**。
- 验证：`page.evaluate` 检查 `document.querySelector('img.Avatar')` 存在、或页面标题含「首页 - 知乎」。
- 登录态由 `~/.chrome_qclaw_stable` 长期保管，重开复用。

## 四、流程二：发布文章（一条命令）

```bash
export OPENCLAW_NODE_MODULES="C:/Users/<user>/.workbuddy/binaries/node/workspace/node_modules"
node scripts/zhihu_publish_pw.js \
  --title "文章标题" \
  --body  templates/body_plain.txt \      # 纯正文，段间空行，不含标题
  --image "D:/skills/car/11.jpg" \        # 可选：正文配图
  --image-at 5 \                          # 可选：插在第 5 段之后；省略则插在中间(段数//2)
  --publish                               # 不带则只填稿、停在发布前，供人工确认截图
```

脚本内部流程（每一步都是实战结论）：
1. 打开 `https://zhuanlan.zhihu.com/write` → 等编辑器出现 → **再等 4s 让草稿恢复**（第 3 条坑）。
2. 清空正文（`click` + `Control+a` + `Delete`）并校验字数 ≈ 0。
3. 填标题：标题框 `fill("")` + `keyboard.type(title, {delay:15})`。
4. 逐段输入正文：**每段先 `editor.focus()`，再 `keyboard.type(para, {delay:10})`，段间 `press("Enter")`**。
5. 校验：逐块 dump 前 8 个字比对顺序、`innerText.length` 校验字数。
6. 插图（若指定）：Range 定位第 N 段末尾 → `End` + `Enter` → 点工具栏「图片」→
   `setInputFiles` 到 `input[accept='image/*']` → 等缩略图 + **额外等 3s** → 点「插入图片」→ 校验正文 `img` 数。
7. 截图到 `--preview`（默认 `<脚本目录>/zhihu_preview.png`）。
8. `--publish` 时点「发布」（含二次确认弹窗），`waitForURL(/zhuanlan\.zhihu\.com\/p\/\d+/)`。

**成功标志**：URL 变为 `https://zhuanlan.zhihu.com/p/<ID>`，页面出现「发布成功 感谢你的第 N 篇创作」弹窗。

## 五、流程三：修复 / 更新已发布文章

知乎专栏文章**发布后可编辑**。段落乱序、漏配图等情况用它修：

```bash
node scripts/zhihu_publish_pw.js \
  --edit-url "https://zhuanlan.zhihu.com/p/<ID>/edit" \
  --title "文章标题" --body templates/body_plain.txt \
  --image "xxx.jpg" --image-at 5 --publish
```
- 编辑页的提交按钮文案是 **「更新」**（不是「发布」），脚本已自动识别 `发布|更新`。
- 脚本会**先清空正文再重打**，因此天然可修「块顺序错乱 / 首段丢失」。

## 六、流程四：状态探查（调试用）

```bash
node scripts/zhihu_probe.js            # 默认检查当前 zhuanlan 页面
node scripts/zhihu_probe.js --edit-url "https://zhuanlan.zhihu.com/p/<ID>/edit"
```
输出：URL、`bodyLen`、`titleLen`、`imgCount`、各段块顺序（前 8 字）、按钮文案列表。排查“到底填进去没有”时先跑它。

## 七、核心规则（不可违反）

| 规则 | 说明 |
|---|---|
| 驱动层只用 playwright-core 直连 CDP | agent-browser CLI 的 `keyboard type` 本机卡死，已废弃（脚本已删） |
| 正文必须逐段真实键盘输入 + 段间真实 Enter | DraftJS 编辑器；`fill` / `execCommand('insertText')` / base64 一次性注入只改 DOM、不更新 React state（字数恒 0） |
| 正文纯文本分段，勿用 `#` Markdown 标记 | `#` 会触发「Markdown 语法输入中」待转换态，字数不计入 |
| 进 `/write`、`/edit` 页后先等 4s 再输入 | 草稿恢复与键盘输入竞争会导致段落乱序、首段丢失 |
| 每段 type 前必须重新 `focus()` 正文 | 否则光标漂移、段落不拆块，插图只能落开头 |
| 段落块选择器 = `.public-DraftStyleDefault-block` | 不是 `<p>`（DraftJS 生成的是 div 块） |
| 字数可信判据 = 正文 `innerText.length` | 不看按钮颜色 / `disabled`（收过 input 事件就永久 enable） |
| 配图必须点「插入图片」确认键 | `setInputFiles` 仅入弹层队列，不点确认键图片不进正文 |
| 配图 file input 用 `accept='image/*'` | 弹层内多个 input，只有它是本地上传真正目标 |
| 缩略图出现后再等 3s 才点「插入图片」 | 等后端上传完成；过早点击会静默失败（imgCount=0） |
| 中间插图用 Range + `End` + `Enter` 定光标 | 勿用 `Control+Home`（会插到正文开头） |
| 发布前截图确认无浮层遮挡 | 右下角评分/满意度弹窗会挡住发布按钮 |
| 隔离 Chrome 必须后台常驻保活 | `run_in_background` + `sleep 7200`，否则被沙箱回收 |
| `connectOverCDP` 后 `browser.close()` 只是断开连接 | 不会关闭浏览器；草稿由知乎自动保存（URL 会变成 `/p/<id>/edit`） |

## 八、踩坑与解决清单（全量）

| # | 现象 | 根因 | 解决方法 |
|---|---|---|---|
| 1 | agent-browser `keyboard type` 极慢/卡死：13 分钟只打入 1 字，正文 `bodyLen` 恒为 1，脚本无任何输出 | agent-browser CLI 逐字输入链路在本机不可用 | **改用 playwright-core `chromium.connectOverCDP('http://127.0.0.1:9222')`**，`page.keyboard.type(para,{delay:10})` 逐段输入，1400 字 2 分钟内完成。**旧脚本 `zhihu_drive.py`/`zhihu_publish.py` 已删除** |
| 2 | 脚本运行十几分钟没有任何 stdout | Python `subprocess` 缓冲 + 上游卡死 | 直接弃用该链路；Node 脚本输出即打即显，另加 `--dry-run` 分段验证 |
| 3 | 首次发布后文章段落乱序（第 6 段跑到开头）、首段丢失 | 页面在草稿恢复期间就开始输入，DraftJS 初始 state 与输入竞争 | 进入编辑器后 **`waitForTimeout(4000)`**；输入前先 `Control+a`+`Delete` 清空；输入后 dump 各块前 8 字**校验顺序**；已乱序的文章用 `--edit-url` 清空重打 + 「更新」修复 |
| 4 | 用 `document.querySelectorAll('... p')` 找不到段落块，`blocks.length = 0` | DraftJS 的段落块是 div，不是 `<p>` | 选择器改用 **`.public-DraftStyleDefault-block`** |
| 5 | 配图上传后正文 `imgCount` 恒为 0（弹层缩略图已显示、按钮也已点击） | 缩略图是本地预览，后端上传未完成就点了「插入图片」，静默失败 | 缩略图出现后**额外 `sleep(3000)`** 再点确认键；点完再轮询正文 `img` 数，失败则关弹层重试（最多 3 次） |
| 6 | `upload`/`setInputFiles` 返回成功但正文无图 | 上传只是把文件放进弹层队列 | 必须再点弹层里的**「插入图片」**确认键，图片才进正文 |
| 7 | 图片上传到了错误的目标 | 弹层内有多个 file input（附件、image/webp…） | 只选 **`input[accept='image/*']`** |
| 8 | 图片插到了正文开头而不是中间 | 光标未定位 / 误用 `Control+Home` | 每段 type 前 `editor.focus()`；中间插图用 **DOM Range `selectNodeContents(block[N-1]); collapse(false)`** 定位第 N 段末尾，再 `End` + `Enter` |
| 9 | 正文写了 `#` 标题后字数不统计 | `#` 触发「Markdown 语法输入中」待转换态 | 纯文本分段，不使用任何 Markdown 标记 |
| 10 | `fill` / `execCommand('insertText')` / base64 注入文本后字数恒 0 | 只改 DOM、不更新 React/DraftJS state | 只用真实键盘事件（`keyboard.type` / `press`） |
| 11 | `clipboard write` + `paste` 长文本触发 CDP 超时（os 10060） | 长文本走剪贴板不稳 | 弃用；改逐段输入，单段 < 400 字 |
| 12 | 「视觉上按钮已变蓝」但实际发不出去 | 按钮收到任意 input 事件就会 enable 并保持 | 以 **`innerText.length`** 判断是否真的写入 |
| 13 | 发布后重新打开编辑器，URL 变成 `/p/<id>/edit` | 知乎自动保存草稿 | 正常现象；编辑页提交按钮文案是**「更新」** |
| 14 | 点「发布」无反应 | 右下角评分/满意度浮层遮挡 | 发布前截图确认无浮层；必要时先 `Escape` / 点掉浮层 |
| 15 | 隔离 Chrome 起来就消失 | 沙箱回收 detached 子进程 | 启动命令用 `run_in_background: true` 并挂 `sleep 7200` 保活 |
| 16 | `MODULE_NOT_FOUND`（node 找不到 playwright-core） | git-bash 下 `/c/Users/...` 被拼成 `c:\c\Users\...` | 用 `C:/Users/...` 风格路径；或设 `OPENCLAW_NODE_MODULES` 指向 `node_modules` 目录 |
| 17 | 担心脚本退出会关掉浏览器 / 丢草稿 | 误以为 `browser.close()` 关闭实例 | `connectOverCDP` 的 `close()` 只断开连接；草稿由知乎自动保存 |
| 18 | 旧脚本残留进程可能仍在打字 | 前一次卡死的子进程未随父进程退出 | 动新脚本前**采样两次 `bodyLen`**（间隔 3s）确认没有在增长 |

## 九、文件结构

```
zhihu-publish-skill/
├── SKILL.md                    ← 本文件
├── _meta.json
├── scripts/
│   ├── zhihu_publish_pw.js     ← 主脚本：填标题+正文+插图+发布/更新（playwright-core 直连 CDP）
│   ├── zhihu_probe.js          ← 状态探查：字数/图片数/块顺序/按钮文案
│   └── DEPENDENCIES.md         ← 运行依赖与关键事实
└── templates/
    ├── title.txt               ← 标题示例（单独文件）
    └── body_plain.txt          ← 正文模板（纯文本、段间空行、不含标题、无 # 标记）
```

**已删除**：`scripts/zhihu_drive.py`、`scripts/zhihu_publish.py`、`scripts/__pycache__/`
（agent-browser 路线，本机卡死）；`templates/zhihu_body.md`（含 `#` 标记，DraftJS 不可用）、
`templates/zhihu_body_plain.md`（首行含标题，与新脚本「标题单独传参」约定冲突，已由 `templates/title.txt` + `templates/body_plain.txt` 取代）。
需要历史版本：`git -C D:\skills\zhihu-publish-skill log --oneline` 后 `git show <commit>:<path>`。
