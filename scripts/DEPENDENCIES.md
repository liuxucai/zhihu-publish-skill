# 依赖与环境说明（zhihu-publish-skill 配图支持）

## 运行依赖
1. isolated-browser skill 拉起的隔离 Chrome（CDP 默认 9222），已手动登录知乎。
2. agent-browser CLI 在 PATH（本机为 npm-global 下 agent-browser.cmd shim，实际二进制
   ~/.qclaw/tools/xbrowser/node_modules/agent-browser/bin/agent-browser.js）。
   zhihu_drive.py 里 AB = "agent-browser.cmd"，请确认该命令在 PATH 可解析；
   若不可，可改为完整路径或设置环境变量。
3. Python 3.11+（subprocess 调 agent-browser）。

## 关键事实（来自实操）
- 知乎正文为 DraftJS 编辑器：填正文必须「分段 keyboard type + 段间真实 Enter」，
  且每段 type 前需 eval .focus() 正文，否则段落不拆块。
- 配图：点工具栏「图片」按钮 -> 上传到 input[accept='image/*'] -> 必须再点弹层
  「插入图片」确认键，图片才进正文（upload 仅入队列，不等同插入）。
- 「插入图片」按钮 ref 每次刷新且有渲染延迟，脚本内已做 8 次重试查找。
- 中间插图：第 N 段 type 完后 press End + Enter 再触发插图；勿用 Control+Home（会插到开头）。
