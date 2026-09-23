#!/usr/bin/env node
/**
 * 知乎文章发布 / 更新（playwright-core 直连 CDP · v2）
 * ------------------------------------------------------------------
 * 为什么不用 agent-browser CLI：本机实测其 keyboard type 卡死（13 分钟只打入 1 字），
 * 故全流程改为 playwright-core connectOverCDP 直连隔离 Chrome。
 *
 * 用法：
 *   node zhihu_publish_pw.js --title "标题" --body body.txt [选项]
 *
 * 必需：
 *   --title <str>        标题（与 --title-file 二选一）
 *   --title-file <path>  标题文件（UTF-8，单行）
 *   --body <path>        纯正文文件：段间空一行，不含标题，不用 # 标记
 *
 * 可选：
 *   --image <path>       正文配图
 *   --image-at <N>       配图插在第 N 段之后（1-based）；有 --image 但不给则插在中间
 *   --edit-url <url>     改为编辑已发布文章（https://zhuanlan.zhihu.com/p/<ID>/edit），
 *                        提交按钮自动识别为「更新」
 *   --publish            真正提交；不带则只填稿并截图，停在提交前
 *   --preview <path>     截图输出路径（默认 <脚本目录>/zhihu_preview.png）
 *   --cdp <port>         CDP 端口（默认 9222 或环境变量 ISOB_CDP_PORT）
 *   --restore-ms <ms>    进入编辑器后等待草稿恢复的时间（默认 4000，勿调小）
 *
 * 环境变量：
 *   OPENCLAW_NODE_MODULES  含 playwright-core 的 node_modules 目录
 *                          （本机：C:/Users/<user>/.workbuddy/binaries/node/workspace/node_modules）
 *
 * 前置：隔离 Chrome 已拉起（isolated-browser/scripts/launch.js），知乎登录态有效。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const USAGE = fs
  .readFileSync(__filename, "utf-8")
  .split("*/")[0]
  .replace(/^[\s\S]*?\/\*\*?/, "")
  .replace(/^\s*\*?/gm, "")
  .trim();

const WRITE_URL = "https://zhuanlan.zhihu.com/write";
const ARTICLE_URL_RE = /zhuanlan\.zhihu\.com\/p\/\d+\/?$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 工具 ----------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    if (["publish", "dry-run", "help"].includes(k)) {
      out[k] = true;
      continue;
    }
    out[k] = argv[++i];
  }
  return out;
}

function loadPlaywright() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const cands = [
    process.env.OPENCLAW_NODE_MODULES,
    process.env.PLAYWRIGHT_MODULES,
    home && path.posix
      ? path.join(home, ".workbuddy/binaries/node/workspace/node_modules")
      : null,
  ].filter(Boolean);
  for (const c of cands) {
    try {
      return require(path.join(c.replace(/[\\/]+$/, ""), "playwright-core"));
    } catch (e) {
      /* try next */
    }
  }
  try {
    return require("playwright-core");
  } catch (e) {
    /* fallthrough */
  }
  throw new Error(
    "未找到 playwright-core。请设置 OPENCLAW_NODE_MODULES 指向含 playwright-core 的 node_modules 目录"
  );
}

function readText(p, label) {
  if (!p) throw new Error(`缺少 ${label}`);
  return fs.readFileSync(p, "utf-8").trim();
}

