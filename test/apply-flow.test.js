#!/usr/bin/env node
/**
 * 端到端测试：点卡片 → 抓岗位要求 → 交给（桩）AI 判定 → 投递。
 *
 * 为什么需要它：
 *   线上真实故障是「详情区选择器全部落空 → 抓不到岗位要求 → AI 全部回"信息不足"」，
 *   48 个岗位一个没投出去。而当时验证用的 fixture 里写着**和源码一模一样的 class 名**，
 *   于是测试全绿、线上全挂 —— 那种测试只是把我的假设又念了一遍。
 *
 *   所以这里的详情区故意用**随机 class 名**，连「职位描述」小标题都不给（plain 模式），
 *   逼代码去走接口 / 语义锚点 / 视口右半屏这些不依赖 class 的兜底路径。
 *
 * 覆盖：
 *   - api:    detail.json 有描述 → 用接口的（哪怕 DOM 里写的是别的内容）
 *   - weird:  接口字段名全不认识 → 退化成"最长的那个字符串"
 *   - anchor: 没有接口，只有「职位描述」小标题 → 语义锚点
 *   - plain:  没有接口、没有小标题，只有右栏一段文本 → 视口右半屏
 *   - none:   什么都抓不到 → 跳过、且**不调用 AI**（不白花 token）
 *   - 串岗回归：第 2 个岗位的 prompt 里必须是第 2 个岗位的要求
 *   - 招呼语回归：fixture 里放了一个假聊天输入框，列表页流程**不许**往里写字或点发送
 *     （BOSS 在点击那一刻已用它自己的招呼语发过，脚本拦不住；这里钉住"不要再试"这个决定）
 *
 * 用法: node test/apply-flow.test.js
 * 退出码: 0 = 通过, 1 = 失败
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(ROOT, "boss-quick-apply.user.js");
const JOB_PAGE_URL = "https://www.zhipin.com/web/geek/jobs";

// 岗位要求写成正常长度（真实岗位描述都是几百字，太短的文本本身就会被当成"没抓到"）
const JOBS = [
  {
    id: "j1",
    title: "后端开发工程师",
    domDesc:
      "【DOM-1】负责服务端开发，要求三年以上 Java 经验，熟悉 MySQL 与 Redis，有高并发经验优先。",
    apiDesc: "【API-1】负责后端服务开发，要求三年以上 Java 经验，熟悉 MySQL、Redis 与消息队列。",
  },
  {
    id: "j2",
    title: "销售代表",
    domDesc: "【DOM-2】负责客户拓展与关系维护，需要经常出差，有 To B 销售经验者优先考虑。",
    apiDesc: "【API-2】负责客户拓展与签单，需要经常出差，有 To B 销售经验者优先考虑。",
  },
];

/** 详情区的 class 名每次都随机生成 —— 写死选择器的代码在这里必然抓瞎 */
const FIXTURE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>BOSS直聘</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  .page { display: flex; align-items: flex-start; }
  .left { width: 60%; }
  .right { width: 40%; min-height: 800px; }
  li.job-card-box { list-style: none; padding: 16px; border: 1px solid #eee; }
</style>
</head>
<body>
  <div class="page">
    <div class="left">
      <ul class="job-list">
        ${JOBS.map(
          (j) => `<li class="job-card-box" data-jobid="${j.id}">
          <a class="job-name" href="/job_detail/${j.id}.html">${j.title}</a>
          <span class="company-name">测试公司</span>
          <div class="job-card-footer"><a class="op-btn-chat">立即沟通</a></div>
        </li>`,
        ).join("\n        ")}
      </ul>
    </div>
    <div class="right"></div>
  </div>

  <!-- 假聊天输入框 + 发送键。真实 BOSS 的职位列表页没有它们，这里故意放一套。
       老 fixture 里什么都没有，于是「把招呼语写进输入框再发送」那段代码永远只跑
       "找不到输入框"的失败分支 —— 测试全绿、线上全挂。放上之后，那段逻辑一旦被
       加回来，下面的 chatProbe 断言就会失败。 -->
  <div id="chat-input" contenteditable="true"></div>
  <button class="btn-send">发送</button>
<script>
(function () {
  var CFG = __CONFIG__;
  var right = document.querySelector(".right");
  var rnd = function () { return "c" + Math.random().toString(36).slice(2, 9); };

  function renderDetail(job) {
    right.innerHTML = "";
    var head = document.createElement("div");
    head.className = rnd();
    head.textContent = job.title;
    right.appendChild(head);

    if (CFG.mode === "none") return;

    var body = document.createElement("div");
    body.className = rnd();
    if (CFG.mode === "anchor") {
      var h = document.createElement("h3");
      h.textContent = "职位描述";
      body.appendChild(h);
    }
    var p = document.createElement("div");
    p.className = rnd();
    p.textContent = job.domDesc;
    body.appendChild(p);
    right.appendChild(body);
  }

  Array.prototype.forEach.call(document.querySelectorAll("li.job-card-box"), function (li, i) {
    var job = CFG.jobs[i];
    var btn = li.querySelector(".op-btn-chat");

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      btn.textContent = "继续沟通";
    });

    li.addEventListener("click", function () {
      // 模拟 BOSS：点卡片就请求职位详情接口
      if (CFG.mode === "api" || CFG.mode === "weird") {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", "/wapi/zpgeek/job/detail.json?securityId=SEC" + i + "&lid=LID");
        xhr.send();
      }
      setTimeout(function () { renderDetail(job); }, 60);
    });
  });
  // 假输入框的探针。输入框内容在跑完后直接读 textContent（不靠 input 事件，
  // 免得漏掉"写了但没派发事件"的实现）；点击/回车只能靠监听。
  var chatInput = document.getElementById("chat-input");
  var sendBtn = document.querySelector(".btn-send");
  window.__chatProbe = { sendClicks: 0, enterKeys: 0 };
  sendBtn.addEventListener("click", function () {
    window.__chatProbe.sendClicks++;
  });
  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.keyCode === 13) window.__chatProbe.enterKeys++;
  });

  window.__fixtureReady = document.querySelectorAll("li.job-card-box").length;
})();
</script>
</body>
</html>`;

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "✅" : "❌"} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
}

function buildFixture(mode) {
  return FIXTURE.replace("__CONFIG__", JSON.stringify({ mode, jobs: JOBS }));
}

/** 跑一个场景，返回脚本运行期间的可观测结果 */
async function runScenario(browser, scenario) {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
  });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push("console: " + m.text());
  });

  await page.route("**/wapi/zpgeek/job/detail.json*", (route) => {
    const m = route
      .request()
      .url()
      .match(/securityId=SEC(\d+)/);
    const job = JOBS[m ? Number(m[1]) : 0];
    const payload =
      scenario.mode === "weird"
        ? {
            code: 0,
            zpData: { jobInfo: { unknownTitleField: job.title, postDetailText: job.apiDesc } },
          }
        : {
            code: 0,
            zpData: {
              jobInfo: { jobName: job.title, postDescription: job.apiDesc, skills: ["Java"] },
            },
          };
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });

  await page.route(JOB_PAGE_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: buildFixture(scenario.mode),
    }),
  );

  await page.goto(JOB_PAGE_URL, { waitUntil: "domcontentloaded" });

  await page.evaluate((opts) => {
    localStorage.clear();
    localStorage.setItem("aiApiKey", "sk-test");
    // 简历 / 投递要求直接写在主提示词正文里（v2.4.0 起片段机制已下线），
    // 只剩 {jobTitle} / {jobDescription} 两个由代码注入的变量
    localStorage.setItem(
      "promptTemplate",
      "你是求职者的投递助手。请判断这个岗位是否值得投递。\n\n" +
        "【我的简历】\n三年后端经验，熟悉 Java / MySQL\n\n" +
        "【我的投递要求】\n只投后端开发相关岗位\n\n" +
        "【岗位标题】\n{jobTitle}\n\n" +
        "【岗位要求】\n{jobDescription}",
    );
    localStorage.setItem("excludeHeadhunters", "false");
    localStorage.setItem("applyInterval", "800");
    localStorage.setItem("maxApplyPerRun", "10");
    localStorage.setItem("recruiterActivityStatus", '["不限"]');

    window.__aiCalls = [];
    window.GM_setValue = () => undefined;
    window.GM_getValue = () => undefined;
    // 桩掉 LLM：记录 prompt，返回一个恒定"通过"的判定
    window.GM_xmlhttpRequest = (opts) => {
      let prompt = "";
      try {
        const body = JSON.parse(opts.data);
        prompt = (body.messages || []).map((m) => m.content).join("\n");
      } catch (e) {}
      window.__aiCalls.push(prompt);
      const content = JSON.stringify({
        match: true,
        reason: "桩判定通过",
      });
      setTimeout(
        () =>
          opts.onload({
            status: 200,
            responseText: JSON.stringify({ choices: [{ message: { content } }] }),
          }),
        20,
      );
    };
  });

  await page.addScriptTag({ content: fs.readFileSync(SCRIPT_PATH, "utf8") });
  await page.waitForSelector("#boss-pro-panel", { timeout: 8000 });

  // 点「开始投递」
  const started = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("#boss-pro-panel button")).find((b) =>
      (b.textContent || "").includes("开始投递"),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });

  // 等主循环跑完
  let log = "";
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    log = await page.evaluate(() => (document.getElementById("pro-log") || {}).innerText || "");
    if (log.includes("本次运行结束")) break;
    await page.waitForTimeout(250);
  }

  const state = await page.evaluate(() => ({
    fixtureReady: window.__fixtureReady,
    aiCalls: window.__aiCalls,
    log: (document.getElementById("pro-log") || {}).innerText || "",
    hasExportBtn: !!Array.from(document.querySelectorAll("#boss-pro-panel button")).find(
      (b) => b.title === "导出 AI 日志",
    ),
    buttons: Array.from(document.querySelectorAll("li.job-card-box .op-btn-chat")).map(
      (b) => b.textContent,
    ),
    statFailed: (document.getElementById("stat-failed") || {}).textContent || "0",
    chatProbe: {
      typed: (document.getElementById("chat-input") || {}).textContent || "",
      sendClicks: (window.__chatProbe || {}).sendClicks || 0,
      enterKeys: (window.__chatProbe || {}).enterKeys || 0,
    },
  }));

  await page.close();

  return { started, pageErrors, ...state };
}

const SCENARIOS = [
  {
    mode: "api",
    name: "detail.json 有描述时用接口的（忽略 DOM 里的内容）",
    checks: (r) => [
      ["两个岗位都调了 AI", r.aiCalls.length === 2, `实际 ${r.aiCalls.length} 次`],
      ["第 1 个岗位用的是接口描述", r.aiCalls[0] && r.aiCalls[0].includes("【API-1】"), prompt(r)],
      ["第 2 个岗位用的是接口描述", r.aiCalls[1] && r.aiCalls[1].includes("【API-2】"), prompt(r)],
      [
        "没有串岗（第 2 个岗位没拿到第 1 个的要求）",
        r.aiCalls[1] && !r.aiCalls[1].includes("【API-1】"),
        prompt(r),
      ],
      [
        "判定通过后两个岗位都投了",
        r.buttons.every((t) => t.includes("继续沟通")),
        r.buttons.join(","),
      ],
      [
        "prompt 里带上了简历与投递要求",
        r.aiCalls[0] &&
          r.aiCalls[0].includes("三年后端经验") &&
          r.aiCalls[0].includes("只投后端开发相关岗位"),
      ],
    ],
  },
  {
    mode: "weird",
    name: "接口字段名全不认识时退化成最长字符串",
    checks: (r) => [
      ["仍然调了 AI", r.aiCalls.length === 2, `实际 ${r.aiCalls.length} 次`],
      ["描述来自兜底字段", r.aiCalls[0] && r.aiCalls[0].includes("【API-1】"), prompt(r)],
      [
        "两个岗位各自拿到自己的描述",
        r.aiCalls[1] && r.aiCalls[1].includes("【API-2】") && !r.aiCalls[1].includes("【API-1】"),
        prompt(r),
      ],
    ],
  },
  {
    mode: "anchor",
    name: "没有接口时靠「职位描述」小标题定位（DOM 兜底）",
    checks: (r) => [
      ["两个岗位都调了 AI", r.aiCalls.length === 2, `实际 ${r.aiCalls.length} 次`],
      ["描述来自详情区", r.aiCalls[0] && r.aiCalls[0].includes("【DOM-1】"), prompt(r)],
      [
        "没有串岗",
        r.aiCalls[1] && r.aiCalls[1].includes("【DOM-2】") && !r.aiCalls[1].includes("【DOM-1】"),
        prompt(r),
      ],
    ],
  },
  {
    mode: "plain",
    name: "连小标题都没有时靠视口右半屏定位（DOM 兜底）",
    checks: (r) => [
      ["两个岗位都调了 AI", r.aiCalls.length === 2, `实际 ${r.aiCalls.length} 次`],
      ["描述来自详情区", r.aiCalls[0] && r.aiCalls[0].includes("【DOM-1】"), prompt(r)],
    ],
  },
  {
    mode: "none",
    name: "抓不到岗位要求时跳过，且不浪费 AI 调用",
    checks: (r) => [
      [
        "一次 AI 都没调",
        r.aiCalls.length === 0,
        `实际调了 ${r.aiCalls.length} 次，抓到的是「${prompt(r)}」`,
      ],
      ["日志说明了原因", r.log.includes("没抓到岗位要求"), logTail(r)],
      ["日志给出了诊断信息", r.log.includes("诊断："), logTail(r)],
      ["计入失败数", r.statFailed !== "0", `失败 = ${r.statFailed}`],
    ],
  },
];

/** 把 prompt 里的「岗位要求」段落截出来，断言失败时直接看得到抓到了什么（单行，方便读日志） */
function prompt(r, i = 0) {
  const p = r.aiCalls[i];
  if (!p) return "(AI 没被调用)";
  const seg = p.split("【岗位要求】")[1];
  return seg ? JSON.stringify(seg.trim().slice(0, 120)) : "(prompt 里没有岗位要求段落)";
}

/** 日志尾部，断言失败时看得到脚本自己怎么说（单行） */
function logTail(r) {
  return JSON.stringify((r.log || "").split("\n").slice(-3).join(" ⏎ "));
}

async function main() {
  if (!fs.existsSync(SCRIPT_PATH)) {
    console.error(`找不到构建产物：${SCRIPT_PATH}\n请先运行 npm run build`);
    process.exit(1);
  }
  const browser = await chromium.launch();

  // 可以只跑某个模式：node test/apply-flow.test.js none
  const only = process.argv[2];
  const scenarios = only ? SCENARIOS.filter((s) => s.mode === only) : SCENARIOS;
  if (!scenarios.length) {
    console.error(`没有叫 ${only} 的场景，可选：${SCENARIOS.map((s) => s.mode).join(" / ")}`);
    process.exit(1);
  }

  for (const scenario of scenarios) {
    console.log(`\n— ${scenario.name}`);
    let result;
    try {
      result = await runScenario(browser, scenario);
    } catch (e) {
      check(`${scenario.name}（运行异常）`, false, e.message);
      continue;
    }
    check(
      `${scenario.name} · fixture 就绪（2 张卡片）`,
      result.fixtureReady === 2,
      `卡片数 ${result.fixtureReady}`,
    );
    check(`${scenario.name} · 点了「开始投递」`, result.started, "面板里没找到启动按钮");
    for (const [name, passed, detail] of scenario.checks(result)) {
      check(name, passed, detail);
    }
    // ——— 列表页不发自定义招呼语 ———
    // 点「立即沟通」的那一刻 BOSS 已经用它自己配置的招呼语发过一条了，脚本拦不住；
    // 而列表页上根本没有可写入的 IM 输入框（那套选择器只在聊天页成立）。
    // 所以这里断言：即便页面上真有输入框，这条流程也不该碰它。
    const probe = result.chatProbe || {};
    check(
      `${scenario.name} · 没有往聊天输入框里写招呼语`,
      !probe.typed && !probe.sendClicks && !probe.enterKeys,
      `输入框内容「${probe.typed}」｜点发送 ${probe.sendClicks} 次｜回车 ${probe.enterKeys} 次`,
    );

    check(
      `${scenario.name} · 无未捕获错误`,
      result.pageErrors.length === 0,
      result.pageErrors.join(" | "),
    );

    check(`${scenario.name} · 面板上没有「导出 AI 日志」按钮`, !result.hasExportBtn);
  }

  await browser.close();

  const failed = results.filter((r) => !r.passed);
  console.log("");
  if (!failed.length) {
    console.log(`投递流程测试通过（${results.length}/${results.length}）`);
    process.exit(0);
  }
  console.log(`投递流程测试失败：${failed.length}/${results.length} 项未通过`);
  process.exit(1);
}

main().catch((e) => {
  console.error("测试运行异常：", e);
  process.exit(1);
});
