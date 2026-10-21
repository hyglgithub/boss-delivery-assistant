#!/usr/bin/env node
/**
 * 端到端测试：聊天页「仅新消息」的打招呼与交换卡片。
 *
 * 断言：
 *   - 打招呼列表第一行是网页已发出的招呼语：匹配时只发第二行及以后，第一行不重发
 *   - 最后一条我方消息与第一行不一致时，一条都不发，也不记账
 *   - 运行中按钮显示「停止聊天」且是红色
 *   - 交换卡片：默认不点「同意」；开启「自动同意交换」后才点一次
 *
 * 用法: node test/chat-greeting.test.js
 * 退出码: 0 = 通过, 1 = 失败
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(ROOT, "boss-quick-apply.user.js");
const CHAT_URL = "https://www.zhipin.com/web/geek/chat";

const FIXTURE = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BOSS直聘</title></head>
<body>
  <div class="user-list-content">
    <ul role="group">
      <li role="listitem" class="user-item">
        <div class="figure">头像</div>
        <div class="name-box"><span class="name-text">张三</span><span>测试公司</span></div>
        <div class="friend-content-warp">你好</div>
      </li>
    </ul>
  </div>
  <div class="position-name">后端开发工程师</div>
  <div class="chat-message">
    <ul class="im-list">
      <li class="message-item item-myself">
        <div class="text"><span class="text-content">您好，我是候选人</span></div>
      </li>
      <li class="message-item item-friend">
        <div class="text"><span>在吗</span></div>
        <div class="message-card-wrap"><button class="card-btn">同意</button></div>
      </li>
    </ul>
  </div>
  <div id="chat-input" contenteditable="true"></div>
  <button class="btn-send">发送</button>
<script>
(function () {
  window.__chatProbe = { sendClicks: 0, inputEvents: 0, figureClicks: 0, cardClicks: 0 };
  document.querySelector(".card-btn").addEventListener("click", function () {
    window.__chatProbe.cardClicks++;
  });
  document.querySelector(".btn-send").addEventListener("click", function () {
    window.__chatProbe.sendClicks++;
  });
  document.getElementById("chat-input").addEventListener("input", function () {
    window.__chatProbe.inputEvents++;
  });
  document.querySelector(".figure").addEventListener("click", function () {
    window.__chatProbe.figureClicks++;
  });
  window.__fixtureReady = document.querySelectorAll("ul[role='group'] li").length;
})();
</script>
</body>
</html>`;

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "✅" : "❌"} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
}

async function run(browser, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push("console: " + m.text());
  });

  await page.route(CHAT_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: FIXTURE }),
  );
  await page.goto(CHAT_URL, { waitUntil: "domcontentloaded" });

  // 最后一条我方消息 = 网页自动发出的打招呼语；场景可覆盖它来验证"不一致就不发"
  await page.evaluate((selfGreeting) => {
    const el = document.querySelector(".message-item.item-myself .text-content");
    if (el) el.textContent = selfGreeting;
  }, opts.selfGreeting || "您好，我是候选人");

  await page.evaluate((opts) => {
    localStorage.clear();
    localStorage.setItem("aiApiKey", "sk-test");
    localStorage.setItem("useAutoSendResume", "false");
    localStorage.setItem("useAutoSendImageResume", "false");
    localStorage.setItem("autoAcceptCard", String(!!opts.autoAcceptCard));
    localStorage.setItem(
      "greetingsList",
      JSON.stringify([
        { id: "1", content: "您好，我是候选人" },
        { id: "2", content: "期待和您聊聊" },
      ]),
    );
    // 让流程直接进入「已打过招呼 → 跟进」分支，从而走到交换卡片
    if (opts.seedSentGreetings) {
      localStorage.setItem("sentGreetingsHRs", JSON.stringify(["张三-测试公司"]));
    }

    window.GM_setValue = () => undefined;
    window.GM_getValue = () => undefined;
    window.GM_xmlhttpRequest = () => undefined;
  }, opts);

  await page.addScriptTag({ content: fs.readFileSync(SCRIPT_PATH, "utf8") });
  await page.waitForSelector("#boss-pro-panel", { timeout: 8000 });

  if (opts.switchMode) {
    await page.click(`label[for="communication-mode-${opts.switchMode}"]`);
    await page.waitForTimeout(120);
  }

  const modeState = await page.evaluate(() => ({
    newChecked: document.getElementById("communication-mode-new").checked,
    autoChecked: document.getElementById("communication-mode-auto").checked,
    newHelper: getComputedStyle(document.querySelector(".chat-mode-text.text-new")).display,
    autoHelper: getComputedStyle(document.querySelector(".chat-mode-text.text-auto")).display,
    saved: localStorage.getItem("communicationMode"),
    fixtureReady: window.__fixtureReady,
  }));

  if (opts.skipStart) {
    await page.close();
    return { pageErrors, modeState };
  }

  const title = await page.evaluate(
    () => (document.querySelector("#boss-pro-panel h3") || {}).textContent || "",
  );
  const hasStats = await page.evaluate(() => !!document.getElementById("boss-panel-stats"));

  const started = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("#boss-pro-panel button")).find((b) =>
      (b.textContent || "").includes("开始聊天"),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });

  await page.waitForTimeout(opts.waitMs || 3000);

  const state = await page.evaluate(() => {
    const control = Array.from(document.querySelectorAll("#boss-pro-panel button")).find((b) =>
      /^(开始聊天|停止聊天)$/.test((b.textContent || "").trim()),
    );
    return {
      log: (document.getElementById("pro-log") || {}).innerText || "",
      typed: (document.getElementById("chat-input") || {}).textContent || "",
      probe: window.__chatProbe || {},
      sentGreetings: localStorage.getItem("sentGreetingsHRs"),
      fixtureReady: window.__fixtureReady,
      hasKeywordInput: !!document.querySelector("#communication-include"),
      controlText: control ? control.textContent.trim() : "",
      controlBg: control ? getComputedStyle(control).backgroundColor : "",
    };
  });

  await page.close();
  return { title: title.trim(), hasStats, started, pageErrors, modeState, ...state };
}

async function main() {
  if (!fs.existsSync(SCRIPT_PATH)) {
    console.error(`找不到构建产物：${SCRIPT_PATH}\n请先运行 npm run build`);
    process.exit(1);
  }
  const browser = await chromium.launch();
  let r;
  let mode;
  let mismatch;
  let cardOff;
  let cardOn;
  try {
    r = await run(browser);
    // 分段控制器：点「自动轮询」后要落盘并切换说明文字
    mode = await run(browser, { switchMode: "auto", skipStart: true });
    // 最后一条我方消息不是网页发出的招呼语：脚本应当一条都不发
    mismatch = await run(browser, { selfGreeting: "这是另一句招呼语", waitMs: 3000 });
    // 交换卡片：「已打过招呼」的 HR 发来卡片，走到跟进分支
    cardOff = await run(browser, {
      autoAcceptCard: false,
      seedSentGreetings: true,
      waitMs: 2500,
    });
    cardOn = await run(browser, {
      autoAcceptCard: true,
      seedSentGreetings: true,
      waitMs: 2500,
    });
  } finally {
    await browser.close();
  }

  check("fixture 就绪（1 条会话）", r.fixtureReady === 1, `会话数 ${r.fixtureReady}`);
  check("点了「开始聊天」", r.started, "面板里没找到按钮");
  check("聊天页标题是「BOSS投递助手」", r.title === "BOSS投递助手", r.title);
  check("聊天页没有统计栏", !r.hasStats);
  check("面板上的「沟通岗位包含」输入框已移除", !r.hasKeywordInput);
  check(
    "沟通模式默认选中「仅新消息」",
    r.modeState.newChecked &&
      !r.modeState.autoChecked &&
      r.modeState.newHelper === "flex" &&
      r.modeState.autoHelper === "none",
    JSON.stringify(r.modeState),
  );
  check(
    "点「自动轮询」后落盘并切换说明文字",
    mode.modeState.autoChecked &&
      !mode.modeState.newChecked &&
      mode.modeState.saved === "auto" &&
      mode.modeState.autoHelper === "flex" &&
      mode.modeState.newHelper === "none",
    JSON.stringify(mode.modeState),
  );
  check("运行中按钮显示「停止聊天」", r.controlText === "停止聊天", r.controlText);
  check("运行中按钮是红色（与岗位页一致）", r.controlBg === "rgb(239, 68, 68)", r.controlBg);
  check("日志说明打招呼首行已匹配", r.log.includes("发送后续消息（1/1）：期待和您聊聊"), r.log);
  check(
    "网页已发的第一行没有被重复发送",
    r.typed === "期待和您聊聊" && r.probe.sendClicks === 1,
    `输入框「${r.typed}」｜点发送 ${r.probe.sendClicks} 次｜${r.log}`,
  );
  check(
    "发送后写入 sentGreetingsHRs",
    JSON.parse(r.sentGreetings || "[]").includes("张三-测试公司"),
    `sentGreetingsHRs = ${r.sentGreetings}`,
  );
  check("全程无未捕获错误", r.pageErrors.length === 0, r.pageErrors.join(" | "));

  // ——— 首行不一致：一条都不发 ———
  check(
    "首行不一致：日志说明了原因",
    mismatch.log.includes("最后一条我方消息与打招呼首行不一致"),
    mismatch.log,
  );
  check(
    "首行不一致：没有发送任何消息",
    !mismatch.typed && mismatch.probe.sendClicks === 0,
    `输入框「${mismatch.typed}」｜点发送 ${mismatch.probe.sendClicks} 次｜${mismatch.log}`,
  );
  check(
    "首行不一致：没有写 sentGreetingsHRs",
    !mismatch.sentGreetings,
    `sentGreetingsHRs = ${mismatch.sentGreetings}`,
  );
  check(
    "首行不一致：无未捕获错误",
    mismatch.pageErrors.length === 0,
    mismatch.pageErrors.join(" | "),
  );

  // ——— 交换联系方式卡片：默认不点，开关打开才点 ———
  check(
    "正常模式 + 开关关闭：不点「同意」",
    cardOff.probe.cardClicks === 0,
    `点了 ${cardOff.probe.cardClicks} 次`,
  );
  check(
    "正常模式 + 开关关闭：日志说明未自动点",
    cardOff.log.includes("未自动点「同意」"),
    cardOff.log,
  );
  check(
    "正常模式 + 开关打开：点一次「同意」",
    cardOn.probe.cardClicks === 1,
    `点了 ${cardOn.probe.cardClicks} 次`,
  );
  check(
    "交换卡片两个场景无未捕获错误",
    [...cardOff.pageErrors, ...cardOn.pageErrors].length === 0,
    [...cardOff.pageErrors, ...cardOn.pageErrors].join(" | "),
  );

  const failed = results.filter((x) => !x.passed).length;
  if (failed) {
    console.error(`\n聊天页打招呼测试失败：${failed}/${results.length} 项未通过`);
    process.exit(1);
  }
  console.log(`\n聊天页打招呼测试通过（${results.length}/${results.length}）`);
}

main();
