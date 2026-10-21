import { CONFIG } from "./01-config.js";
import { state } from "./02-state.js";
import { DOMCache, ErrorHandler, StorageManager } from "./03-infra.js";
import { Core } from "./08-core.js";
export class HRInteractionManager {
  /**
   * 账本键：优先用 chatStore 的稳定 uid，其次 encryptBossId，
   * 最后才退回旧版「名字-公司」。旧键只用于兼容，不再新写。
   */
  static ledgerKey(target) {
    if (!target) return "";
    if (typeof target === "string") return target;
    if (target.ledgerKey) return target.ledgerKey;
    if (target.uid !== undefined && target.uid !== null && String(target.uid) !== "") {
      return `uid:${target.uid}`;
    }
    if (target.encryptBossId) return `boss:${target.encryptBossId}`;
    return this.legacyKey(target);
  }

  /** 旧版账本键，只用于读取已有记录 */
  static legacyKey(target) {
    if (!target || typeof target === "string") return "";
    const name = target.name || "未知";
    const company = target.company || target.brandName || "";
    return `${name}-${company}`.toLowerCase();
  }

  /**
   * 同时检查稳定键和旧键。
   * 升级前写进 localStorage 的是「名字-公司」，如果只查 uid，
   * 这些 HR 会被当成"没打过招呼"，所有旧会话都会被重新检查、重发后续消息。
   */
  static hasLedger(set, target) {
    if (!set) return false;
    const key = this.ledgerKey(target);
    const legacy = this.legacyKey(target);
    return (!!key && set.has(key)) || (!!legacy && set.has(legacy));
  }

  static displayName(target) {
    if (!target) return "未知";
    if (typeof target === "string") return target;
    const name = target.name || "未知";
    const company = target.company || target.brandName || "";
    return company ? `${name} / ${company}` : name;
  }

  /** 「仅新消息」传进来的是字符串 hrKey，自动轮询传的是 chatStore 信息对象 */
  static normalizeTarget(target) {
    if (target && typeof target === "object") return target;
    return { ledgerKey: String(target || ""), name: String(target || "未知"), company: "" };
  }

  /**
   * 处理HR交互
   * @param {string|object} target - 旧版 hrKey 字符串，或 {uid,name,company,ledgerKey}
   * @returns {Promise<void>}
   */
  static async handleHRInteraction(target) {
    const t = this.normalizeTarget(target);
    const hasResponded = await this.hasHRResponded();

    if (!this.hasLedger(state.hrInteractions.sentGreetingsHRs, t)) {
      await this._handleFirstInteraction(t);
      return;
    }

    if (
      !this.hasLedger(state.hrInteractions.sentResumeHRs, t) ||
      !this.hasLedger(state.hrInteractions.sentImageResumeHRs, t)
    ) {
      if (hasResponded) {
        await this._handleFollowUpResponse(t);
      }
    }
  }

  static async _handleFirstInteraction(target) {
    Core.log(`首次沟通: ${this.displayName(target)}`);

    const greetingMatched = await this.sendGreetings();
    if (!greetingMatched) return;

    StorageManager.addRecordWithLimit(
      CONFIG.STORAGE_KEYS.SENT_GREETINGS_HRS,
      this.ledgerKey(target),
      state.hrInteractions.sentGreetingsHRs,
      CONFIG.STORAGE_LIMITS.SENT_GREETINGS_HRS,
    );

    await this._handleResumeSending(target);
  }

  static async _handleResumeSending(target) {
    if (
      state.settings.useAutoSendResume &&
      !this.hasLedger(state.hrInteractions.sentResumeHRs, target)
    ) {
      const sentResume = await this.sendResume();
      if (sentResume) {
        StorageManager.addRecordWithLimit(
          CONFIG.STORAGE_KEYS.SENT_RESUME_HRS,
          this.ledgerKey(target),
          state.hrInteractions.sentResumeHRs,
          CONFIG.STORAGE_LIMITS.SENT_RESUME_HRS,
        );
      }
    }

    if (
      state.settings.useAutoSendImageResume &&
      !this.hasLedger(state.hrInteractions.sentImageResumeHRs, target)
    ) {
      const sentImageResume = await this.sendImageResume();
      if (sentImageResume) {
        StorageManager.addRecordWithLimit(
          CONFIG.STORAGE_KEYS.SENT_IMAGE_RESUME_HRS,
          this.ledgerKey(target),
          state.hrInteractions.sentImageResumeHRs,
          CONFIG.STORAGE_LIMITS.SENT_IMAGE_RESUME_HRS,
        );
      }
    }
  }

