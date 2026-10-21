#!/usr/bin/env node
/**
 * 端到端测试：聊天页「自动轮询」。
 *
 * 为什么需要它：
 *   旧的「自动轮询」只是在会话列表上随机滚动 3-5 次，不点开、不遍历、不保证加载到谁。
 *   现在改成读页面全局 chatStore.friendInfos：
 *     - 用 uid 做稳定身份；
 *     - 启动时按 chatStore.friends 的顺序做一次快照；
 *     - 从第一条到底部逐条打开、处理，每条只走一次，到尾部自动停止。
 *
 * 断言：
 *   - 按顺序打开全部会话，但只有「最后一条我方消息 == 打招呼列表首行」
 *     的会话才发送后续消息，不一致的不发也不记账；
 *   - 没有自动发送功能时仍然打开全部会话，但不发消息；
 *   - 到尾部自动停止（按钮恢复「开始聊天」）。
 *
 * 用法: node test/chat-auto-poll.test.js
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
      <li role="listitem" data-uid="1001">
        <div class="friend-content selected">
          <div class="figure"><img class="image-circle" alt=""></div>
          <div class="text">
            <div><span class="time">10:00</span></div>
            <div class="title-box">
              <span class="name-box">
                <span class="name-text">张三</span>
                <span>测试公司</span>
              </span>
            </div>
            <div class="gray last-msg"><span class="last-msg-text">你好</span></div>
          </div>
        </div>
      </li>
      <li role="listitem" data-uid="1002">
        <div class="friend-content">
          <div class="figure">
            <span class="notice-badge">2</span>
            <img class="image-circle" alt="">
          </div>
          <div class="text">
            <div><span class="time">11:00</span></div>
            <div class="title-box">
              <span class="name-box">
                <span class="name-text">李四</span>
                <span>另一公司</span>
              </span>
            </div>
            <div class="gray last-msg"><span class="last-msg-text">方便发一份简历吗</span></div>
          </div>
        </div>
      </li>
      <li role="listitem" data-uid="1003">
        <div class="friend-content">
          <div class="figure"><img class="image-circle" alt=""></div>
          <div class="text">
            <div><span class="time">09:00</span></div>
            <div class="title-box">
              <span class="name-box">
                <span class="name-text">王五</span>
                <span>旧公司</span>
              </span>
            </div>
            <div class="gray last-msg"><span class="last-msg-text">在吗</span></div>
          </div>
        </div>
      </li>
    </ul>
  </div>

  <div class="position-name">后端开发工程师</div>
  <div class="chat-message">
    <ul class="im-list">
      <li class="message-item item-myself" data-mid="m0">
        <div class="message-content"><div class="text"><p><span class="text-content">您好，我是候选人</span></p></div></div>
      </li>
      <li class="message-item item-friend" data-mid="m1">
        <div class="message-content"><div class="text"><p><span class="text-content">你好</span></p></div></div>
      </li>
    </ul>
  </div>
  <div id="chat-input" contenteditable="true"></div>
  <button class="btn-send">发送</button>
<script>
(function () {
  window.__chatProbe = { sendClicks: 0, inputEvents: 0, convClicks: {}, scrolls: 0 };

  document.querySelector(".btn-send").addEventListener("click", function () {
    window.__chatProbe.sendClicks++;
  });
  document.getElementById("chat-input").addEventListener("input", function () {
    window.__chatProbe.inputEvents++;
  });
  document.querySelector(".user-list-content").addEventListener("scroll", function () {
    window.__chatProbe.scrolls++;
  });

  var conversations = {
    "1001": {
      job: "后端开发工程师",
      msgs:
        '<li class="message-item item-myself" data-mid="m0"><div class="message-content"><div class="text"><p><span class="text-content">您好，我是候选人</span></p></div></div></li>' +
        '<li class="message-item item-friend" data-mid="m1"><div class="message-content"><div class="text"><p><span class="text-content">你好</span></p></div></div></li>'
    },
    "1002": {
      job: "后端开发工程师",
      // 最后一条我方消息不是网页发出的招呼语：首行不匹配，脚本应当不发送
      msgs:
        '<li class="message-item item-myself" data-mid="m2s"><div class="message-content"><div class="text"><p><span class="text-content">这是不匹配的招呼语</span></p></div></div></li>' +
        '<li class="message-item item-friend" data-mid="m2"><div class="message-content"><div class="text"><p><span class="text-content">方便发一份简历吗</span></p></div></div></li>'
    },
    "1003": {
      job: "销售代表",
      msgs:
        '<li class="message-item item-myself" data-mid="m3s"><div class="message-content"><div class="text"><p><span class="text-content">您好，我是候选人</span></p></div></div></li>' +
        '<li class="message-item item-friend" data-mid="m3"><div class="message-content"><div class="text"><p><span class="text-content">在吗</span></p></div></div></li>'
    }
  };

  document.querySelectorAll(".friend-content").forEach(function (fc) {
    fc.addEventListener("click", function () {
      var li = fc.closest("li");
      var uid = li.getAttribute("data-uid");
      window.__chatProbe.convClicks[uid] = (window.__chatProbe.convClicks[uid] || 0) + 1;

      // 已经选中的会话再点一次不一定触发重渲染（真实页面也是这样），
      // 用来验证 waitForConversationSwitch 不强制要求 .chat-message 被替换。
      if (fc.classList.contains("selected")) return;

      document.querySelectorAll(".friend-content").forEach(function (x) {
        x.classList.remove("selected");
      });
      fc.classList.add("selected");

      var conv = conversations[uid] || { job: "", msgs: "" };
      var position = document.querySelector(".position-name");
      if (position) position.textContent = conv.job;

      // 探测报告：BOSS 切换会话时会整体替换 .chat-message，这里如实模拟
      var old = document.querySelector(".chat-message");
      var fresh = document.createElement("div");
      fresh.className = "chat-message";
      fresh.innerHTML = '<ul class="im-list">' + conv.msgs + "</ul>";
      old.replaceWith(fresh);
    });
  });

  // 来自 zhipin-chat-probe.md 的字段子集（脱敏）
  window.chatStore = {
    friends: [1001, 1002, 1003],
    friendInfos: {
      "1001-0": {
        uid: 1001,
        encryptBossId: "boss-1001",
        securityId: "sec-1001",
        name: "张三",
        brandName: "测试公司",
        jobName: "后端开发工程师",
        lastText: "你好",
        lastTS: 100,
        lastMsgId: "m1",
        unreadCount: 0,
        lastIsSelf: true
      },
      "1002-0": {
        uid: 1002,
        encryptBossId: "boss-1002",
        securityId: "sec-1002",
        name: "李四",
        brandName: "另一公司",
        lastText: "方便发一份简历吗",
        lastTS: 200,
        lastMsgId: "m2",
        unreadCount: 2,
        lastIsSelf: false
      },
      "1003-0": {
        uid: 1003,
        encryptBossId: "boss-1003",
        securityId: "sec-1003",
        name: "王五",
        brandName: "旧公司",
        jobName: "销售代表",
        lastText: "在吗",
        lastTS: 50,
        lastMsgId: "m3",
        unreadCount: 0,
        lastIsSelf: false
      }
    }
  };

  window.__fixtureReady = document.querySelectorAll(".user-list-content li[role='listitem']").length;
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

  await page.evaluate((opts) => {
    localStorage.clear();
    localStorage.setItem("aiApiKey", "sk-test");
    localStorage.setItem("useAutoSendResume", String(!!opts.useAutoSendResume));
    localStorage.setItem("useAutoSendImageResume", "false");
    localStorage.setItem("communicationMode", "auto");
    localStorage.setItem(
      "greetingsList",
      JSON.stringify([
        { id: "1", content: "您好，我是候选人" },
        { id: "2", content: "期待和您聊聊" },
      ]),
    );
    if (opts.sentGreetings) {
      localStorage.setItem("sentGreetingsHRs", JSON.stringify(opts.sentGreetings));
    }
    if (opts.sentResumes) {
      localStorage.setItem("sentResumeHRs", JSON.stringify(opts.sentResumes));
    }
    if (opts.sentImageResumes) {
      localStorage.setItem("sentImageResumeHRs", JSON.stringify(opts.sentImageResumes));
    }

    window.GM_setValue = () => undefined;
    window.GM_getValue = () => undefined;
    window.GM_xmlhttpRequest = () => undefined;
  }, opts);

  await page.addScriptTag({ content: fs.readFileSync(SCRIPT_PATH, "utf8") });
  await page.waitForSelector("#boss-pro-panel", { timeout: 8000 });

  const started = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("#boss-pro-panel button")).find((b) =>
      (b.textContent || "").includes("开始聊天"),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });

  await page.waitForTimeout(opts.waitMs || 3500);

  const state = await page.evaluate(() => ({
    log: (document.getElementById("pro-log") || {}).innerText || "",
    probe: window.__chatProbe || {},
    sentGreetings: localStorage.getItem("sentGreetingsHRs"),
    selected:
      (document.querySelector(".friend-content.selected .name-text") || {}).textContent || "",
    controlText:
      Array.from(document.querySelectorAll("#boss-pro-panel button"))
        .map((b) => (b.textContent || "").trim())
        .find((t) => t === "开始聊天" || t.includes("停止")) || "",
    fixtureReady: window.__fixtureReady,
  }));

  await page.close();
  return { started, pageErrors, ...state };
}

async function main() {
  if (!fs.existsSync(SCRIPT_PATH)) {
    console.error(`找不到构建产物：${SCRIPT_PATH}\n请先运行 npm run build`);
    process.exit(1);
  }

  const browser = await chromium.launch();
  let normal;
  let noop;
  try {
    // 从头到尾打开全部 3 个会话；只有首行匹配的才发后续消息
    normal = await run(browser, {
      useAutoSendResume: false,
      waitMs: 8000,
    });

    // 全部会话都已打过招呼、两本简历账都齐、没有任何自动发送功能：
    // 仍然按要求把 3 个会话都打开，但不应该发消息。
    noop = await run(browser, {
      useAutoSendResume: false,
      sentGreetings: ["uid:1002", "uid:1003", "张三-测试公司"],
      sentResumes: ["uid:1002", "uid:1003", "张三-测试公司"],
      sentImageResumes: ["uid:1002", "uid:1003", "张三-测试公司"],
      waitMs: 6000,
    });
  } finally {
    await browser.close();
  }

  check("fixture 就绪（3 条会话）", normal.fixtureReady === 3, `会话数 ${normal.fixtureReady}`);
  check("点了「开始聊天」", normal.started, "面板里没找到按钮");

  // ——— 从头到尾打开全部会话 ———
  check(
    "normal：三个会话都按顺序打开",
    normal.probe.convClicks["1001"] === 1 &&
      normal.probe.convClicks["1002"] === 1 &&
      normal.probe.convClicks["1003"] === 1,
    JSON.stringify(normal.probe.convClicks),
  );
  check("normal：没有打开超时", !normal.log.includes("打开会话超时"), normal.log);
  check(
    "normal：张三首行匹配，发送后续消息",
    normal.log.includes("首次沟通: 张三 / 测试公司") &&
      normal.log.includes("发送后续消息（1/1）：期待和您聊聊"),
    normal.log,
  );
  check(
    "normal：李四首行不匹配，没有发送",
    normal.log.includes("最后一条我方消息与打招呼首行不一致") &&
      normal.log.includes("首次沟通: 李四 / 另一公司"),
    normal.log,
  );
  check(
    "normal：王五首行匹配，发送后续消息",
    normal.log.includes("首次沟通: 王五 / 旧公司") &&
      normal.log.includes("发送后续消息（1/1）：期待和您聊聊"),
    normal.log,
  );
  check(
    "normal：只发了首行匹配的那两个会话",
    normal.probe.sendClicks === 2,
    `点发送 ${normal.probe.sendClicks} 次`,
  );
  check("normal：没有滚动会话列表", normal.probe.scrolls === 0, `滚动 ${normal.probe.scrolls} 次`);
  check(
    "normal：sentGreetingsHRs 只写入首行匹配的稳定 uid",
    ["uid:1001", "uid:1003"].every((k) => JSON.parse(normal.sentGreetings || "[]").includes(k)) &&
      !JSON.parse(normal.sentGreetings || "[]").includes("uid:1002"),
    normal.sentGreetings,
  );
  check(
    "normal：走到尾部自动停止",
    normal.log.includes("自动轮询完成：已遍历 3/3 个会话") && normal.controlText === "开始聊天",
    `${normal.controlText}｜${normal.log.slice(-200)}`,
  );
  check("normal：无未捕获错误", normal.pageErrors.length === 0, normal.pageErrors.join(" | "));

  // ——— 没有自动发送功能：仍然全量打开，但不发消息 ———
  check(
    "noop：三个会话仍然都打开",
    noop.probe.convClicks["1001"] === 1 &&
      noop.probe.convClicks["1002"] === 1 &&
      noop.probe.convClicks["1003"] === 1,
    JSON.stringify(noop.probe.convClicks),
  );
  check("noop：没有发送消息", noop.probe.sendClicks === 0, `点发送 ${noop.probe.sendClicks} 次`);
  check(
    "noop：走到尾部自动停止",
    noop.log.includes("自动轮询完成：已遍历 3/3 个会话") && noop.controlText === "开始聊天",
    `${noop.controlText}｜${noop.log.slice(-200)}`,
  );
  check("noop：无未捕获错误", noop.pageErrors.length === 0, noop.pageErrors.join(" | "));

  const failed = results.filter((x) => !x.passed).length;
  if (failed) {
    console.error(`\n聊天页自动轮询测试失败：${failed}/${results.length} 项未通过`);
    process.exit(1);
  }
  console.log(`\n聊天页自动轮询测试通过（${results.length}/${results.length}）`);
}

main();
