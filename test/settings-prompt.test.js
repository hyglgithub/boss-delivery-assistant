#!/usr/bin/env node
/**
 * 端到端测试：设置 →「投递提示词」→「编辑提示词」弹窗。
 *
 * 为什么需要它：
 *   这一页管的是**真正发给模型的那条 user 消息**。v2.3.0 那版是「模板 + kv 片段」，
 *   用户要在两个地方对着维护，名字对不上就静默失效（AI 收到裸 {resume}，
 *   表现为"所有岗位都判不值得"，而日志里没有任何异常）。v2.4.0 把片段整套删了，
 *   素材直接写进正文，只剩 {jobTitle} / {jobDescription} 两个由代码注入的变量。
 *
 *   几个容易改坏、又不会报错的地方：
 *     1. 渲染出来的 user 消息才是真正发给模型的东西。模板改了却没生效、
 *        或者还有没被替换的 {xxx}，AI 拿到的就是一堆裸占位符。
 *        所以这里断言的是**实际发出的 user 消息**，不是"输入框里有什么"。
 *     2. system 消息必须是固定的 JSON 契约。它一旦跟着模板走、或被用户改动，
 *        parseAiVerdict() 会一律返回 match:false（静默地一个都投不出去）。
 *     3. 编辑要能落盘并重开回填 —— 老版本正是在这里翻过车：
 *        打开弹窗看到空框、点保存就把已存配置覆盖成空。
 *     4. **老配置迁移**（v2.4.0 新增）：片段机制下线后，老用户的简历/投递要求
 *        必须被合并进主提示词正文。这是全流程里唯一会**丢用户数据**的地方，
 *        而且丢了不会报错 —— 用户只是发现 AI 判断全变了。所以下面单开一节，
 *        把三种老用户（v2.3.0 片段 / v2.2.x 老键 / 全新）各覆盖一遍。
 *
 * 用法: node test/settings-prompt.test.js
 * 退出码: 0 = 通过, 1 = 失败
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(ROOT, "boss-quick-apply.user.js");
const JOB_PAGE_URL = "https://www.zhipin.com/web/geek/jobs";

// 布局照搬 apply-flow.test.js 的 anchor 场景：必须有 .page/.left/.right 两栏。
// 详情区用随机 class + 「职位描述」语义锚点，走不依赖 class 的兜底路径；
// 描述写正常长度，太短的文本本身就会被当成"没抓到"。
const DESC =
  "【JOB-1】负责前端页面开发与性能优化，要求三年以上经验，熟悉 JavaScript 与浏览器渲染原理，" +
  "有大型 To C 项目经验优先；需要与后端、设计紧密协作，推动需求落地，保障线上稳定性。";
const JOB_TITLE = "前端开发工程师";

const FIXTURE = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BOSS直聘</title>
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
        <li class="job-card-box" data-jobid="j1">
          <a class="job-name" href="/job_detail/j1.html">${JOB_TITLE}</a>
          <span class="company-name">测试公司</span>
          <div class="job-card-footer"><a class="op-btn-chat">立即沟通</a></div>
        </li>
      </ul>
    </div>
    <div class="right"></div>
  </div>
<script>
(function () {
  var right = document.querySelector(".right");
  var rnd = function () { return "c" + Math.random().toString(36).slice(2, 9); };
  var renders = 0;
  var li = document.querySelector("li.job-card-box");
  var btn = li.querySelector(".op-btn-chat");
  btn.addEventListener("click", function (e) { e.stopPropagation(); btn.textContent = "继续沟通"; });
  li.addEventListener("click", function () {
    right.innerHTML = "";
    var head = document.createElement("div");
    head.className = rnd();
    head.textContent = ${JSON.stringify(JOB_TITLE)};
    right.appendChild(head);
    var body = document.createElement("div");
    body.className = rnd();
    var h = document.createElement("h3");
    h.textContent = "职位描述";
    body.appendChild(h);
    var p = document.createElement("div");
    p.className = rnd();
    // 每次点开都换一段文本：本 fixture 没有 detail.json，只能走 DOM 判定
    // 「详情区到底切没切过去」，而它靠的是内容指纹变化。真实站点每次点卡片都会
    // 重新请求 detail.json，走的是接口那条路，不会有这个问题。
    p.textContent = ${JSON.stringify(DESC)} + "［第" + ++renders + "次渲染］";
    body.appendChild(p);
    right.appendChild(body);
  });
})();
</script>
</body></html>`;

const RESUME_TEXT = "三年后端经验，熟悉 Java / MySQL";
const REQUIRE_TEXT = "只投后端开发相关岗位";
const CONTRACT_SNIPPET = '{"match": true 或 false';

/**
 * v2.4.0（2026-10-20）之前的默认规则段里，有一整句要求 AI 顺带写招呼语。
 * 判定契约去掉 greeting 后，这句也应当从已保存的老提示词里清掉。
 */
const LEGACY_GREETING_RULE =
  "同时为值得投递的岗位写一条打招呼消息：先简洁自我介绍（学历/专业/年限），" +
  "再说明与岗位匹配的技能与成果，表达岗位意向，最后询问能否发一份简历；" +
  "口语化像真人聊天、20-100 字、不要客套废话。";

