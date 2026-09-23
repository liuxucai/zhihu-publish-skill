#!/usr/bin/env node
/**
 * 知乎编辑器状态探查（调试用，只读不改）
 * ------------------------------------------------------------------
 * 排查「内容到底填进去没有 / 顺序对不对 / 图插没插上」时先跑它。
 *
 * 用法：
 *   node zhihu_probe.js                          # 检查当前 zhuanlan 页面
 *   node zhihu_probe.js --edit-url "<url>"       # 先打开指定页面再检查
 *   node zhihu_probe.js --watch 2                # 间隔 2s 采样两次，用于判断是否有残留进程仍在打字
 *
 * 环境变量：OPENCLAW_NODE_MODULES（含 playwright-core 的 node_modules 目录）
 */
"use strict";

const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    out[k] = a.includes("=") ? a.split("=").slice(1).join("=") : argv[++i];
  }
  return out;
}

function loadPlaywright() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const cands = [
    process.env.OPENCLAW_NODE_MODULES,
    process.env.PLAYWRIGHT_MODULES,
    home ? path.join(home, ".workbuddy/binaries/node/workspace/node_modules") : null,
  ].filter(Boolean);
  for (const c of cands) {
    try {
      return require(path.join(c.replace(/[\\/]+$/, ""), "playwright-core"));
    } catch (e) {}
  }
  try {
    return require("playwright-core");
  } catch (e) {}
  throw new Error("未找到 playwright-core，请设置 OPENCLAW_NODE_MODULES");
}

async function probe(page) {
  return page.evaluate(() => {
    const ce = document.querySelector(".DraftEditor-root [contenteditable=true]");
    const ta = document.querySelector("textarea[placeholder*='标题']");
    const imgs = document.querySelectorAll(".DraftEditor-root img, [contenteditable=true] img");
    const blocks = [
      ...document.querySelectorAll(".DraftEditor-root .public-DraftStyleDefault-block"),
    ];
    const btns = [...document.querySelectorAll("button")]
      .map((b) => (b.textContent || "").trim())
      .filter(Boolean);
    return {
      url: location.href,
      editorFound: !!ce,
      bodyLen: ce ? (ce.innerText || "").length : -1,
      titleLen: ta ? (ta.value || "").length : -1,
      imgCount: imgs.length,
      blockCount: blocks.length,
      blocks: blocks.map((b, i) => `${i}: ${(b.textContent || "").slice(0, 12)}`),
      actionBtns: btns.filter((t) => /发布|更新|插入图片/.test(t)).slice(0, 6),
    };
  });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cdp = String(args.cdp || process.env.ISOB_CDP_PORT || "9222");
  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("未找到浏览器上下文：请先用 launch.js 拉起隔离 Chrome");
  let page = ctx.pages().find((p) => p.url().includes("zhuanlan.zhihu.com"));
  if (!page) page = ctx.pages()[0];
  if (!page) throw new Error("没有任何打开的页面");
  if (args["edit-url"]) {
    await page.goto(args["edit-url"], { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".DraftEditor-root [contenteditable=true]", { timeout: 30000 });
    await page.waitForTimeout(4000);
  }
  const times = Number(args.watch || 1);
  for (let i = 0; i < times; i++) {
    if (i) await sleep(3000);
    const st = await probe(page);
    console.log(`--- 采样 ${i + 1} ---`);
    console.log(`url=${st.url}`);
    console.log(
      `bodyLen=${st.bodyLen} titleLen=${st.titleLen} imgCount=${st.imgCount} blocks=${st.blockCount}`
    );
    console.log(`块顺序: ${JSON.stringify(st.blocks)}`);
    console.log(`按钮: ${JSON.stringify(st.actionBtns)}`);
  }
  browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("[ERR]", e.message);
  process.exit(1);
});