  static async _handleFollowUpResponse(target) {
    if (this.hasCardMessage()) {
      const handled = await this.handleCardMessage(target);
      if (handled) {
        return;
      }
    }

    const lastMessage = await Core.getLastFriendMessageText();

    if (lastMessage && (lastMessage.includes("简历") || lastMessage.includes("发送简历"))) {
      Core.log(`HR提到"简历"，发送简历: ${this.displayName(target)}`);

      if (
        state.settings.useAutoSendImageResume &&
        !this.hasLedger(state.hrInteractions.sentImageResumeHRs, target)
      ) {
        const sentImageResume = await this.sendImageResume();
        if (sentImageResume) {
          StorageManager.addRecordWithLimit(
            CONFIG.STORAGE_KEYS.SENT_IMAGE_RESUME_HRS,
            this.ledgerKey(target),
            state.hrInteractions.sentImageResumeHRs,
            CONFIG.STORAGE_LIMITS.SENT_IMAGE_RESUME_HRS,
          );
          Core.log(`已向 ${this.displayName(target)} 发送图片简历`);
          return;
        }
      }

      if (
        state.settings.useAutoSendResume &&
        !this.hasLedger(state.hrInteractions.sentResumeHRs, target)
      ) {
        const sentResume = await this.sendResume();
        if (sentResume) {
          StorageManager.addRecordWithLimit(
            CONFIG.STORAGE_KEYS.SENT_RESUME_HRS,
            this.ledgerKey(target),
            state.hrInteractions.sentResumeHRs,
            CONFIG.STORAGE_LIMITS.SENT_RESUME_HRS,
          );
          Core.log(`已向 ${this.displayName(target)} 发送简历`);
        }
      }
    }
  }

  /**
   * 发送自定义回复
   * @param {string} replyText - 回复文本
   * @returns {Promise<boolean>} 是否发送成功
   */
  static async sendCustomReply(replyText) {
    try {
      const inputBox = await Core.waitForElement("#chat-input");
      if (!inputBox) {
        Core.log("未找到聊天输入框");
        return false;
      }

      inputBox.textContent = "";
      inputBox.focus();
      document.execCommand("insertText", false, replyText);
      await Core.delay(CONFIG.OPERATION_INTERVAL / 10);

      const sendButton = DOMCache.get(".btn-send");
      if (sendButton) {
        await Core.simulateClick(sendButton);
      } else {
        const enterKeyEvent = new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 13,
          code: "Enter",
          which: 13,
          bubbles: true,
        });
        inputBox.dispatchEvent(enterKeyEvent);
      }