/**
 * v2.3.0 的主提示词形态：数据段用 {resume}/{require} 引用片段。迁移测试的输入。
 * 里面那个 {mySkill} 代表用户自建的片段 —— 片段只有在模板里被引用了才会有落脚点，
 * 没被引用的片段内容迁移时无处可去（这是机制本身决定的，不是 bug）。
 */
const V23_TEMPLATE =
  "你是求职者的投递助手。请判断这个岗位是否值得投递。\n\n" +
  "【我的简历】\n{resume}\n\n" +
  "【我的投递要求】\n{require}\n\n" +
  "【加分项】\n{mySkill}\n\n" +
  "【岗位标题】\n{jobTitle}\n\n" +
  "【岗位要求】\n{jobDescription}";

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "✅" : "❌"} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
}

/**
 * 起一个装好脚本的页面。
 *
 * `legacy` 是 [key, value] 数组，在**脚本注入之前**写进 localStorage ——
 * 老配置迁移必须这么测：那是在模块加载（SettingsStore.load()）那一刻跑的，
 * 脚本一旦执行完，迁移早就结束了，再灌数据也来不及。
 */
async function bootPage(browser, legacy) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.route(JOB_PAGE_URL, (r) =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: FIXTURE }),
  );
  await page.goto(JOB_PAGE_URL, { waitUntil: "domcontentloaded" });

  await page.evaluate((entries) => {
    window.GM_setValue = () => undefined;
    window.GM_getValue = () => undefined;
    window.__aiSystem = null;
    window.__aiUser = null;
    // 桩掉 LLM：分别记下 system 段和 user 段，返回一个恒定"通过"的判定
    window.GM_xmlhttpRequest = (opts) => {
      try {
        const messages = JSON.parse(opts.data).messages || [];
        window.__aiSystem = (messages[0] || {}).content || null;
        window.__aiUser = (messages[1] || {}).content || null;
      } catch (e) {}
      const content = JSON.stringify({ match: true, reason: "ok" });
      setTimeout(
        () =>
          opts.onload({
            status: 200,
            responseText: JSON.stringify({ choices: [{ message: { content } }] }),
          }),
        20,
      );
    };

    localStorage.setItem("aiApiKey", "sk-test");
    localStorage.setItem("recruiterActivityStatus", '["不限"]');
    localStorage.setItem("applyInterval", "800");
    localStorage.setItem("maxApplyPerRun", "1");
    (entries || []).forEach(([k, v]) => localStorage.setItem(k, v));
  }, legacy || []);

  await page.addScriptTag({ content: fs.readFileSync(SCRIPT_PATH, "utf8") });
  await page.waitForSelector("#boss-pro-panel", { timeout: 8000 });
  return { page, pageErrors };
}

/** 弹窗是首次点击 ⚙ 时才创建的 */
async function openDialog(page) {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("#boss-pro-panel button")).find(
      (b) => b.title === "插件设置",
    );
    btn.click();
  });
  await page.waitForSelector("#boss-settings-dialog", { timeout: 5000 });
  await page.waitForTimeout(250); // 等 loadSettingsIntoUI 跑完
}

/**
 * 面板日志是累加的，上一轮的「本次运行结束」会一直留在里面。
 * 所以不能只判断"有没有这句话"，得数它出现了几次。
 */
const runEndCount = (page) =>
  page.evaluate(
    () =>
      ((document.getElementById("pro-log") || {}).innerText || "").split("本次运行结束").length - 1,
  );

const logText = (page) =>
  page.evaluate(() => (document.getElementById("pro-log") || {}).innerText || "");

/** 点面板上的「开始投递」并把弹窗让开 */
async function startApply(page) {
  await page.evaluate(() => {
    const dialog = document.getElementById("boss-settings-dialog");
    if (dialog) dialog.style.display = "none";
    Array.from(document.querySelectorAll("#boss-pro-panel button"))
      .find((b) => (b.textContent || "").includes("开始投递"))
      .click();
  });
}

/** 等这一轮跑完（日志里出现第 n 次「本次运行结束」） */
async function waitRunEnd(page, n) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if ((await runEndCount(page)) >= n) return;
    await page.waitForTimeout(200);
  }
}

