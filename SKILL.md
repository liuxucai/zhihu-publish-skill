---
name: zhihu-publisher
description: |
  知乎文章自动发布技能。通过 xbrowser 控制 Chrome 浏览器完成知乎登录、撰写和发布文章的全流程。
  触发词：发布知乎、知乎文章、zhihu publish、发知乎文章、知乎发文章。
  依赖：xbrowser skill（--browser chrome）。
---

# 知乎文章自动发布

## 依赖

- xbrowser skill，xb 路径：`D:\QClaw\resources\openclaw\config\skills\xbrowser\scripts\xb.cjs`
- Chrome 浏览器（`--browser chrome`），**禁止使用 cft/edge**（ref 失效 bug）

## 文章要求

- 目标字数：**1500 字**（含标点），下限 1200，上限 1800

## 流程一：登录（仅需一次）

### 1. 打开登录页
```bash
node xb.cjs run --browser chrome --headed open https://www.zhihu.com/signin
```

### 2. 切换密码登录
```bash
node xb.cjs run --browser chrome -- find role button click --name 密码登录
```

### 3. 获取 ref 并填写凭据
```bash
node xb.cjs run --browser chrome -- batch --bail "wait --load networkidle" "snapshot -i"
```
记录 textbox ref（通常账号 `@e39`、密码 `@e40`、登录按钮 `@e12`），然后：
```bash
node xb.cjs run --browser chrome -- batch --bail "fill @e39 <账号>" "fill @e40 <密码>" "click @e12"
```
> ⚠️ 账号密码通过用户输入获取，**禁止写死到文件中**。

### 4. 验证
- 如触发滑块验证码：URL 停留 `/signin`，需用户**手动拖动滑块**完成验证
- 登录成功：URL 变为 `https://www.zhihu.com/`

## 流程二：发布文章

### 1. 打开编辑器
```bash
node xb.cjs run --browser chrome --headed open https://zhuanlan.zhihu.com/write
node xb.cjs run --browser chrome -- batch --bail "wait --load networkidle" "snapshot -i"
```

### 2. 填标题
```bash
node xb.cjs run --browser chrome -- batch --bail "click @e25" "fill @e25 <标题>"
```

### 3. 填正文（长文本用 JS 插入）
> ❌ 直接 `fill` 长文本（>500字符）会被命令行截断；`fill` 中的 `\n` 会变成普通字符。
>
> ❌ 多次 `eval execCommand('insertText')` 分段插入会导致重复内容（前一次插入的文本不会自动清除，再次执行时追加在现有内容末尾）。
>
> ✅ **推荐：用 eval 一次性通过 base64 解码后插入**，一次写入完整正文，避免重复。

#### 方案 A（推荐）：base64 解码一次性插入

先在本地生成 base64 编码的文章正文：
```bash
# PowerShell
$article = @"
# 第1部分标题

正文内容...

## 第2部分标题

更多正文内容...
"@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($article))
```

然后通过 eval 在浏览器端解码并插入编辑器：
```bash
node xb.cjs run --browser chrome -- eval "
  var ed = document.querySelector('.DraftEditor-root [contenteditable=true]');
  if(!ed) ed = document.querySelector('[role=textbox]');
  ed.focus();
  var text = atob('<base64编码的正文>');
  // 替换编辑器现有内容
  ed.innerHTML = text.replace(/\n/g, '<br>');
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, text);
"
```
> ⚠️ base64 编码要用 `[Convert]::ToBase64String` 做 UTF-8 base64，浏览器端用 `atob()` 解码。atob 对中文 base64 解码后再 `execCommand('insertText')` 即可正确渲染。

#### 方案 B（备用）：逐段 eval 插入
> 仅在正文较短（<1500 字符）时使用。单次 eval 命令中写入完整段落，不要多次调用。

