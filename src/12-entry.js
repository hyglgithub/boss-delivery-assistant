import { PAGE } from "./01-config.js";
import { elements, state } from "./02-state.js";
import { APIInterceptor, StatePersistence } from "./03-infra.js";
import { UI } from "./05-ui.js";
import { showNotification } from "./07-settings-dialog.js";
import { Core } from "./08-core.js";

/** 等 document.body 可用，避免脚本注入过早导致面板挂不上 */
export function waitForBody(timeout = 15000) {
  return new Promise((resolve) => {
    if (document.body) return resolve(true);
    const start = Date.now();
    const timer = setInterval(() => {
      if (document.body) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - start > timeout) {
        clearInterval(timer);
        resolve(false);
      }
    }, 50);
  });
}

export async function init() {
  try {
    // 配置加载 + 页面识别（旧版从未调用 loadState，导致筛选条件、存储上限都失效）
    StatePersistence.loadState();
    APIInterceptor.init();

    const ok = await waitForBody();
    if (!ok || !document.body) {
      console.warn("[BOSS投递助手] 页面结构不可用，放弃注入");
      return;
    }

    UI.init();
    try {
      document.body.style.position = "relative";
    } catch (e) {}

    // 面板被 BOSS 的重新渲染顶掉时自动补挂
    startPanelWatchdog();

    if (PAGE.isJobList()) {
      // v2.2.1 起不再自动弹任何东西：欢迎信整封删除，引导浮层也改为按需手动调起。
      // 打开页面就盖一层全屏遮罩，每次升级都要手动关一次，反馈很明确。
      Core.log("欢迎使用 BOSS投递助手。点「开始投递」后，我会逐个打开岗位交给 AI 判断是否投递。");
    } else if (PAGE.isChat()) {
      Core.log("欢迎使用 BOSS投递助手，我将自动发送简历！");
    } else if (PAGE.isGreetSettings()) {
      Core.log("欢迎使用 BOSS投递助手，正在检测招呼语开关…");
      Core.handleGreetSettingsPage();
    } else {
      Core.log("当前页面暂不支持，请打开 BOSS 直聘职位列表页（www.zhipin.com/web/geek/jobs）");
    }
  } catch (error) {
    console.error("[BOSS投递助手] 初始化失败:", error);
    // 不再使用 alert 打断用户，改为页面内提示，并保证面板仍可用
    try {
      if (typeof showNotification === "function") {
        showNotification("BOSS投递助手初始化异常：" + error.message, "error");
      }
    } catch (e) {}
  }
}

/* ---------------- v2.1.0 新增：面板守护 & 单页路由切换 ---------------- */
export let panelWatchdogTimer = null;

export function startPanelWatchdog() {
  if (panelWatchdogTimer) return;
  panelWatchdogTimer = setInterval(() => {
    try {
      if (!document.body) return;
      if (!document.getElementById("boss-pro-panel")) {
        console.warn("[BOSS投递助手] 面板丢失，重新注入");
        UI.createControlPanel();
        if (!document.getElementById("boss-mini-icon") && !elements.miniIcon) {
          UI.createMiniIcon();
        }
      }
    } catch (e) {
      console.error("[BOSS投递助手] 面板守护异常:", e);
    }
  }, 3000);
}

// 在 start() 里初始化，不在模块顶层求值：模块图有环，此处 PAGE 可能尚未就绪
export let lastPageKey = null;

export function handleRouteChange() {
  const key = PAGE.key();
  if (key === lastPageKey) return;
  lastPageKey = key;

  console.log("[BOSS投递助手] 页面切换到:", key);

  if (state.isRunning) {
    state.isRunning = false;
    state.currentIndex = 0;
    state.jobList = [];
    Core.log("页面已切换，已停止当前任务");
  }

  // BOSS 是单页应用，切换路由后旧面板内容不再适用，重建
  try {
    const oldPanel = document.getElementById("boss-pro-panel");
    if (oldPanel) oldPanel.remove();
    const oldMini = document.getElementById("boss-mini-icon");
    if (oldMini) oldMini.remove();
    elements.panel = null;
    elements.miniIcon = null;
    elements.controlBtn = null;
    Core.clearDomCache();
    UI.init();
  } catch (e) {
    console.error("[BOSS投递助手] 重建面板失败:", e);
  }
}

/**
 * 启动脚本。由 main.js 在所有模块求值完成后调用。
 *
 * 不能在模块顶层直接调用 init()/watchRoute()：模块图存在环
 *   12-entry → 03-infra → 08-core → 05-ui → 09-process → 12-entry
 * 顶层调用时依赖可能还没初始化，曾表现为 StatePersistence undefined
 * 导致整个脚本静默失效。放在这里由入口统一触发即可规避。
 */
export function start() {
  lastPageKey = PAGE.key();
  init();
  watchRoute();
}

// 单页路由监听：同时监听 history 变化与 DOM 变化，双保险
function watchRoute() {
  ["pushState", "replaceState"].forEach((name) => {
    const orig = history[name];
    if (typeof orig !== "function") return;
    history[name] = function () {
      const ret = orig.apply(this, arguments);
      setTimeout(handleRouteChange, 60);
      return ret;
    };
  });
  window.addEventListener("popstate", () => setTimeout(handleRouteChange, 60));

  let lastHref = location.href;
  const mo = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(handleRouteChange, 60);
    }
  });
  if (document.documentElement) {
    mo.observe(document.documentElement, { subtree: true, childList: true });
  }
}
