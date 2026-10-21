import { elements, state } from "./02-state.js";
import { Core } from "./08-core.js";
/**
 * 启动/停止投递。
 *
 * v2.2.0 起只有一条路径：滚动收集岗位 → 逐个打开详情 → AI 判定 → 投递。
 * 原来的「AI 半自动单发」分支随招呼语预览框一起删除了。
 */
export function toggleProcess() {
  state.isRunning = !state.isRunning;

  if (state.isRunning) {
    state.comments.isCommentMode = false;
    state.jobList = [];

    if (elements.controlBtn) {
      elements.controlBtn.textContent = "停止投递";
      elements.controlBtn.style.background = "#ef4444";
    }

    const logPanel = document.querySelector("#pro-log");
    if (logPanel) logPanel.innerHTML = "";

    const startTime = new Date();
    Core.log(`开始运行，时间：${startTime.toLocaleTimeString()}`);
    Core.log("正在逐个打开岗位，交给 AI 判断是否投递…");

    Core.startProcessing();
  } else {
    if (elements.controlBtn) {
      elements.controlBtn.textContent = "开始投递";
      elements.controlBtn.style.background = "var(--primary-color)";
    }

    state.isRunning = false;
    state.currentIndex = 0;
    if (typeof Core.stopAutoScroll === "function") {
      try {
        Core.stopAutoScroll();
      } catch (e) {}
    }
  }
}

export function toggleChatProcess() {
  state.isRunning = !state.isRunning;

  if (state.isRunning) {
    elements.controlBtn.textContent = "停止聊天";
    // 与岗位页的停止按钮保持一致：运行中一律红色
    elements.controlBtn.style.background = "#ef4444";

    const startTime = new Date();
    Core.log(`开始聊天，时间：${startTime.toLocaleTimeString()}`);

    Core.startProcessing();
  } else {
    elements.controlBtn.textContent = "开始聊天";
    elements.controlBtn.style.background = "var(--primary-color)";

    state.isRunning = false;
    Core.resetChatScan();

    if (Core.messageObserver) {
      Core.messageObserver.disconnect();
      Core.messageObserver = null;
    }

    const stopTime = new Date();
    Core.log(`停止聊天，时间：${stopTime.toLocaleTimeString()}`);
  }
}