```bash
node xb.cjs run --browser chrome -- eval "
  document.querySelector('.DraftEditor-root [role=textbox]').focus();
  document.execCommand('insertText', false, '第1段...');
  document.execCommand('insertText', false, '\n\n## 标题');
  document.execCommand('insertText', false, '\n\n第2段...');
"
```

### 4. 智能排版
```bash
node xb.cjs run --browser chrome -- batch --bail "snapshot -i" "click @e48"
```
> `@e48` 为创作助手面板中的「智能排版」按钮（name 含"智能排版自动修正空格"），实际 ref 以 snapshot 为准。

### 5. 发布
```bash
node xb.cjs run --browser chrome -- batch --bail "snapshot -i" "click @e37" "wait --load networkidle"
```
成功标志：URL 变为 `https://zhuanlan.zhihu.com/p/<ID>`，出现发布成功弹窗。

### 6. 处理翻译模态框干扰
> 编辑器页面打开后，可能会在右下角自动弹出「翻译」模态框，遮盖下方的发布按钮。

**不要尝试点击关闭按钮**（@e29, @e20 等经常无效或反复弹出）。**推荐用 eval 直接移除 DOM 元素**：

```bash
# 方式一：直接移除模态框 DOM（推荐）
node xb.cjs run --browser chrome -- eval "document.querySelectorAll('.Modal-wrapper,.Modal-backdrop').forEach(function(e){e.remove()});document.body.style.overflow='';document.body.style.pointerEvents='';'modal-closed'"
```
> ⚠️ PowerShell 中对 eval 传入含 `()` 和 `=>` 的 JS 代码会报语法错误，因为 `()` 被 PowerShell 解释为命令调用。
> **解决方案**：用 `function(){}` 替代箭头函数，或者将 eval 代码写入临时 .ps1 文件执行。

#### PowerShell 转义问题总结

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| `( )` 解析错误 | PowerShell 将括号视为方法调用起始 | 用 `` `() `` 反引号转义，或用 `function` 替代箭头，或写入临时脚本文件 |
| `=>` 箭头函数报错 | PowerShell 将 `>` 视为重定向 | 用 `function(e){}` 替代 `e=>{}` |
| 引号嵌套冲突 | 外层双引号与内层单引号的转义链 | 用临时 .ps1 文件 + 变量传递，完全绕过命令行解析 |
| eval 代码含中文 | xb CLI 传递的是 UTF-8 但 PowerShell 解析时可能乱码 | 也用临时脚本文件解决 |

**推荐做法**：当 eval 代码较长或含特殊字符时，写入临时 .ps1：

```powershell
# write-eval.ps1
$evalCode = @"
document.querySelectorAll('.Modal-wrapper,.Modal-backdrop').forEach(function(e){e.remove()});
document.body.style.overflow='';
'modal-closed'
"@
node $xb run --browser chrome -- eval $evalCode
```

## 核心规则

| 规则 | 说明 |
|------|------|
| ref 必须每次刷新 | 每步操作前 `snapshot -i`，ref 只在同一 batch 内有效 |
| 禁止跨 batch 用 ref | batch 之间 ref 编号会重新生成 |
| 长文本用 base64 一次性插入 | 推荐用 base64 编码 + `atob()` 解码一次性写入，避免多次 `execCommand('insertText')` 导致内容重复 |
| 避免多次 eval insertText | 多次调用会在当前内容末尾追加，导致同一段内容重复出现 |
| 正文后必须排版 | 插入完成后点击「智能排版」修复换行和标点 |
| 翻译模态框要移除而非关闭 | 用 `eval` 移除 `.Modal-wrapper` DOM 元素，点击关闭按钮通常无效 |
| 全程用 chrome | cft/edge 有 ref 失效 bug，`--browser chrome` 是唯一可靠选项 |
| PowerShell eval 要转义 | `()`、`=>`、引号嵌套用临时脚本文件解决，避免直接在命令行拼 JS |
| 确认发布成功 | snapshot 中 URL 从 `/edit` 变为 `/p/<ID>`，出现文章详情页的评论/收藏/分享按钮 |
