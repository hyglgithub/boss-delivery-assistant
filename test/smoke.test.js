#!/usr/bin/env node
/**
 * Headless 冒烟测试：在模拟的 BOSS 职位页里加载构建产物，验证脚本能正常启动。
 *
 * 为什么需要它：
 *   这脚本没有单元测试，而重构（拆模块、调初始化顺序）最典型的故障是
 *   "模块加载期抛错 / 引用了未定义的东西 / TDZ"，表现为整个脚本静默不工作。
 *   这类问题静态检查抓不到，必须在真实 JS 运行时里跑一遍才能发现。
 *
 * 覆盖：
 *   - 加载期无未捕获错误（能否决 TDZ、未定义引用、顺序错误）
 *   - 面板与悬浮球被真实创建（init → UI.init 走通）
 *   - 面板子树完整（统计栏存在，说明不是建到一半就断了）
 *   - IIFE 闭包未泄漏到 window
 *   - 猴补丁确实打上了（APIInterceptor.init 跑过）
 *
 * 用法: node test/smoke.test.js   （或 npm test）
 * 退出码: 0 = 通过, 1 = 失败
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(ROOT, "boss-quick-apply.user.js");
const JOB_PAGE_URL = "https://www.zhipin.com/web/geek/jobs";

/** 极简 fixture：只需让 waitForBody 拿到 body、页面识别命中职位列表页 */
const FIXTURE = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BOSS直聘</title></head>
<body>
  <div class="job-list-box">
    <ul>
      <li class="job-card-box" data-jobid="test-job-1">
        <a class="job-name" href="/job_detail/test-job-1.html">前端开发工程师</a>
        <span class="company-name">测试公司</span>
      </li>
    </ul>
  </div>
</body>
</html>`;

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  const mark = passed ? "✅" : "❌";
  console.log(`${mark} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
}

async function main() {
  if (!fs.existsSync(SCRIPT_PATH)) {
    console.error(`找不到构建产物：${SCRIPT_PATH}\n请先运行 npm run build`);
    process.exit(1);
  }
  const script = fs.readFileSync(SCRIPT_PATH, "utf8");

  const browser = await chromium.launch();
  const page = await browser.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  // 拦截职位页，离线返回 fixture（不访问真实站点）
  await page.route(JOB_PAGE_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: FIXTURE }),
  );
  await page.goto(JOB_PAGE_URL, { waitUntil: "domcontentloaded" });

  // 必须在脚本执行前铺好 Tampermonkey 的 GM_* API
  await page.evaluate(() => {
    window.GM_setValue = () => undefined;
    window.GM_getValue = () => undefined;
    window.GM_xmlhttpRequest = () => undefined;
  });

  await page.addScriptTag({ content: script });

  // 启动是异步的（init 内部 await waitForBody）
  let panelAppeared = true;
  try {
    await page.waitForSelector("#boss-pro-panel", { timeout: 8000 });
  } catch {
    panelAppeared = false;
  }

  check("加载无未捕获错误", pageErrors.length === 0, pageErrors.join(" | "));
  check("主面板 #boss-pro-panel 已创建", panelAppeared, "8s 内未出现，init/UI.init 可能中断");

  const probe = await page.evaluate(() => {
    const panel = document.getElementById("boss-pro-panel");
    return {
      hasPanel: !!panel,
      hasMiniIcon: !!document.getElementById("boss-mini-icon"),
      hasStats: !!document.getElementById("boss-panel-stats"),
      hasLog: !!document.getElementById("pro-log"),
      leaked: ["Core", "UI", "state", "CONFIG", "settings"].filter(
        (k) => typeof window[k] !== "undefined",
      ),
      xhrPatched: !/native code/.test(String(XMLHttpRequest.prototype.open)),
    };
  });

  check("悬浮球 #boss-mini-icon 已创建", probe.hasMiniIcon);
  check("面板子树完整（统计栏 #boss-panel-stats）", probe.hasStats);
  check("面板子树完整（日志区 #pro-log）", probe.hasLog);
  check(
    "IIFE 闭包未泄漏到 window",
    probe.leaked.length === 0,
    `泄漏了: ${probe.leaked.join(", ")}`,
  );
  check("APIInterceptor 猴补丁已生效", probe.xhrPatched);

  await browser.close();

  const failed = results.filter((r) => !r.passed);
  console.log("");
  if (failed.length === 0) {
    console.log(`冒烟测试通过（${results.length}/${results.length}）`);
    process.exit(0);
  }
  console.log(`冒烟测试失败：${failed.length}/${results.length} 项未通过`);
  if (consoleErrors.length) {
    console.log("\n页面 console.error：");
    consoleErrors.slice(0, 10).forEach((e) => console.log("  " + e));
  }
  process.exit(1);
}

main().catch((e) => {
  console.error("测试运行异常：", e.message);
  process.exit(1);
});