async function main() {
  if (!fs.existsSync(SCRIPT_PATH)) {
    console.error(`找不到构建产物：${SCRIPT_PATH}\n请先运行 npm run build`);
    process.exit(1);
  }

  const browser = await chromium.launch();
  const { page, pageErrors } = await bootPage(browser);
  await openDialog(page);

  // ======================================================================
  // 一、页面结构
  // ======================================================================
  const layout = await page.evaluate(() => {
    const dialog = document.getElementById("boss-settings-dialog");
    const header = dialog.querySelector(".boss-dialog-header");
    const panels = ["general", "job", "chat"].map((id) =>
      document.getElementById(`${id}-settings-panel`),
    );
    const saveBtn = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent === "保存设置",
    );
    const closeBtn = header.querySelector('button[title="关闭"]');
    return {
      tabCount: dialog.querySelectorAll(".settings-tab").length,
      title: header.firstElementChild.firstElementChild.textContent,
      allPanelsVisible: panels.every((p) => getComputedStyle(p).display !== "none"),
      headerBg: getComputedStyle(header).backgroundColor,
      closeBg: closeBtn ? getComputedStyle(closeBtn).backgroundColor : "",
      closeColor: closeBtn ? getComputedStyle(closeBtn).color : "",
      saveBg: saveBtn ? getComputedStyle(saveBtn).backgroundColor : "",
    };
  });
  check(
    "设置页不再有标签栏，AI / 投递 / 聊天分组都在同一页",
    layout.tabCount === 0 && layout.title === "设置" && layout.allPanelsVisible,
    JSON.stringify(layout),
  );
  check(
    "白色为主、蓝色点缀（白标题栏 + 浅蓝关闭按钮 + 蓝色保存按钮）",
    layout.headerBg === "rgb(255, 255, 255)" &&
      layout.closeBg === "rgb(232, 240, 254)" &&
      layout.closeColor === "rgb(26, 115, 232)" &&
      layout.saveBg === "rgb(26, 115, 232)",
    JSON.stringify(layout),
  );

  const panels = await page.evaluate(() => {
    const has = (panelId, id) => !!document.querySelector(`#${panelId} #${id}`);
    const none = (panelId, ids) => ids.every((id) => !has(panelId, id));
    const groups = (panelId) => {
      const panel = document.getElementById(panelId);
      return {
        headings: Array.from(panel.querySelectorAll("h3")).map((h) => h.textContent),
        cards: panel.querySelectorAll(".settings-card").length,
        rows: panel.querySelectorAll(".settings-card .setting-item").length,
      };
    };
    return {
      groups: {
        general: groups("general-settings-panel"),
        job: groups("job-settings-panel"),
        chat: groups("chat-settings-panel"),
      },
      general: {
        api: has("general-settings-panel", "ai-api-url-input"),
        noTestMode: !has("general-settings-panel", "toggle-test-mode"),
        promptBtn: has("general-settings-panel", "edit-prompt-btn"),
      },
      job: {
        keeps: [
          "recruiter-status-select",
          "toggle-exclude-headhunters",
          "apply-interval-input",
          "max-apply-input",
        ].every((id) => has("job-settings-panel", id)),
        noChat: none("job-settings-panel", ["ai-api-url-input", "greetings-container"]),
      },
      chat: {
        keeps: [
          "greetings-container",
          "toggle-auto-send-resume",
          "toggle-auto-send-image-resume",
          "toggle-auto-accept-card",
        ].every((id) => has("chat-settings-panel", id)),
        noJob: none("chat-settings-panel", [
          "apply-interval-input",
          "recruiter-status-select",
          "ai-api-url-input",
        ]),
        noAutoReply: !has("chat-settings-panel", "toggle-auto-reply-mode"),
        noAiRole: !has("chat-settings-panel", "ai-role-input"),
      },
      promptLeak: ["general-settings-panel", "job-settings-panel", "chat-settings-panel"].filter(
        (panelId) => has(panelId, "prompt-template-input"),
      ),
      hasPromptEditor: !!document.querySelector("#boss-settings-dialog #prompt-template-input"),
      textareaCount: document.querySelectorAll("#boss-settings-dialog textarea").length,
      dialogText: document.getElementById("boss-settings-dialog").innerText,
      hasImport: !!document.querySelector("#resume-file-input"),
    };
  });
  check(
    "API / 提示词分组保留配置与提示词入口，测试模式开关已移除",
    panels.general.api && panels.general.noTestMode && panels.general.promptBtn,
    JSON.stringify(panels.general),
  );
  check(
    "API / 提示词分组合并为两张卡片：AI API 配置 + 投递提示词（4 行）",
    panels.groups.general.headings.join("|") === "AI API 配置|投递提示词" &&
      panels.groups.general.cards === 2 &&
      panels.groups.general.rows === 4,
    JSON.stringify(panels.groups.general),
  );
  check(
    "投递分组保留招聘者状态 / 排除猎头 / 节奏 / 上限，且没有聊天或 API 设置",
    panels.job.keeps && panels.job.noChat,
    JSON.stringify(panels.job),
  );
  check(
    "投递设置合并为一张「投递基础设置」卡片（4 行）",
    panels.groups.job.headings.join("|") === "投递基础设置" &&
      panels.groups.job.cards === 1 &&
      panels.groups.job.rows === 4,
    JSON.stringify(panels.groups.job),
  );
  check(
    "聊天分组保留打招呼列表 / 自动发送开关，且没有投递、API、AI 角色或 AI 回复设置",
    panels.chat.keeps && panels.chat.noJob && panels.chat.noAutoReply && panels.chat.noAiRole,
    JSON.stringify(panels.chat),
  );
  check(
    "聊天设置按打招呼 / 简历 / 其他分成三张卡片",
    panels.groups.chat.headings.join("|") === "打招呼设置|简历发送设置|其他" &&
      panels.groups.chat.cards === 3 &&
      panels.groups.chat.rows === 4,
    JSON.stringify(panels.groups.chat),
  );
  check(
    "提示词编辑器不在投递/聊天面板内，但存在于设置弹窗中",
    panels.promptLeak.length === 0 && panels.hasPromptEditor,
    JSON.stringify({ leak: panels.promptLeak, has: panels.hasPromptEditor }),
  );
  check(
    "整个设置弹窗只有一个 textarea（提示词编辑器）",
    panels.textareaCount === 1,
    `实际 ${panels.textareaCount} 个`,
  );
  check("「导入简历」已彻底移除", !panels.hasImport);

  const statusUi = await page.evaluate(() => {
    const select = document.getElementById("recruiter-status-select");
    const row = select.closest(".setting-item");
    const option = select.querySelector('.select-option[data-value="不限"]');
    const check = option.querySelector(".check-icon");
    return {
      rowDirection: getComputedStyle(row).flexDirection,
      noClear: !select.querySelector(".select-clear"),
      selectRight: select.style.marginLeft === "auto",
      checkRight: check.style.marginLeft === "auto" && option.lastElementChild === check,
      optionColor: getComputedStyle(option).color,
      optionWeight: getComputedStyle(option).fontWeight,
      numberAppearance: getComputedStyle(document.getElementById("apply-interval-input"))
        .appearance,
      numberAppearance2: getComputedStyle(document.getElementById("max-apply-input")).appearance,
    };
  });
  check(
    "投递招聘者状态：右侧多选、没有清除 ×、选中项右侧打勾",
    statusUi.rowDirection === "row" &&
      statusUi.noClear &&
      statusUi.selectRight &&
      statusUi.checkRight &&
      statusUi.optionColor === "rgb(26, 115, 232)" &&
      statusUi.optionWeight === "600",
    JSON.stringify(statusUi),
  );
  check(
    "投递的两个数字输入框去掉了上下箭头",
    statusUi.numberAppearance === "textfield" && statusUi.numberAppearance2 === "textfield",
    JSON.stringify(statusUi),
  );

  // 再点一次已选中的「不限」：不能变成空数组，否则会跳过所有岗位
  await page.evaluate(() => {
    document.querySelector('#recruiter-status-select .select-option[data-value="不限"]').click();
  });
  await page.waitForTimeout(80);
  const unlimitedAfterClick = await page.evaluate(() => {
    const select = document.getElementById("recruiter-status-select");
    return {
      text: select.querySelector(".select-value").textContent,
      selected: select
        .querySelector('.select-option[data-value="不限"]')
        .classList.contains("selected"),
    };
  });
  check(
    "「不限」不会被取消到空选（避免跳过所有岗位）",
    unlimitedAfterClick.text === "不限" && unlimitedAfterClick.selected,
    JSON.stringify(unlimitedAfterClick),
  );

  const greetingUi = await page.evaluate(() => {
    const row = document.querySelector("#chat-settings-panel .greeting-item");
    const input = row.querySelector(".greeting-input");
    const del = row.querySelector(".delete-greeting-btn");
    const add = Array.from(document.querySelectorAll("#chat-settings-panel button")).find(
      (b) => b.textContent === "添加一条",
    );
    return {
      rowDisplay: getComputedStyle(row).display,
      inputHeight: input.getBoundingClientRect().height,
      inputRadius: getComputedStyle(input).borderRadius,
      deleteWidth: del.getBoundingClientRect().width,
      deleteHeight: del.getBoundingClientRect().height,
      deleteRadius: getComputedStyle(del).borderRadius,
      addHeight: add.getBoundingClientRect().height,
      addRadius: getComputedStyle(add).borderRadius,
      addInHeader: !document.getElementById("greetings-container").contains(add),
    };
  });
  check(
    "打招呼列表改为「标题右侧添加 + 下方精简行」",
    greetingUi.rowDisplay === "flex" &&
      greetingUi.inputHeight === 38 &&
      greetingUi.inputRadius === "4px" &&
      greetingUi.deleteWidth === 56 &&
      greetingUi.deleteHeight === 32 &&
      greetingUi.deleteRadius === "4px" &&
      greetingUi.addHeight === 32 &&
      greetingUi.addRadius === "4px" &&
      greetingUi.addInHeader,
    JSON.stringify(greetingUi),
  );

  const buttonUi = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#boss-settings-dialog .settings-btn")).map((b) => ({
      text: b.textContent,
      height: getComputedStyle(b).height,
      radius: getComputedStyle(b).borderRadius,
      fontSize: getComputedStyle(b).fontSize,
    })),
  );
  check(
    "设置页文字按钮统一为 32px 高 / 4px 圆角 / 14px 字号",
    buttonUi.length >= 8 &&
      buttonUi.every((b) => b.height === "32px" && b.radius === "4px" && b.fontSize === "14px"),
    JSON.stringify(buttonUi),
  );

  // 成功提示统一为设置页的蓝色
  await page.evaluate(() => {
    Array.from(document.querySelectorAll("#boss-settings-dialog button"))
      .find((b) => b.textContent === "保存 API 配置")
      .click();
  });
  await page.waitForTimeout(80);
  const noticeBg = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("body > div")).find(
      (d) => d.textContent === "API 配置已保存",
    );
    return el ? getComputedStyle(el).backgroundColor : "";
  });
  check("成功提示改为淡蓝色半透明", noticeBg === "rgba(232, 240, 254, 0.92)", noticeBg);

  await page.evaluate(() => document.getElementById("edit-prompt-btn").click());
  await page.waitForTimeout(250);

  const promptEditor = await page.evaluate(() => {
    const overlay = document.getElementById("prompt-editor-overlay");
    const modal = overlay.querySelector(".prompt-editor-modal");
    const box = document.getElementById("prompt-template-input");
    const dialog = document.getElementById("boss-settings-dialog");
    const r = box.getBoundingClientRect();
    const mr = modal.getBoundingClientRect();
    return {
      visible:
        overlay.style.display === "flex" &&
        overlay.classList.contains("show") &&
        mr.width > 0 &&
        mr.height > 0,
      hasTemplate: r.width > 0 && r.height > 0,
      templateValue: box.value,
      title: (modal.querySelector("h2") || {}).textContent || "",
      labelCount: modal.querySelectorAll("label").length,
      buttons: Array.from(modal.querySelectorAll("button")).map((b) => b.textContent),
      resize: getComputedStyle(box).resize,
      minHeight: parseFloat(getComputedStyle(box).minHeight),
      overlayCoversDialog:
        overlay.getBoundingClientRect().height >= dialog.getBoundingClientRect().height - 1,
      dialogText: dialog.innerText,
      allButtons: Array.from(dialog.querySelectorAll("button")).map((b) => b.textContent),
    };
  });
  check("点「编辑提示词」后编辑器打开", promptEditor.visible, JSON.stringify(promptEditor));
  check(
    "编辑器标题 / 按钮符合预期，且没有多余的标签行",
    promptEditor.title === "编辑提示词" &&
      promptEditor.labelCount === 0 &&
      promptEditor.buttons.join(",") === "取消,保存",
    JSON.stringify(promptEditor),
  );
  check("主提示词文本框可见", promptEditor.hasTemplate);
  check(
    "文本框不可拖拽调整大小且高度足够",
    promptEditor.resize === "none" && promptEditor.minHeight >= 200,
    JSON.stringify({ resize: promptEditor.resize, minHeight: promptEditor.minHeight }),
  );
  check("编辑器遮罩覆盖整个设置弹窗", promptEditor.overlayCoversDialog);

  // —— 默认模板：两个变量在，两个老占位符没了 ——
  check(
    "默认模板含 {jobTitle} / {jobDescription}",
    ["{jobTitle}", "{jobDescription}"].every((ph) => promptEditor.templateValue.includes(ph)),
    JSON.stringify(promptEditor.templateValue.slice(-80)),
  );
  check(
    "默认模板不再含 {resume} / {require}",
    !promptEditor.templateValue.includes("{resume}") &&
      !promptEditor.templateValue.includes("{require}"),
    JSON.stringify(promptEditor.templateValue.slice(0, 120)),
  );
  check(
    "默认模板留了【我的简历】【我的投递要求】两个填写位",
    promptEditor.templateValue.includes("【我的简历】") &&
      promptEditor.templateValue.includes("【我的投递要求】"),
  );
  check(
    "默认模板不再要求 AI 生成招呼语",
    !promptEditor.templateValue.includes("写一条打招呼消息"),
    JSON.stringify(promptEditor.templateValue.slice(0, 200)),
  );
  check(
    "输出契约整块从页面上移除",
    !promptEditor.dialogText.includes("以下输出格式固定") &&
      !promptEditor.dialogText.includes(CONTRACT_SNIPPET),
    promptEditor.dialogText.slice(-160),
  );

  const varWreckage = await page.evaluate(() => ({
    select: !!document.querySelector("#prompt-var-select"),
    list: !!document.querySelector("#prompt-vars-list"),
    rows: document.querySelectorAll("[class*=prompt-var]").length,
  }));
  check(
    "片段的 DOM 残骸已清干净",
    !varWreckage.select && !varWreckage.list && varWreckage.rows === 0,
    JSON.stringify(varWreckage),
  );
  check(
    "页面上没有「添加片段」按钮",
    promptEditor.allButtons.indexOf("添加片段") === -1,
    JSON.stringify(promptEditor.allButtons),
  );
  check("页面上没有「恢复默认」按钮", promptEditor.allButtons.indexOf("恢复默认") === -1);

  await page.evaluate(() => document.getElementById("prompt-editor-cancel").click());
  await page.waitForTimeout(150);
  const editorClosed = await page.evaluate(() => {
    const overlay = document.getElementById("prompt-editor-overlay");
    return overlay.style.display === "none" && !overlay.classList.contains("show");
  });
  check("取消后编辑器关闭", editorClosed);

  // ======================================================================
  // 二、编辑与落盘
  // ======================================================================
  // 把简历/投递要求写进那两个空小节 —— 这正是用户在新版里的操作方式
  await page.evaluate(() => document.getElementById("edit-prompt-btn").click());
  await page.waitForTimeout(120);
  await page.evaluate(
    ({ resume, require }) => {
      const box = document.getElementById("prompt-template-input");
      box.value = box.value
        .replace("【我的简历】", "【我的简历】\n" + resume)
        .replace("【我的投递要求】", "【我的投递要求】\n" + require);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    },
    { resume: RESUME_TEXT, require: REQUIRE_TEXT },
  );
  await page.evaluate(() => document.getElementById("prompt-editor-save").click());
  await page.waitForTimeout(250);

  const savedTemplate = await page.evaluate(() => localStorage.getItem("promptTemplate") || "");
  check(
    "改完点保存，正文落盘到 promptTemplate",
    savedTemplate.includes(RESUME_TEXT) && savedTemplate.includes(REQUIRE_TEXT),
    JSON.stringify(savedTemplate.slice(0, 120)),
  );
  check(
    "落盘的模板里没有残留的 {resume}/{require}",
    !savedTemplate.includes("{resume}") && !savedTemplate.includes("{require}"),
  );

  // 重开弹窗：老版本正是在这里把已存配置读成空、点保存又覆盖回去
  await page.evaluate(
    () => (document.getElementById("boss-settings-dialog").style.display = "none"),
  );
  await page.evaluate(() => {
    // 重建弹窗，强制走一遍"首次打开"的加载路径
    document.getElementById("boss-settings-dialog").remove();
  });
  await openDialog(page);
  const reopened = await page.evaluate(
    () => (document.getElementById("prompt-template-input") || {}).value || "",
  );
  check(
    "重开弹窗后正文回填为新值（没有被读成空）",
    reopened.includes(RESUME_TEXT) && reopened.includes(REQUIRE_TEXT),
    JSON.stringify(reopened.slice(0, 120)),
  );

  // ======================================================================
  // 三、真正发给模型的两条消息
  // ======================================================================
  await startApply(page);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => window.__aiUser)) break;
    await page.waitForTimeout(200);
  }
  const sys = await page.evaluate(() => window.__aiSystem);
  const user = await page.evaluate(() => window.__aiUser);
  const runLog = await logText(page);

  check("AI 确实被调用了", !!user, `运行日志：${runLog.replace(/\n/g, " / ")}`);
  check(
    "user 消息里带上了写在正文里的简历",
    !!user && user.includes(RESUME_TEXT),
    JSON.stringify(user).slice(0, 160),
  );
  check("user 消息里带上了写在正文里的投递要求", !!user && user.includes(REQUIRE_TEXT));
  check("user 消息里 {jobTitle} 换成了岗位标题", !!user && user.includes(JOB_TITLE));
  check("user 消息里 {jobDescription} 换成了岗位要求", !!user && user.includes("【JOB-1】"));
  check(
    "user 消息里没留下裸 {jobTitle}/{jobDescription}",
    !!user && !user.includes("{jobTitle}") && !user.includes("{jobDescription}"),
  );
  check(
    "system 消息 = 固定的 JSON 契约",
    !!sys && sys.includes(CONTRACT_SNIPPET) && sys.includes("请按用户消息里的要求判断"),
    JSON.stringify(sys),
  );
  check(
    "system 契约不再要求 greeting 字段",
    !!sys && !sys.includes("greeting"),
    JSON.stringify(sys),
  );
  check("规则段留在 user 消息里（不进 system）", !!user && user.includes("你是求职者的投递助手"));

  // ======================================================================
  // 四、替换不了的占位符：提醒但不阻止
  // ======================================================================
  await waitRunEnd(page, 1);

  // 上一轮已经把卡片按钮点成了「继续沟通」，再跑会被正确地判成"已沟通过"而跳过。
  // 把按钮文案复位，等价于换了一批没沟通过的新岗位。
  await page.evaluate(() => {
    document.querySelectorAll("li.job-card-box .op-btn-chat").forEach((b) => {
      b.textContent = "立即沟通";
    });
  });

  await page.evaluate(
    () => (document.getElementById("boss-settings-dialog").style.display = "flex"),
  );
  await page.evaluate(() => document.getElementById("edit-prompt-btn").click());
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    document.getElementById("prompt-template-input").value =
      "【岗位标题】\n{jobTitle}\n\n【岗位要求】\n{jobDescription}\n\n【补充】\n{nope}";
  });
  await page.evaluate(() => document.getElementById("prompt-editor-save").click());
  await page.waitForTimeout(250);

  await page.evaluate(() => (window.__aiUser = null));
  await startApply(page);
  // 提醒是在启动瞬间打的，但 AI 调用在那之后 —— 要等**这一轮**跑完再断言，
  // 否则会在提醒刚出现时就跳出循环，此时 __aiUser 还是 null
  await waitRunEnd(page, 2);

  const log2 = await logText(page);
  check(
    "替换不了的占位符在启动日志里被点名",
    log2.includes("{nope}"),
    log2.replace(/\n/g, " / ").slice(-200),
  );
  check("日志里说明了可用变量只有哪两个", log2.includes("可用变量只有"), log2.slice(-200));
  check("未填不影响启动（照常调用了 AI）", !!(await page.evaluate(() => window.__aiUser)));
  check(
    "替换不了的占位符原样保留在 prompt 里",
    ((await page.evaluate(() => window.__aiUser)) || "").includes("{nope}"),
    JSON.stringify(await page.evaluate(() => window.__aiUser)).slice(-160),
  );
  check(
    "内置变量为空时不算未填（{jobTitle} 没被误报）",
    !log2.includes("没法替换：{jobTitle}"),
    log2.slice(-200),
  );

  check("全程无未捕获错误", pageErrors.length === 0, pageErrors.join(" | "));

  // ======================================================================
  // 五、老配置迁移 —— 唯一会丢用户数据的地方
  // ======================================================================
  const readTemplate = (p) => p.evaluate(() => localStorage.getItem("promptTemplate") || "");
  const readKey = (p, k) => p.evaluate((key) => localStorage.getItem(key), k);
  /**
   * 读用户实际看到的那段正文（设置页文本框）。
   *
   * 不用 localStorage 是因为 v2.2.x 那条迁移路径**不落盘**：它的源键
   * （userResume / aiApplyCriteria）没被删，每次加载重新合并的输入完全一样，
   * 结果稳定，所以没必要写。测试要断言的是"用户升级后打开设置，简历还在框里"，
   * 那就该从框里读。
   */
  const readTemplateFromUI = async (p) => {
    await openDialog(p);
    return p.evaluate(() => (document.getElementById("prompt-template-input") || {}).value || "");
  };

  // —— 场景 A：v2.3.0 用户，素材在片段里 ——
  {
    const { page: p, pageErrors: errs } = await bootPage(browser, [
      ["promptTemplate", V23_TEMPLATE],
      [
        "promptVars",
        JSON.stringify([
          { id: "resume", name: "resume", value: RESUME_TEXT },
          { id: "require", name: "require", value: REQUIRE_TEXT },
          { id: "x1", name: "mySkill", value: "熟悉 K8s" },
        ]),
      ],
    ]);
    const stored = await readTemplate(p);
    const t = await readTemplateFromUI(p);

    check(
      "v2.3.0：片段内容被合并进主提示词",
      [RESUME_TEXT, REQUIRE_TEXT, "熟悉 K8s"].every((s) => t.includes(s)),
      JSON.stringify(t.slice(0, 200)),
    );
    check(
      "v2.3.0：模板里不再有 {resume}/{require}/{mySkill}",
      !/\{(resume|require|mySkill)\}/.test(t),
      JSON.stringify(t),
    );
    check(
      "v2.3.0：{jobTitle}/{jobDescription} 没被吃掉",
      t.includes("{jobTitle}") && t.includes("{jobDescription}"),
      JSON.stringify(t.slice(-120)),
    );
    check("v2.3.0：promptVars 键已被清理", (await readKey(p, "promptVars")) === null);
    // 这条是防"合并了但没落盘"：promptVars 已经删了，模板若还是带占位符的旧版，
    // 下次加载时 {resume} 会被替换成空串 —— 简历静默消失
    check(
      "v2.3.0：合并结果已落盘（否则下次加载会丢简历）",
      stored.includes(RESUME_TEXT) && !stored.includes("{resume}"),
      JSON.stringify(stored.slice(0, 160)),
    );
    check("v2.3.0：全程无未捕获错误", errs.length === 0, errs.join(" | "));
    await p.close();
  }

  // —— 场景 B：v2.2.x 用户，素材在更老的老键里，没有 promptTemplate ——
  // 这条专门盯着一个坑：迁移路径若改用新版数据段常量（没有 {resume} 占位符），
  // userResume 里的简历就没地方可填，会被**静默丢掉**
  {
    const { page: p, pageErrors: errs } = await bootPage(browser, [
      ["userResume", "五年后端，熟悉 Java / MySQL"],
      ["aiApplyCriteria", "只投杭州，不接受外包"],
      ["aiJudgePrompt", "你是投递助手（这是用户自己改过的老规则段）。"],
    ]);
    const t = await readTemplateFromUI(p);

    check(
      "v2.2.x：userResume / aiApplyCriteria 被合并进模板",
      t.includes("五年后端，熟悉 Java / MySQL") && t.includes("只投杭州，不接受外包"),
      JSON.stringify(t.slice(0, 240)),
    );
    check(
      "v2.2.x：用户改过的老规则段被保留",
      t.includes("这是用户自己改过的老规则段"),
      JSON.stringify(t.slice(0, 160)),
    );
    check(
      "v2.2.x：{jobTitle}/{jobDescription} 仍是占位符",
      t.includes("{jobTitle}") && t.includes("{jobDescription}") && !t.includes("{resume}"),
      JSON.stringify(t.slice(-140)),
    );
    check("v2.2.x：全程无未捕获错误", errs.length === 0, errs.join(" | "));
    await p.close();
  }

  // —— 场景 C：全新用户，什么都没有 ——
  {
    const { page: p, pageErrors: errs } = await bootPage(browser, []);
    await openDialog(p);
    const box = await p.evaluate(
      () => (document.getElementById("prompt-template-input") || {}).value || "",
    );

    check(
      "全新：拿到的是新版默认模板（两个变量、两个空小节）",
      box.includes("{jobTitle}") &&
        box.includes("{jobDescription}") &&
        box.includes("【我的简历】") &&
        !box.includes("{resume}"),
      JSON.stringify(box.slice(0, 160)),
    );
    check(
      "全新：不会被写进一个 promptVars 空键",
      (await readKey(p, "promptVars")) === null,
      String(await readKey(p, "promptVars")),
    );
    check("全新：全程无未捕获错误", errs.length === 0, errs.join(" | "));
    await p.close();
  }

  // —— 场景 D：迁移的幂等性 ——
  // 就算 promptVars 因为某种原因没被删掉（配额满 / 隐私模式），再加载一次也不该
  // 把已经合并好的正文改坏。做法：拿场景 A 的产物（已合并的模板）当输入再跑一遍。
  {
    const seed = [
      ["promptTemplate", V23_TEMPLATE],
      [
        "promptVars",
        JSON.stringify([
          { id: "resume", name: "resume", value: RESUME_TEXT },
          { id: "require", name: "require", value: REQUIRE_TEXT },
        ]),
      ],
    ];
    const first = await bootPage(browser, seed);
    const merged = await readTemplate(first.page);
    await first.page.close();

    // 第二次：模板已经是合并后的（没有 {resume} 了），但片段键还在
    const second = await bootPage(browser, [
      ["promptTemplate", merged],
      ["promptVars", seed[1][1]],
    ]);
    const again = await readTemplate(second.page);
    check(
      "重复加载不会二次替换 / 不会改坏已合并的正文",
      again === merged && again.includes(RESUME_TEXT),
      JSON.stringify(again.slice(0, 160)),
    );
    await second.page.close();
  }

  // —— 场景 E：老提示词里的「写一条打招呼消息」指令 ——
  // 判定契约去掉 greeting 后，模型不该再被要求生成它。默认规则里那句已经删了，
  // 但用户可能早把旧默认模板保存进了 promptTemplate；加载时原地清掉并落盘。
  {
    const OLD_TEMPLATE =
      "你是求职者的投递助手。请判断这个岗位是否值得投递。" +
      LEGACY_GREETING_RULE +
      "\n\n【我的简历】\n" +
      RESUME_TEXT +
      "\n\n【岗位标题】\n{jobTitle}" +
      "\n\n【岗位要求】\n{jobDescription}";
    const { page: p, pageErrors: errs } = await bootPage(browser, [
      ["promptTemplate", OLD_TEMPLATE],
    ]);
    const stored = await readTemplate(p);
    const t = await readTemplateFromUI(p);

    check(
      "旧提示词的招呼语指令已从文本框移除",
      !t.includes("写一条打招呼消息") && t.includes("请判断这个岗位是否值得投递"),
      JSON.stringify(t.slice(0, 200)),
    );
    check(
      "旧提示词的招呼语指令已从本地存储移除",
      !stored.includes("写一条打招呼消息") && stored.includes(RESUME_TEXT),
      JSON.stringify(stored.slice(0, 200)),
    );
    check("旧提示词清理：全程无未捕获错误", errs.length === 0, errs.join(" | "));
    await p.close();
  }

  // ======================================================================
  // 六、面板 × 设置弹窗：两者不同时出现
  // ======================================================================
  const panelRect = (p) =>
    p.evaluate(() => {
      const r = document.getElementById("boss-pro-panel").getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
    });

  // 最小化的位移必须按**视口**高度算。写成 translateY(160%) 时百分比是相对面板自身高度
  // 取的：面板矮的时候（刚投完、日志没几行）160% 只有两三百像素，
  // 从页面顶部滑下来还露着半截在视口里。
  await page.evaluate(() => {
    const panel = document.getElementById("boss-pro-panel");
    panel.style.top = "8px";
    panel.style.right = "auto";
    panel.style.left = "420px";
    panel.style.height = "120px"; // 模拟"面板很矮"
  });
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("#boss-pro-panel .boss-icon-btn"));
    btns[btns.length - 1].click(); // 最后一个 = 最小化
  });
  await page.waitForTimeout(500);
  const minimized = await panelRect(page);
  check(
    "最小化后面板整个离开视口（矮面板也不留半截）",
    minimized.top >= minimized.vh,
    JSON.stringify(minimized),
  );

  await page.evaluate(() => {
    document.getElementById("boss-pro-panel").style.height = "";
    document.getElementById("boss-mini-icon").click(); // 展开
  });
  await page.waitForTimeout(400);

  await openDialog(page);
  const whileOpen = await panelRect(page);
  check(
    "设置弹窗打开时投递面板收起来了（两者不同时出现）",
    whileOpen.top >= whileOpen.vh,
    JSON.stringify(whileOpen),
  );

  await page.evaluate(() => {
    Array.from(document.querySelectorAll("#boss-settings-dialog button"))
      .find((b) => b.textContent === "取消")
      .click();
  });
  await page.waitForTimeout(500);
  const afterClose = await panelRect(page);
  check(
    "关掉弹窗后面板回到页面上",
    afterClose.bottom > 0 && afterClose.top < afterClose.vh,
    JSON.stringify(afterClose),
  );

  await browser.close();

  const failed = results.filter((r) => !r.passed);
  console.log(
    `\n提示词页测试${failed.length === 0 ? "通过" : "失败"}（${results.length - failed.length}/${results.length}）`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