      return true;
    } catch (error) {
      ErrorHandler.handle(error, "HRInteractionManager.sendCustomReply");
      Core.log(`发送自定义回复出错: ${error.message}`);
      return false;
    }
  }

  static async hasHRResponded() {
    await Core.delay(state.settings.actionDelays.click);

    const chatContainer = DOMCache.get(".chat-message .im-list");
    if (!chatContainer) return false;

    const friendMessages = Array.from(
      chatContainer.querySelectorAll("li.message-item.item-friend"),
    );
    return friendMessages.length > 0;
  }

  static hasCardMessage() {
    try {
      const chatContainer = DOMCache.get(".chat-message .im-list");
      if (!chatContainer) return false;

      const friendMessages = Array.from(
        chatContainer.querySelectorAll("li.message-item.item-friend"),
      );
      if (friendMessages.length === 0) return false;

      const lastMessageEl = friendMessages[friendMessages.length - 1];
      const cardWrap = lastMessageEl.querySelector(".message-card-wrap");
      return cardWrap !== null;
    } catch (error) {
      Core.log(`检测卡片消息出错: ${error.message}`);
      return false;
    }
  }

  static async handleCardMessage(target) {
    try {
      const chatContainer = DOMCache.get(".chat-message .im-list");
      if (!chatContainer) {
        Core.log("未找到聊天容器");
        return false;
      }

      const friendMessages = Array.from(
        chatContainer.querySelectorAll("li.message-item.item-friend"),
      );
      if (friendMessages.length === 0) {
        Core.log("未找到HR消息");
        return false;
      }

      const lastMessageEl = friendMessages[friendMessages.length - 1];
      const cardButtons = lastMessageEl.querySelectorAll(".card-btn");

      if (!cardButtons || cardButtons.length === 0) {
        Core.log("未找到卡片按钮");
        return false;
      }

      for (const btn of cardButtons) {
        if (btn.textContent.trim() === "同意") {
          // 默认不自动同意：这是把联系方式交给对方，应该由用户显式开启
          if (!state.settings.autoAcceptCard) {
            Core.log("检测到交换联系方式卡片，未自动点「同意」（可在设置 → 聊天里开启）");
            return false;
          }
          await Core.simulateClick(btn);
          await Core.delay(state.settings.actionDelays.click);
          return true;
        }
      }

      Core.log(`未找到"同意"按钮`);
      return false;
    } catch (error) {
      Core.log(`处理卡片消息出错: ${error.message}`);
      return false;
    }
  }

  static greetingContents() {
    return (state.settings.greetingsList || []).map((g) => String(g.content || "").trim());
  }

  static previewText(text, max = 40) {
    const s = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    return s.length > max ? s.slice(0, max) + "…" : s;
  }

  /**
   * 打招呼列表 = [网页自动发出的招呼语, 后续消息...]。
   *
   * 只有当前会话里「最后一条我方消息」与列表第一行一致时，才说明这次沟通
   * 是通过 /job 页「立即沟通」发起、BOSS 已经替我们发过第一行；此时只发第二行
   * 及以后的内容，第一行不再重复发送。不一致就什么都不发，也不记账。
   *
   * @returns {Promise<boolean>} 是否匹配成功（可以视为首次沟通已完成）
   */
  static async sendGreetings() {
    try {
      const contents = this.greetingContents();
      if (contents.length === 0) {
        Core.log("打招呼列表为空，跳过");
        return false;
      }

      const expected = contents[0];
      if (!expected) {
        Core.log("打招呼列表第一行（网页自动发送的招呼语）为空，无法匹配，跳过");
        return false;
      }

      const lastSelf = await Core.getLastSelfMessageText();
      if (!lastSelf) {
        Core.log("未找到我方已发送的消息，无法匹配打招呼首行，跳过");
        return false;
      }

      if (Core.cleanMessage(lastSelf) !== Core.cleanMessage(expected)) {
        Core.log(`最后一条我方消息与打招呼首行不一致，跳过（我方：${this.previewText(lastSelf)}）`);
        return false;
      }

      const followUps = contents.slice(1).filter(Boolean);
      if (followUps.length === 0) {
        Core.log("打招呼首行已匹配，没有需要发送的后续消息");
        return true;
      }

      for (let i = 0; i < followUps.length; i++) {
        Core.log(`发送后续消息（${i + 1}/${followUps.length}）：${this.previewText(followUps[i])}`);
        await this.sendCustomReply(followUps[i]);
        await Core.delay(state.settings.actionDelays.click);
      }

      return true;
    } catch (error) {
      Core.log(`发送打招呼后续消息出错: ${error.message}`);
      return false;
    }
  }

  static _findMatchingResume(resumeItems, positionName) {
    try {
      const positionNameLower = positionName.toLowerCase();
      const twoCharKeywords = Core.extractTwoCharKeywords(positionNameLower);

      for (const keyword of twoCharKeywords) {
        for (const item of resumeItems) {
          const resumeNameElement = item.querySelector(".resume-name");
          if (!resumeNameElement) continue;

          const resumeName = resumeNameElement.textContent.trim().toLowerCase();

          if (resumeName.includes(keyword)) {
            const resumeNameText = resumeNameElement.textContent.trim();
            Core.log(`智能匹配: "${resumeNameText}" 依据: "${keyword}"`);
            return item;
          }
        }
      }

      return null;
    } catch (error) {
      Core.log(`简历匹配出错: ${error.message}`);
      return null;
    }
  }

  static async sendResume() {
    try {
      const resumeBtn = await Core.waitForElement(() => {
        return [...document.querySelectorAll(".toolbar-btn")].find(
          (el) => el.textContent.trim() === "发简历",
        );
      });

      if (!resumeBtn) {
        Core.log("无法发送简历，未找到发简历按钮");
        return false;
      }

      if (resumeBtn.classList.contains("unable")) {
        Core.log("对方未回复，您无权发送简历");
        return false;
      }

      let positionName = Core.getPositionName();
      if (!positionName) {
        Core.log("未找到岗位名称元素");
      }

      await Core.simulateClick(resumeBtn);
      await Core.smartDelay(state.settings.actionDelays.click, "click");
      await Core.smartDelay(800, "resume_load");

      const confirmDialog = document.querySelector(".panel-resume.sentence-popover");
      if (confirmDialog) {
        Core.log("您只有一份附件简历");

        const confirmBtn = confirmDialog.querySelector(".btn-sure-v2");
        if (!confirmBtn) {
          Core.log("未找到确认按钮");
          return false;
        }

        await Core.simulateClick(confirmBtn);
        return true;
      }

      const resumeList = await Core.waitForElement("ul.resume-list");
      if (!resumeList) {
        Core.log("未找到简历列表");
        return false;
      }

      const resumeItems = Array.from(resumeList.querySelectorAll("li.list-item"));
      if (resumeItems.length === 0) {
        Core.log("未找到简历列表项");
        return false;
      }

      let selectedResumeItem = null;
      if (positionName) {
        selectedResumeItem = this._findMatchingResume(resumeItems, positionName);
      }

      if (!selectedResumeItem) {
        selectedResumeItem = resumeItems[0];
        const resumeName = selectedResumeItem.querySelector(".resume-name").textContent.trim();
        Core.log('使用第一个简历: "' + resumeName + '"');
      }

      await Core.simulateClick(selectedResumeItem);
      await Core.smartDelay(state.settings.actionDelays.click, "click");
      await Core.smartDelay(500, "selection");

      const sendBtn = await Core.waitForElement("button.btn-v2.btn-sure-v2.btn-confirm");
      if (!sendBtn) {
        Core.log("未找到发送按钮");
        return false;
      }

      if (sendBtn.disabled) {
        Core.log("发送按钮不可用，可能简历未正确选择");
        return false;
      }

      await Core.simulateClick(sendBtn);
      return true;
    } catch (error) {
      Core.log(`发送简历出错: ${error.message}`);
      return false;
    }
  }

  static selectImageResume(positionName) {
    try {
      const positionNameLower = positionName.toLowerCase();

      if (state.settings.imageResumes.length === 1) {
        return state.settings.imageResumes[0];
      }

      const twoCharKeywords = Core.extractTwoCharKeywords(positionNameLower);

      for (const keyword of twoCharKeywords) {
        for (const resume of state.settings.imageResumes) {
          const resumeNameLower = resume.path.toLowerCase();

          if (resumeNameLower.includes(keyword)) {
            Core.log(`智能匹配: "${resume.path}" 依据: "${keyword}"`);
            return resume;
          }
        }
      }

      return state.settings.imageResumes[0];
    } catch (error) {
      Core.log(`选择图片简历出错: ${error.message}`);
      return state.settings.imageResumes[0] || null;
    }
  }

  static async sendImageResume() {
    try {
      if (
        !state.settings.useAutoSendImageResume ||
        !state.settings.imageResumes ||
        state.settings.imageResumes.length === 0
      ) {
        return false;
      }

      let positionName = Core.getPositionName();
      if (!positionName) {
        Core.log("未找到岗位名称元素");
      }

      const selectedResume = this.selectImageResume(positionName);

      if (!selectedResume || !selectedResume.data) {
        Core.log("没有可发送的图片简历数据");
        return false;
      }

      const imageSendBtn = await Core.waitForElement(
        '.toolbar-btn-content.icon.btn-sendimg input[type="file"]',
      );
      if (!imageSendBtn) {
        Core.log("未找到图片发送按钮");
        return false;
      }

      const byteCharacters = atob(selectedResume.data.split(",")[1]);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: "image/jpeg" });

      const file = new File([blob], selectedResume.path, {
        type: "image/jpeg",
        lastModified: new Date().getTime(),
      });

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      imageSendBtn.files = dataTransfer.files;

      const event = new Event("change", { bubbles: true });
      imageSendBtn.dispatchEvent(event);
      return true;
    } catch (error) {
      Core.log(`发送图片出错: ${error.message}`);
      return false;
    }
  }
}
