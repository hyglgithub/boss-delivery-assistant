import { state } from "./02-state.js";
import { saveSettings } from "./06-settings.js";
import { debouncedSaveSettings } from "./15-settings-deferred.js";
export function addGreetingItem() {
  if (!state.settings.greetingsList) {
    state.settings.greetingsList = [];
  }

  const hasEmpty = state.settings.greetingsList.some((greeting) => !greeting.content.trim());

  if (hasEmpty) {
    return;
  }

  const newGreeting = {
    id: Date.now().toString(),
    content: "",
  };

  state.settings.greetingsList.push(newGreeting);
  saveSettings();
  renderGreetingsList();
}

export function renderGreetingsList() {
  const greetingsList = document.getElementById("greetings-list");
  if (!greetingsList) return;

  greetingsList.innerHTML = "";

  if (!state.settings.greetingsList || state.settings.greetingsList.length === 0) {
    greetingsList.innerHTML =
      '<div style="color: #6b7280; text-align: center; padding: 20px;">暂无打招呼内容</div>';
    return;
  }

  state.settings.greetingsList.forEach((greeting, index) => {
    const isLast = index === state.settings.greetingsList.length - 1;
    const greetingElement = document.createElement("div");
    greetingElement.className = "greeting-item";
    greetingElement.style.cssText = `
        display: flex;
        align-items: center;
        margin-bottom: ${isLast ? "0" : "12px"};
      `;

    const indexEl = document.createElement("span");
    indexEl.className = "greeting-index";
    indexEl.textContent = `${index + 1}.`;
    indexEl.style.cssText =
      "width:24px;flex-shrink:0;text-align:right;margin-right:8px;font-size:14px;color:#333;";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "greeting-input";
    input.dataset.id = greeting.id;
    input.placeholder = index === 0 ? "第一行：网页自动发送的打招呼语" : "后续消息";
    input.style.cssText = `
        flex: 1;
        height: 38px;
        padding: 0 12px;
        border: 1px solid #e8e8e8;
        border-radius: 4px;
        font-size: 14px;
        color: #333;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.2s;
      `;
    input.addEventListener("focus", () => {
      input.style.borderColor = "#1a73e8";
    });
    input.addEventListener("blur", () => {
      input.style.borderColor = "#e8e8e8";
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-greeting-btn settings-btn settings-btn-danger";
    deleteBtn.dataset.id = greeting.id;
    deleteBtn.textContent = "删除";
    deleteBtn.style.cssText = "margin-left:12px;width:56px;padding:0;flex-shrink:0;";

    greetingElement.append(indexEl, input, deleteBtn);
    greetingsList.appendChild(greetingElement);
  });

  attachGreetingEventListeners();
}

export function attachGreetingEventListeners() {
  document.querySelectorAll(".delete-greeting-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const greetingId = e.target.dataset.id;
      state.settings.greetingsList = state.settings.greetingsList.filter(
        (g) => g.id !== greetingId,
      );
      saveSettings();
      renderGreetingsList();
    });
  });

  document.querySelectorAll(".greeting-input").forEach((input) => {
    const greetingId = input.dataset.id;
    const greeting = (state.settings.greetingsList || []).find((g) => g.id === greetingId);
    // 用 property 赋值，避免内容里的引号破坏 HTML（旧版用 value="..." 会截断）
    if (greeting) input.value = greeting.content || "";

    input.addEventListener("input", (e) => {
      const target = (state.settings.greetingsList || []).find((g) => g.id === greetingId);
      if (target) {
        target.content = e.target.value;
        debouncedSaveSettings();
      }
    });
  });
}

/* =========================================================================
 * 简历文件解析（v2.1.0 修复：旧版直接对 .docx 做 UTF-8 文本搜索，
 * 但 .docx 本质是 ZIP 压缩包，所以旧版"Word 导入"实际上永远解析不出内容）
 * ========================================================================= */

/** 用浏览器原生 DecompressionStream 解压（Chrome/Edge 80+ 支持） */
