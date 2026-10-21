#!/usr/bin/env node
/**
 * 行为比对：把两个版本的 userscript 分别加载进同一份页面 fixture，
 * dump 出脚本产生的 DOM 与运行时状态，再逐项比对。
 *
 * 为什么需要它：
 *   模块化重构后，产物结构必然变化（esbuild 重排、重命名、常量折叠），
 *   "逐字节相同"或"AST 等价"这类静态比对都不再适用。真正该问的是：
 *   脚本跑起来之后，页面上的结果是否一致。这个脚本回答那个问题。
 *
 * 用法: node tools/behavior-diff.js <旧版本.js> <新版本.js>
 * 退出码: 0 = 行为一致, 1 = 有差异
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const JOB_PAGE_URL = "https://www.zhipin.com/web/geek/jobs";

const FIXTURE = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>BOSS直聘</title></head>
<body>
  <div class="job-list-box">
    <ul>
      <li class="job-card-box" data-jobid="test-job-1">
        <a class="job-name" href="/job_detail/test-job-1.html">前端开发工程师</a>
        <span class="company-name">测试公司</span>
        <span class="job-area">北京</span>
        <span class="salary">20-40K</span>
      </li>
      <li class="job-card-box" data-jobid="test-job-2">
        <a class="job-name" href="/job_detail/test-job-2.html">Node.js 开发工程师</a>
        <span class="company-name">另一家公司</span>
        <span class="job-area">上海</span>
        <span class="salary">25-45K</span>
      </li>
    </ul>
  </div>
</body>
</html>`;

/** 在页面里跑脚本，返回一份可比较的快照 */
async function snapshot(browser, script) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.route(JOB_PAGE_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: FIXTURE }),
  );
  await page.goto(JOB_PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.GM_setValue = () => undefined;
    window.GM_getValue = () => undefined;
    window.GM_xmlhttpRequest = () => undefined;
  });

  await page.addScriptTag({ content: script });
  await page.waitForTimeout(1200); // 等 init 的异步流程走完

  const snap = await page.evaluate(() => {
    // 只取脚本注入的元素，排除 fixture 自身的节点；顺序无关，故排序
    const isOurs = (el) =>
      /^(boss-|letter-|envelope|guide-|ai-|greeting|pro-|stat-|toggle-|resume|uploaded|add-image|image-resume|parsed-|recruiter|apply-|max-|multi-|setting|parsed)/.test(
        el.id || "",
      ) || /boss-|guide-|letter|envelope|setting-item|multi-select/.test(el.className || "");

    const nodes = [];
    document.querySelectorAll("*").forEach((el) => {
      const id = el.id || "";
      const cls = typeof el.className === "string" ? el.className : "";
      if (!id && !cls) return;
      if (el.closest("#boss-pro-panel") && el !== document.getElementById("boss-pro-panel")) {
        // 面板内部的元素单独收，避免重复
      }
      if (!isOurs(el)) return;
      nodes.push({
        tag: el.tagName,
        id,
        cls,
        text: (el.textContent || "").trim().slice(0, 60),
      });
    });
    nodes.sort((a, b) => (a.id + a.cls + a.tag).localeCompare(b.id + b.cls + b.tag));

    return {
      nodeCount: nodes.length,
      nodes,
      xhrPatched: !/native code/.test(String(XMLHttpRequest.prototype.open)),
      historyPatched: !/\[native code\]/.test(String(history.pushState)),
      styleTags: document.head.querySelectorAll("style").length,
      leaked: ["Core", "UI", "state", "CONFIG", "settings", "init"].filter(
        (k) => typeof window[k] !== "undefined",
      ),
    };
  });

  await page.close();
  return { snap, errors };
}

function diffLists(name, a, b) {
  const sa = new Set(a.map((x) => JSON.stringify(x)));
  const sb = new Set(b.map((x) => JSON.stringify(x)));
  const onlyA = [...sa].filter((x) => !sb.has(x));
  const onlyB = [...sb].filter((x) => !sa.has(x));
  if (!onlyA.length && !onlyB.length) {
    console.log(`  ${name}: 一致 ✅ (${a.length})`);
    return 0;
  }
  console.log(`  ${name}: 不一致 ❌  仅旧版 ${onlyA.length}，仅新版 ${onlyB.length}`);
  onlyA.slice(0, 5).forEach((x) => console.log(`      仅旧版: ${x.slice(0, 160)}`));
  onlyB.slice(0, 5).forEach((x) => console.log(`      仅新版: ${x.slice(0, 160)}`));
  return 1;
}

async function main() {
  const [fileA, fileB] = process.argv.slice(2);
  if (!fileA || !fileB) {
    console.error("用法: node tools/behavior-diff.js <旧版本.js> <新版本.js>");
    process.exit(2);
  }

  const browser = await chromium.launch();
  const A = await snapshot(browser, fs.readFileSync(fileA, "utf8"));
  const B = await snapshot(browser, fs.readFileSync(fileB, "utf8"));
  await browser.close();

  console.log(`旧版: ${path.basename(fileA)}`);
  console.log(`新版: ${path.basename(fileB)}\n`);

  let bad = 0;
  bad += diffLists("脚本产生的 DOM 节点", A.snap.nodes, B.snap.nodes);
  for (const key of ["xhrPatched", "historyPatched", "styleTags", "leaked"]) {
    const va = JSON.stringify(A.snap[key]);
    const vb = JSON.stringify(B.snap[key]);
    if (va === vb) console.log(`  ${key}: 一致 ✅ (${va})`);
    else {
      console.log(`  ${key}: 不一致 ❌ 旧=${va} 新=${vb}`);
      bad++;
    }
  }

  const ea = A.errors.sort().join("|");
  const eb = B.errors.sort().join("|");
  if (ea === eb) console.log(`  未捕获错误: 一致 ✅ (${A.errors.length})`);
  else {
    console.log(`  未捕获错误: 不一致 ❌\n    旧: ${ea}\n    新: ${eb}`);
    bad++;
  }

  console.log("");
  if (bad) {
    console.log(`行为比对失败：${bad} 项不一致`);
    process.exit(1);
  }
  console.log("行为比对通过：两个版本在页面上产生的结果一致");
}

main().catch((e) => {
  console.error("运行异常：", e);
  process.exit(1);
});