function toParagraphs(txt) {
  const paras = txt
    .split(/\r?\n\s*\r?\n/)
    .map((s) => s.replace(/\s+$/, "").trim())
    .filter(Boolean);
  const bad = paras.filter((p) => /^#{1,6}\s/.test(p));
  if (bad.length) {
    console.warn(
      `[WARN] 有 ${bad.length} 段以 # 开头，会触发「Markdown 语法输入中」导致字数不计入，建议去掉`
    );
  }
  return paras;
}

async function bodyLen(page) {
  return page.evaluate(
    () =>
      (document.querySelector(".DraftEditor-root [contenteditable=true]")?.innerText || "")
        .length
  );
}

async function snapshotState(page) {
  return page.evaluate(() => {
    const ce = document.querySelector(".DraftEditor-root [contenteditable=true]");
    const ta = document.querySelector("textarea[placeholder*='标题']");
    const imgs = document.querySelectorAll(
      ".DraftEditor-root img, [contenteditable=true] img"
    );
    const blocks = [
      ...document.querySelectorAll(".DraftEditor-root .public-DraftStyleDefault-block"),
    ];
    const btns = [...document.querySelectorAll("button")]
      .map((b) => (b.textContent || "").trim())
      .filter(Boolean);
    return {
      url: location.href,
      bodyLen: ce ? (ce.innerText || "").length : -1,
      titleLen: ta ? (ta.value || "").length : -1,
      imgCount: imgs.length,
      blockCount: blocks.length,
      blocks: blocks.map((b) => (b.textContent || "").slice(0, 8)),
      pubBtns: btns.filter((t) => /发布|更新/.test(t)).slice(0, 5),
    };
  });
}

// ---------------- 主流程 ----------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.body) throw new Error("缺少 --body（纯正文文件，段间空行）");
  const TITLE = (args.title || (args["title-file"] ? readText(args["title-file"], "--title-file") : ""))
    .replace(/^#+\s*/, "")
    .trim();
  if (!TITLE) throw new Error("缺少 --title 或 --title-file");
  const PARAS = toParagraphs(readText(args.body, "--body"));
  const IMAGE = args.image ? path.resolve(args.image) : null;
  const CDP = String(args.cdp || process.env.ISOB_CDP_PORT || "9222");
  const RESTORE_MS = Number(args["restore-ms"] || 4000);
  const PREVIEW = args.preview || path.join(__dirname, "zhihu_preview.png");
  const TARGET = args["edit-url"] || WRITE_URL;
  const DO_PUBLISH = !!args.publish && !args["dry-run"];
  let imageAt = null;
  if (IMAGE) {
    imageAt = args["image-at"] ? Number(args["image-at"]) : Math.floor(PARAS.length / 2);
    if (!fs.existsSync(IMAGE)) throw new Error(`配图不存在: ${IMAGE}`);
    if (imageAt < 1 || imageAt > PARAS.length)
      throw new Error(`--image-at 越界: ${imageAt}（共 ${PARAS.length} 段）`);
  }

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("未找到浏览器上下文：请先用 launch.js 拉起隔离 Chrome");
  let page = ctx.pages().find((p) => p.url().includes("zhuanlan.zhihu.com"));
  if (!page) page = await ctx.newPage();

  console.log(`[1/8] 打开 ${TARGET}`);
  await page.goto(TARGET, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".DraftEditor-root [contenteditable=true]", { timeout: 30000 });
  await page.waitForTimeout(RESTORE_MS); // ⭐ 必须等草稿恢复，否则段落乱序
  const editor = page.locator(".DraftEditor-root [contenteditable=true]").first();

  console.log("[2/8] 清空正文");
  await editor.click();
  await page.keyboard.press("Control+a");
  await sleep(300);
  await page.keyboard.press("Delete");
  await sleep(1200);
  let len = await bodyLen(page);
  if (len > 5) {
    console.log(`[2/8] 清空不彻底(${len})，重试一次`);
    await editor.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await sleep(1200);
    len = await bodyLen(page);
  }
  console.log(`[2/8] 清空后 bodyLen=${len}`);

  console.log("[3/8] 填标题");
  const titleBox = page.locator("textarea[placeholder*='标题'], textarea").first();
  await titleBox.click();
  await titleBox.fill("");
  await page.keyboard.type(TITLE, { delay: 15 });
  await sleep(500);

  console.log(`[4/8] 逐段输入正文（${PARAS.length} 段${IMAGE ? `，第 ${imageAt} 段后插图` : ""}）`);
  for (let i = 0; i < PARAS.length; i++) {
    await editor.focus();
    await page.keyboard.type(PARAS[i], { delay: 10 });
    await sleep(350);
    if (IMAGE && i + 1 === imageAt) {
      await page.keyboard.press("End");
      await sleep(200);
      await page.keyboard.press("Enter");
      await sleep(300);
      await insertImageWithRetry(page, IMAGE, 3);
    } else if (i < PARAS.length - 1) {
      await page.keyboard.press("Enter");
      await sleep(300);
    }
  }
  await sleep(2000);

  console.log("[5/8] 校验");
  const st = await snapshotState(page);
  console.log(`      bodyLen=${st.bodyLen} titleLen=${st.titleLen} imgCount=${st.imgCount} blocks=${st.blockCount}`);
  console.log(`      块顺序: ${JSON.stringify(st.blocks)}`);
  const expectFirst = PARAS[0].slice(0, 8);
  if (st.blocks[0] !== expectFirst) {
    console.warn(
      `[WARN] 首块(${st.blocks[0]}) != 正文首段(${expectFirst}) —— 可能乱序，建议用 --edit-url 重跑`
    );
  }
  if (IMAGE && st.imgCount === 0) console.warn("[WARN] 正文未检测到配图");

  console.log("[6/8] 截图");
  await page.screenshot({ path: PREVIEW });
  console.log(`      ${PREVIEW}`);

  if (!DO_PUBLISH) {
    console.log("[7/8] 未带 --publish：已停在提交前，请查看截图后加 --publish 重跑");
    return 0;
  }

  console.log("[7/8] 提交（发布/更新）");
  const submit = page.getByRole("button", { name: /^(发布|更新)$/ }).first();
  await submit.click();
  await sleep(3000);
  const confirm = page.getByRole("button", { name: /^(发布|更新|确定)$/ });
  if ((await confirm.count()) > 1) {
    await confirm.last().click();
    await sleep(2000);
  }
  await page.waitForURL(ARTICLE_URL_RE, { timeout: 60000 }).catch(() => {});
  await sleep(2000);
  console.log("[8/8] FINAL_URL:", page.url());
  await page.screenshot({ path: PREVIEW });
  if (!ARTICLE_URL_RE.test(page.url())) {
    console.warn("[WARN] URL 未跳转到文章页，可能未提交成功，请查看截图");
    return 4;
  }
  console.log("[OK] 发布/更新成功");
  return 0;

  // ---- 配图：上传 + 点「插入图片」确认键（缩略图出现后再等 3s）----
  async function insertImageWithRetry(pg, img, maxRetry) {
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      console.log(`[图片] 尝试 ${attempt}/${maxRetry}`);
      await pg.evaluate(() =>
        document.querySelector(".DraftEditor-root [contenteditable=true]").focus()
      );
      await sleep(300);
      await pg.getByRole("button", { name: "图片", exact: true }).first().click();
      await sleep(2500);
      await pg.locator("input[accept='image/*']").first().setInputFiles(img);
      let clicked = false;
      for (let k = 0; k < 15; k++) {
        await sleep(1500);
        const ready = await pg.evaluate(() => {
          const dlg = document.querySelector(
            ".Modal-wrapper, [class*=Modal], [class*=modal]"
          );
          const dimgs = dlg ? dlg.querySelectorAll("img").length : 0;
          const btn = [...document.querySelectorAll("button")].find(
            (b) => (b.textContent || "").trim() === "插入图片"
          );
          return { dimgs, has: !!btn, dis: btn ? btn.disabled : null };
        });
        if (ready.dimgs > 0 && ready.has && !ready.dis) {
          await sleep(3000); // ⭐ 等后端上传完成，过早点击会静默失败
          await pg.getByRole("button", { name: "插入图片", exact: true }).first().click();
          console.log("[图片] 已点「插入图片」");
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        await pg.keyboard.press("Escape").catch(() => {});
        await sleep(1000);
        continue;
      }
      for (let k = 0; k < 10; k++) {
        await sleep(2000);
        const n = await pg.evaluate(
          () =>
            document.querySelectorAll(".DraftEditor-root img, [contenteditable=true] img")
              .length
        );
        if (n > 0) {
          console.log(`[图片] 成功，正文 img 数=${n}`);
          return true;
        }
      }
      await pg.keyboard.press("Escape").catch(() => {});
      await sleep(1000);
    }
    console.warn("[图片][WARN] 多次尝试仍未插入，文章将不带配图");
    return false;
  }
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error("[ERR]", e.message);
    process.exit(1);
  });
