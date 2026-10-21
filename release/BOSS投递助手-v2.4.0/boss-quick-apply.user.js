// ==UserScript==
// @name         BOSS投递助手
// @namespace    BOSS-Delivery-Assistant
// @version      2.4.0
// @description  BOSS直聘高效投递工具：AI智能判断岗位 + 批量投递
// @author       wok
// @match        https://www.zhipin.com/*
// @match        https://zhipin.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @connect      zhipin.com
// @connect      *
// @license      MIT
// @noframes
// ==/UserScript==

/**
 * v2.4.0
 * 1. 投递页：滚动收集岗位 → 逐个抓详情 → AI 按提示词判定 → 通过后点「立即沟通」；
 *    判定失败一律跳过，避免误投。
 * 2. 聊天页支持「仅新消息」和「自动轮询」；自动轮询按 chatStore 顺序从头到尾遍历，
 *    每条会话只打开一次，到尾部停止。打开会话会标为已读。
 * 3. 打招呼列表第 1 行是 BOSS 网页自动发送的招呼语；只有最后一条我方消息与它一致时，
 *    才发送第 2 行及以后的内容；不一致不发也不记账。
 * 4. 聊天页可自动发送附件简历 / 图片简历；交换卡片默认不自动同意。
 * 5. 设置页不再分标签，按分组展示：AI API、投递提示词、投递基础、打招呼、简历、其他；
 *    提示词通过「编辑提示词」弹窗编辑。
 * 6. 主题统一为蓝色，设置页白底蓝点缀；按钮、输入框、开关样式统一。
 * 7. 测试模式、AI 自动回复、关键词过滤、AI 角色定位、导出 AI 日志均已移除。
 * 8. 项目名 BOSS投递助手，作者 wok。
 */
(() => {
  var __defProp = Object.defineProperty;
  var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

  // src/01-config.js
  var CONFIG = {
    BASIC_INTERVAL: 1e3,
    OPERATION_INTERVAL: 1200,
    DELAYS: {
      SHORT: 30,
      MEDIUM_SHORT: 200
    },
    STORAGE_KEYS: {
      PROCESSED_HRS: "processedHRs",
      SENT_GREETINGS_HRS: "sentGreetingsHRs",
      SENT_RESUME_HRS: "sentResumeHRs",
      SENT_IMAGE_RESUME_HRS: "sentImageResumeHRs"
    },
    STORAGE_LIMITS: {
      PROCESSED_HRS: 500,
      SENT_GREETINGS_HRS: 500,
      SENT_RESUME_HRS: 300,
      SENT_IMAGE_RESUME_HRS: 300
    },
    API: {
      TIMEOUT: 2e4,
      RETRY_COUNT: 3,
      RETRY_DELAY: 1e3
    },
    // 聊天页「自动轮询」= 一次单向全量遍历：从 chatStore.friends 的第一条到底部，
    // 每条会话打开一次，到尾部自动停止（见 zhipin-chat-probe.md）。
    // 每次调用最多连续打开 MAX_SWEEP_PER_CALL 个，之间停 SWEEP_DELAY；
    // 两次调用之间停 POLL_INTERVAL，避免把 BOSS 的接口打得太密。
    CHAT: {
      POLL_INTERVAL: 2500,
      MAX_SWEEP_PER_CALL: 5,
      SWEEP_DELAY: 400
    },
    UI: {
      MINI_ICON_SIZE: 40,
      ANIMATION_DURATION: 300,
      DEBOUNCE_DELAY: 300,
      // 面板"收进屏幕外"的位移（最小化、以及设置弹窗打开时）。
      //
      // 必须用长度而不是百分比：translateY(160%) 里的百分比是相对**元素自身高度**算的，
      // 面板矮的时候（刚投完、日志区没几行）160% 只有两三百像素，
      // 从页面顶部滑下来还露着半截。100vh 与面板高矮无关，再加 100px 兜住
      // "面板顶部本来就在视口内"的余量。
      PANEL_HIDDEN_TRANSFORM: "translateY(calc(100vh + 100px))"
    },
    PERFORMANCE: {
      DOM_CACHE_MAX_AGE: 5e3,
      BATCH_SIZE: 10,
      CONCURRENT_LIMIT: 3
    },
    // 单次运行的安全上限，避免被风控
    SAFETY: {
      MAX_APPLY_PER_RUN: 50,
      MAX_SCROLL_STEPS: 30,
      APPLY_INTERVAL: 2500
    }
  };
  var PAGE = {
    isChat() {
      return location.pathname.indexOf("/chat") !== -1;
    },
    isGreetSettings() {
      return location.pathname.indexOf("/notify-set") !== -1;
    },
    isJobDetail() {
      return location.pathname.indexOf("/job_detail/") !== -1;
    },
    /** 职位列表页：/web/geek/job、/web/geek/jobs、/web/geek/recommend、/job_detail/xxx */
    isJobList() {
      const p = location.pathname;
      if (PAGE.isChat() || PAGE.isGreetSettings()) return false;
      return /\/web\/geek\/jobs?(\/|$)/.test(p) || /\/web\/geek\/recommend/.test(p) || /\/web\/geek\/job-list/.test(p) || PAGE.isJobDetail();
    },
    isSupported() {
      return PAGE.isJobList() || PAGE.isChat() || PAGE.isGreetSettings();
    },
    /** 页面标识，用于单页路由切换时判断是否需要重建面板 */
    key() {
      if (PAGE.isChat()) return "chat";
      if (PAGE.isGreetSettings()) return "greet-set";
      if (PAGE.isJobList()) return "job-list";
      return "other";
    }
  };

  // src/02-state.js
  var getStoredJSON = /* @__PURE__ */ __name((key, defaultValue) => {
    try {
      const val = localStorage.getItem(key);
      return val ? JSON.parse(val) : defaultValue;
    } catch (e) {
      console.error(`Error parsing ${key}:`, e);
      return defaultValue;
    }
  }, "getStoredJSON");
  var state = {
    isRunning: false,
    currentIndex: 0,
    jobList: [],
    ui: {
      isMinimized: false,
      theme: localStorage.getItem("theme") || "light"
    },
    hrInteractions: {
      processedHRs: new Set(getStoredJSON("processedHRs", [])),
      sentGreetingsHRs: new Set(getStoredJSON("sentGreetingsHRs", [])),
      sentResumeHRs: new Set(getStoredJSON("sentResumeHRs", [])),
      sentImageResumeHRs: new Set(getStoredJSON("sentImageResumeHRs", []))
    },
    // 注意：这里只是占位，脚本加载后会被 state.settings = settings 覆盖为唯一配置对象
    settings: {},
    // 运行统计（面板底部展示）
    stats: {
      greeted: 0,
      skipped: 0,
      failed: 0,
      startTime: 0
    },
    // 当前正在处理的职位标题，作为详情区取不到标题时的兜底
    currentJobTitle: "",
    comments: {
      currentCompanyName: "",
      commentsList: [],
      isLoading: false,
      isCommentMode: false
    },
    securityIdCache: /* @__PURE__ */ new Map()
  };
  var elements = {
    panel: null,
    controlBtn: null,
    log: null,
    miniIcon: null
  };

  // src/06-settings.js
  var PROMPT_RULES_DEFAULT = "\u4F60\u662F\u6C42\u804C\u8005\u7684\u6295\u9012\u52A9\u624B\u3002\u4F60\u4F1A\u6536\u5230\u6C42\u804C\u8005\u7684\u7B80\u5386\u3001\u6295\u9012\u8981\u6C42\u548C\u67D0\u4E2A\u5C97\u4F4D\u7684\u8BE6\u60C5\uFF0C\u8BF7\u5224\u65AD\u8FD9\u4E2A\u5C97\u4F4D\u662F\u5426\u503C\u5F97\u6295\u9012\u3002\u53EA\u6709\u5F53\u5C97\u4F4D\u4E0E\u7B80\u5386\u3001\u6295\u9012\u8981\u6C42\u90FD\u5339\u914D\u65F6\u624D\u5224\u4E3A\u503C\u5F97\u6295\u9012\uFF1B\u82E5\u5C97\u4F4D\u8981\u6C42\u660E\u663E\u8D85\u51FA\u7B80\u5386\u80FD\u529B\uFF0C\u6216\u8FDD\u53CD\u6295\u9012\u8981\u6C42\u91CC\u7684\u4EFB\u610F\u4E00\u6761\u786C\u6027\u6761\u4EF6\uFF0C\u5224\u4E3A\u4E0D\u503C\u5F97\uFF1B\u82E5\u4FE1\u606F\u4E0D\u8DB3\u4EE5\u5224\u65AD\uFF0C\u4E00\u5F8B\u5224\u4E3A\u4E0D\u503C\u5F97\u3002";
  var LEGACY_GREETING_RULE = "\u540C\u65F6\u4E3A\u503C\u5F97\u6295\u9012\u7684\u5C97\u4F4D\u5199\u4E00\u6761\u6253\u62DB\u547C\u6D88\u606F\uFF1A\u5148\u7B80\u6D01\u81EA\u6211\u4ECB\u7ECD\uFF08\u5B66\u5386/\u4E13\u4E1A/\u5E74\u9650\uFF09\uFF0C\u518D\u8BF4\u660E\u4E0E\u5C97\u4F4D\u5339\u914D\u7684\u6280\u80FD\u4E0E\u6210\u679C\uFF0C\u8868\u8FBE\u5C97\u4F4D\u610F\u5411\uFF0C\u6700\u540E\u8BE2\u95EE\u80FD\u5426\u53D1\u4E00\u4EFD\u7B80\u5386\uFF1B\u53E3\u8BED\u5316\u50CF\u771F\u4EBA\u804A\u5929\u300120-100 \u5B57\u3001\u4E0D\u8981\u5BA2\u5957\u5E9F\u8BDD\u3002";
  var PROMPT_SECTIONS_DEFAULT = "\n\n\u3010\u6211\u7684\u7B80\u5386\u3011\n\n\n\u3010\u6211\u7684\u6295\u9012\u8981\u6C42\u3011\n\n\n\u3010\u5C97\u4F4D\u6807\u9898\u3011\n{jobTitle}\n\n\u3010\u5C97\u4F4D\u8981\u6C42\u3011\n{jobDescription}";
  var PROMPT_TEMPLATE_DEFAULT = PROMPT_RULES_DEFAULT + PROMPT_SECTIONS_DEFAULT;
  var PROMPT_SECTIONS_LEGACY = "\n\n\u3010\u6211\u7684\u7B80\u5386\u3011\n{resume}\n\n\u3010\u6211\u7684\u6295\u9012\u8981\u6C42\u3011\n{require}\n\n\u3010\u5C97\u4F4D\u6807\u9898\u3011\n{jobTitle}\n\n\u3010\u5C97\u4F4D\u8981\u6C42\u3011\n{jobDescription}";
  var BUILTIN_PROMPT_VARS = ["jobTitle", "jobDescription"];
  var AI_JUDGE_SYSTEM_ROLE = '\u8BF7\u6309\u7528\u6237\u6D88\u606F\u91CC\u7684\u8981\u6C42\u5224\u65AD\u5C97\u4F4D\u662F\u5426\u503C\u5F97\u6295\u9012\u3002\u53EA\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981 markdown \u4EE3\u7801\u5757\u3001\u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u6587\u5B57\uFF0C\u683C\u5F0F\u4E3A\uFF1A{"match": true \u6216 false, "reason": "\u4E0D\u8D85\u8FC7 30 \u5B57\u7684\u4E2D\u6587\u7406\u7531"}';
  var SETTINGS_DEFAULTS = {
    // —— 运行模式 ——
    useAutoSendResume: false,
    // 自动发送附件简历
    useAutoSendImageResume: false,
    // 自动发送图片简历
    excludeHeadhunters: false,
    // 排除猎头
    useApiApply: false,
    // 尝试走站内接口投递（更快，但易随接口变动失效）
    autoAcceptCard: false,
    // HR 发来「交换联系方式」卡片时，自动点「同意」
    // —— 筛选 ——
    recruiterActivityStatus: ["\u4E0D\u9650"],
    // —— 聊天页 ——
    communicationMode: "new-only",
    // —— 节奏与安全上限 ——
    clickDelay: 130,
    applyInterval: 2500,
    maxApplyPerRun: 50,
    // —— 界面 ——
    theme: "light",
    panelPosition: null,
    // —— AI ——
    aiApiUrl: "https://api.deepseek.com/v1/chat/completions",
    aiApiKey: "",
    aiModel: "deepseek-chat",
    // 判定用的主提示词（简历等素材直接写在正文里，只剩 {jobTitle} / {jobDescription} 两个变量）
    promptTemplate: PROMPT_TEMPLATE_DEFAULT,
    greetingsList: [{ id: "1", content: "" }],
    // —— 图片简历 ——
    imageResumes: [],
    imageResumeData: null
  };
  var SettingsStore = {
    /** 布尔值安全解析（兼容 "true" / true / "1"） */
    readBool(key, def) {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === "") return def;
        if (raw === "true" || raw === "1") return true;
        if (raw === "false" || raw === "0") return false;
        return !!JSON.parse(raw);
      } catch (e) {
        return def;
      }
    },
    readJSON(key, def) {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === "") return def;
        const v = JSON.parse(raw);
        return v === null || v === void 0 ? def : v;
      } catch (e) {
        return def;
      }
    },
    readString(key, def) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? def : raw;
      } catch (e) {
        return def;
      }
    },
    readNumber(key, def) {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === "") return def;
        const n = parseInt(raw, 10);
        return isNaN(n) ? def : n;
      } catch (e) {
        return def;
      }
    },
    /** 读取全部配置（含旧键迁移） */
    load() {
      const D = SETTINGS_DEFAULTS;
      let greetingsList = this.readJSON("greetingsList", null);
      if (!Array.isArray(greetingsList) || greetingsList.length === 0) {
        greetingsList = JSON.parse(JSON.stringify(D.greetingsList));
      }
      greetingsList = greetingsList.filter((g) => g && typeof g === "object").map((g, i) => ({
        id: String(g.id || i + 1),
        content: typeof g.content === "string" ? g.content : ""
      }));
      let imageResumes = this.readJSON("imageResumes", []);
      if (!Array.isArray(imageResumes)) imageResumes = [];
      let activityStatus = this.readJSON("recruiterActivityStatus", D.recruiterActivityStatus);
      if (!Array.isArray(activityStatus) || activityStatus.length === 0) {
        activityStatus = ["\u4E0D\u9650"];
      }
      const storedVars = this.readJSON("promptVars", null);
      const legacyVars = storedVars === null ? (
        // v2.3.0 之前的三个老键
        [
          { name: "resume", value: this.readString("userResume", "") },
          { name: "require", value: this.readString("aiApplyCriteria", "") }
        ]
      ) : (Array.isArray(storedVars) ? storedVars : []).filter((v) => v && typeof v === "object").map((v) => ({
        name: typeof v.name === "string" ? v.name : "",
        value: typeof v.value === "string" ? v.value : ""
      }));
      const storedTemplate = this.readString("promptTemplate", null);
      const baseTemplate = storedTemplate === null ? (
        // 老用户改过的规则段要保留；数据段用**老版**（带 {resume}/{require}）补上，
        // 否则下面没得可填，userResume 里的简历会被静默丢掉
        this.readString("aiJudgePrompt", PROMPT_RULES_DEFAULT) + PROMPT_SECTIONS_LEGACY
      ) : storedTemplate;
      const mergedTemplate = inlinePromptVars(baseTemplate, legacyVars);
      const promptTemplate = mergedTemplate.split(LEGACY_GREETING_RULE).join("");
      if (storedVars !== null) {
        try {
          localStorage.setItem("promptTemplate", promptTemplate);
          localStorage.removeItem("promptVars");
        } catch (e) {
        }
      } else if (promptTemplate !== mergedTemplate) {
        try {
          localStorage.setItem("promptTemplate", promptTemplate);
        } catch (e) {
        }
      }
      return {
        useAutoSendResume: this.readBool("useAutoSendResume", D.useAutoSendResume),
        useAutoSendImageResume: this.readBool("useAutoSendImageResume", D.useAutoSendImageResume),
        excludeHeadhunters: this.readBool("excludeHeadhunters", D.excludeHeadhunters),
        useApiApply: this.readBool("useApiApply", D.useApiApply),
        autoAcceptCard: this.readBool("autoAcceptCard", D.autoAcceptCard),
        recruiterActivityStatus: activityStatus,
        communicationMode: this.readString("communicationMode", D.communicationMode),
        clickDelay: this.readNumber("clickDelay", D.clickDelay),
        applyInterval: this.readNumber("applyInterval", D.applyInterval),
        maxApplyPerRun: this.readNumber("maxApplyPerRun", D.maxApplyPerRun),
        theme: this.readString("theme", D.theme),
        panelPosition: this.readJSON("panelPosition", null),
        aiApiUrl: this.readString("aiApiUrl", D.aiApiUrl),
        aiApiKey: this.readString("aiApiKey", D.aiApiKey),
        aiModel: this.readString("aiModel", D.aiModel),
        promptTemplate,
        greetingsList,
        imageResumes,
        imageResumeData: this.readString("imageResumeData", null)
      };
    },
    /** 写入全部配置 */
    save(s) {
      if (!s) return;
      const write = /* @__PURE__ */ __name((k, v) => {
        try {
          localStorage.setItem(k, v === null || v === void 0 ? "" : String(v));
        } catch (e) {
          console.warn("[BOSS\u6295\u9012\u52A9\u624B] \u5199\u5165\u914D\u7F6E\u5931\u8D25", k, e);
        }
      }, "write");
      const writeJSON = /* @__PURE__ */ __name((k, v) => {
        try {
          localStorage.setItem(k, JSON.stringify(v));
        } catch (e) {
          console.warn("[BOSS\u6295\u9012\u52A9\u624B] \u5199\u5165\u914D\u7F6E\u5931\u8D25", k, e);
        }
      }, "writeJSON");
      write("useAutoSendResume", s.useAutoSendResume);
      write("useAutoSendImageResume", s.useAutoSendImageResume);
      write("excludeHeadhunters", s.excludeHeadhunters);
      write("useApiApply", s.useApiApply);
      write("autoAcceptCard", s.autoAcceptCard);
      writeJSON("recruiterActivityStatus", s.recruiterActivityStatus || ["\u4E0D\u9650"]);
      write("communicationMode", s.communicationMode);
      write("clickDelay", s.clickDelay);
      write("applyInterval", s.applyInterval);
      write("maxApplyPerRun", s.maxApplyPerRun);
      write("theme", s.theme);
      writeJSON("panelPosition", s.panelPosition);
      write("aiApiUrl", s.aiApiUrl);
      write("aiApiKey", s.aiApiKey);
      write("aiModel", s.aiModel);
      write("promptTemplate", s.promptTemplate);
      writeJSON("greetingsList", s.greetingsList || []);
      writeJSON("imageResumes", s.imageResumes || []);
      if (s.imageResumeData) write("imageResumeData", s.imageResumeData);
      else {
        try {
          localStorage.removeItem("imageResumeData");
        } catch (e) {
        }
      }
    }
  };
  var settings = SettingsStore.load();
  Object.defineProperty(settings, "ai", {
    enumerable: false,
    configurable: true,
    get() {
      const self = settings;
      return {
        get apiUrl() {
          return self.aiApiUrl;
        },
        set apiUrl(v) {
          self.aiApiUrl = v;
        },
        get apiKey() {
          return self.aiApiKey;
        },
        set apiKey(v) {
          self.aiApiKey = v;
        },
        get model() {
          return self.aiModel;
        },
        set model(v) {
          self.aiModel = v;
        }
      };
    }
  });
  Object.defineProperty(settings, "actionDelays", {
    enumerable: false,
    configurable: true,
    get() {
      const self = settings;
      return {
        get click() {
          return self.clickDelay;
        },
        set click(v) {
          self.clickDelay = v;
        }
      };
    }
  });
  state.settings = settings;
  function inlinePromptVars(template, vars) {
    const map = {};
    (vars || []).forEach((v) => {
      const name = v && v.name ? String(v.name).trim() : "";
      if (!name) return;
      if (BUILTIN_PROMPT_VARS.indexOf(name) !== -1) return;
      if (!(name in map)) map[name] = v.value == null ? "" : String(v.value);
    });
    return String(template || "").replace(
      /\{([A-Za-z0-9_-]+)\}/g,
      (whole, name) => name in map ? map[name] : whole
    );
  }
  __name(inlinePromptVars, "inlinePromptVars");
  function renderPrompt(template, runtimeVars) {
    const map = runtimeVars || {};
    const missing = [];
    const text = String(template || "").replace(/\{([A-Za-z0-9_-]+)\}/g, (whole, name) => {
      if (!(name in map) || !String(map[name]).trim()) {
        if (BUILTIN_PROMPT_VARS.indexOf(name) === -1 && missing.indexOf(name) === -1) {
          missing.push(name);
        }
        return whole;
      }
      return map[name];
    });
    return { text, missing };
  }
  __name(renderPrompt, "renderPrompt");
  function saveSettings() {
    try {
      SettingsStore.save(settings);
      if (state && state.settings) Object.assign(state.settings, settings);
      return true;
    } catch (error) {
      console.error("[BOSS\u6295\u9012\u52A9\u624B] \u4FDD\u5B58\u8BBE\u7F6E\u5931\u8D25:", error);
      return false;
    }
  }
  __name(saveSettings, "saveSettings");

  // src/04-hr-interaction.js
  var HRInteractionManager = class {
    static {
      __name(this, "HRInteractionManager");
    }
    /**
     * 账本键：优先用 chatStore 的稳定 uid，其次 encryptBossId，
     * 最后才退回旧版「名字-公司」。旧键只用于兼容，不再新写。
     */
    static ledgerKey(target) {
      if (!target) return "";
      if (typeof target === "string") return target;
      if (target.ledgerKey) return target.ledgerKey;
      if (target.uid !== void 0 && target.uid !== null && String(target.uid) !== "") {
        return `uid:${target.uid}`;
      }
      if (target.encryptBossId) return `boss:${target.encryptBossId}`;
      return this.legacyKey(target);
    }
    /** 旧版账本键，只用于读取已有记录 */
    static legacyKey(target) {
      if (!target || typeof target === "string") return "";
      const name = target.name || "\u672A\u77E5";
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
      return !!key && set.has(key) || !!legacy && set.has(legacy);
    }
    static displayName(target) {
      if (!target) return "\u672A\u77E5";
      if (typeof target === "string") return target;
      const name = target.name || "\u672A\u77E5";
      const company = target.company || target.brandName || "";
      return company ? `${name} / ${company}` : name;
    }
    /** 「仅新消息」传进来的是字符串 hrKey，自动轮询传的是 chatStore 信息对象 */
    static normalizeTarget(target) {
      if (target && typeof target === "object") return target;
      return { ledgerKey: String(target || ""), name: String(target || "\u672A\u77E5"), company: "" };
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
      if (!this.hasLedger(state.hrInteractions.sentResumeHRs, t) || !this.hasLedger(state.hrInteractions.sentImageResumeHRs, t)) {
        if (hasResponded) {
          await this._handleFollowUpResponse(t);
        }
      }
    }
    static async _handleFirstInteraction(target) {
      Core.log(`\u9996\u6B21\u6C9F\u901A: ${this.displayName(target)}`);
      const greetingMatched = await this.sendGreetings();
      if (!greetingMatched) return;
      StorageManager.addRecordWithLimit(
        CONFIG.STORAGE_KEYS.SENT_GREETINGS_HRS,
        this.ledgerKey(target),
        state.hrInteractions.sentGreetingsHRs,
        CONFIG.STORAGE_LIMITS.SENT_GREETINGS_HRS
      );
      await this._handleResumeSending(target);
    }
    static async _handleResumeSending(target) {
      if (state.settings.useAutoSendResume && !this.hasLedger(state.hrInteractions.sentResumeHRs, target)) {
        const sentResume = await this.sendResume();
        if (sentResume) {
          StorageManager.addRecordWithLimit(
            CONFIG.STORAGE_KEYS.SENT_RESUME_HRS,
            this.ledgerKey(target),
            state.hrInteractions.sentResumeHRs,
            CONFIG.STORAGE_LIMITS.SENT_RESUME_HRS
          );
        }
      }
      if (state.settings.useAutoSendImageResume && !this.hasLedger(state.hrInteractions.sentImageResumeHRs, target)) {
        const sentImageResume = await this.sendImageResume();
        if (sentImageResume) {
          StorageManager.addRecordWithLimit(
            CONFIG.STORAGE_KEYS.SENT_IMAGE_RESUME_HRS,
            this.ledgerKey(target),
            state.hrInteractions.sentImageResumeHRs,
            CONFIG.STORAGE_LIMITS.SENT_IMAGE_RESUME_HRS
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
      if (lastMessage && (lastMessage.includes("\u7B80\u5386") || lastMessage.includes("\u53D1\u9001\u7B80\u5386"))) {
        Core.log(`HR\u63D0\u5230"\u7B80\u5386"\uFF0C\u53D1\u9001\u7B80\u5386: ${this.displayName(target)}`);
        if (state.settings.useAutoSendImageResume && !this.hasLedger(state.hrInteractions.sentImageResumeHRs, target)) {
          const sentImageResume = await this.sendImageResume();
          if (sentImageResume) {
            StorageManager.addRecordWithLimit(
              CONFIG.STORAGE_KEYS.SENT_IMAGE_RESUME_HRS,
              this.ledgerKey(target),
              state.hrInteractions.sentImageResumeHRs,
              CONFIG.STORAGE_LIMITS.SENT_IMAGE_RESUME_HRS
            );
            Core.log(`\u5DF2\u5411 ${this.displayName(target)} \u53D1\u9001\u56FE\u7247\u7B80\u5386`);
            return;
          }
        }
        if (state.settings.useAutoSendResume && !this.hasLedger(state.hrInteractions.sentResumeHRs, target)) {
          const sentResume = await this.sendResume();
          if (sentResume) {
            StorageManager.addRecordWithLimit(
              CONFIG.STORAGE_KEYS.SENT_RESUME_HRS,
              this.ledgerKey(target),
              state.hrInteractions.sentResumeHRs,
              CONFIG.STORAGE_LIMITS.SENT_RESUME_HRS
            );
            Core.log(`\u5DF2\u5411 ${this.displayName(target)} \u53D1\u9001\u7B80\u5386`);
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
          Core.log("\u672A\u627E\u5230\u804A\u5929\u8F93\u5165\u6846");
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
            bubbles: true
          });
          inputBox.dispatchEvent(enterKeyEvent);
        }
        return true;
      } catch (error) {
        ErrorHandler.handle(error, "HRInteractionManager.sendCustomReply");
        Core.log(`\u53D1\u9001\u81EA\u5B9A\u4E49\u56DE\u590D\u51FA\u9519: ${error.message}`);
        return false;
      }
    }
    static async hasHRResponded() {
      await Core.delay(state.settings.actionDelays.click);
      const chatContainer = DOMCache.get(".chat-message .im-list");
      if (!chatContainer) return false;
      const friendMessages = Array.from(
        chatContainer.querySelectorAll("li.message-item.item-friend")
      );
      return friendMessages.length > 0;
    }
    static hasCardMessage() {
      try {
        const chatContainer = DOMCache.get(".chat-message .im-list");
        if (!chatContainer) return false;
        const friendMessages = Array.from(
          chatContainer.querySelectorAll("li.message-item.item-friend")
        );
        if (friendMessages.length === 0) return false;
        const lastMessageEl = friendMessages[friendMessages.length - 1];
        const cardWrap = lastMessageEl.querySelector(".message-card-wrap");
        return cardWrap !== null;
      } catch (error) {
        Core.log(`\u68C0\u6D4B\u5361\u7247\u6D88\u606F\u51FA\u9519: ${error.message}`);
        return false;
      }
    }
    static async handleCardMessage(target) {
      try {
        const chatContainer = DOMCache.get(".chat-message .im-list");
        if (!chatContainer) {
          Core.log("\u672A\u627E\u5230\u804A\u5929\u5BB9\u5668");
          return false;
        }
        const friendMessages = Array.from(
          chatContainer.querySelectorAll("li.message-item.item-friend")
        );
        if (friendMessages.length === 0) {
          Core.log("\u672A\u627E\u5230HR\u6D88\u606F");
          return false;
        }
        const lastMessageEl = friendMessages[friendMessages.length - 1];
        const cardButtons = lastMessageEl.querySelectorAll(".card-btn");
        if (!cardButtons || cardButtons.length === 0) {
          Core.log("\u672A\u627E\u5230\u5361\u7247\u6309\u94AE");
          return false;
        }
        for (const btn of cardButtons) {
          if (btn.textContent.trim() === "\u540C\u610F") {
            if (!state.settings.autoAcceptCard) {
              Core.log("\u68C0\u6D4B\u5230\u4EA4\u6362\u8054\u7CFB\u65B9\u5F0F\u5361\u7247\uFF0C\u672A\u81EA\u52A8\u70B9\u300C\u540C\u610F\u300D\uFF08\u53EF\u5728\u8BBE\u7F6E \u2192 \u804A\u5929\u91CC\u5F00\u542F\uFF09");
              return false;
            }
            await Core.simulateClick(btn);
            await Core.delay(state.settings.actionDelays.click);
            return true;
          }
        }
        Core.log(`\u672A\u627E\u5230"\u540C\u610F"\u6309\u94AE`);
        return false;
      } catch (error) {
        Core.log(`\u5904\u7406\u5361\u7247\u6D88\u606F\u51FA\u9519: ${error.message}`);
        return false;
      }
    }
    static greetingContents() {
      return (state.settings.greetingsList || []).map((g) => String(g.content || "").trim());
    }
    static previewText(text, max = 40) {
      const s = String(text || "").replace(/\s+/g, " ").trim();
      return s.length > max ? s.slice(0, max) + "\u2026" : s;
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
          Core.log("\u6253\u62DB\u547C\u5217\u8868\u4E3A\u7A7A\uFF0C\u8DF3\u8FC7");
          return false;
        }
        const expected = contents[0];
        if (!expected) {
          Core.log("\u6253\u62DB\u547C\u5217\u8868\u7B2C\u4E00\u884C\uFF08\u7F51\u9875\u81EA\u52A8\u53D1\u9001\u7684\u62DB\u547C\u8BED\uFF09\u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u5339\u914D\uFF0C\u8DF3\u8FC7");
          return false;
        }
        const lastSelf = await Core.getLastSelfMessageText();
        if (!lastSelf) {
          Core.log("\u672A\u627E\u5230\u6211\u65B9\u5DF2\u53D1\u9001\u7684\u6D88\u606F\uFF0C\u65E0\u6CD5\u5339\u914D\u6253\u62DB\u547C\u9996\u884C\uFF0C\u8DF3\u8FC7");
          return false;
        }
        if (Core.cleanMessage(lastSelf) !== Core.cleanMessage(expected)) {
          Core.log(`\u6700\u540E\u4E00\u6761\u6211\u65B9\u6D88\u606F\u4E0E\u6253\u62DB\u547C\u9996\u884C\u4E0D\u4E00\u81F4\uFF0C\u8DF3\u8FC7\uFF08\u6211\u65B9\uFF1A${this.previewText(lastSelf)}\uFF09`);
          return false;
        }
        const followUps = contents.slice(1).filter(Boolean);
        if (followUps.length === 0) {
          Core.log("\u6253\u62DB\u547C\u9996\u884C\u5DF2\u5339\u914D\uFF0C\u6CA1\u6709\u9700\u8981\u53D1\u9001\u7684\u540E\u7EED\u6D88\u606F");
          return true;
        }
        for (let i = 0; i < followUps.length; i++) {
          Core.log(`\u53D1\u9001\u540E\u7EED\u6D88\u606F\uFF08${i + 1}/${followUps.length}\uFF09\uFF1A${this.previewText(followUps[i])}`);
          await this.sendCustomReply(followUps[i]);
          await Core.delay(state.settings.actionDelays.click);
        }
        return true;
      } catch (error) {
        Core.log(`\u53D1\u9001\u6253\u62DB\u547C\u540E\u7EED\u6D88\u606F\u51FA\u9519: ${error.message}`);
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
              Core.log(`\u667A\u80FD\u5339\u914D: "${resumeNameText}" \u4F9D\u636E: "${keyword}"`);
              return item;
            }
          }
        }
        return null;
      } catch (error) {
        Core.log(`\u7B80\u5386\u5339\u914D\u51FA\u9519: ${error.message}`);
        return null;
      }
    }
    static async sendResume() {
      try {
        const resumeBtn = await Core.waitForElement(() => {
          return [...document.querySelectorAll(".toolbar-btn")].find(
            (el) => el.textContent.trim() === "\u53D1\u7B80\u5386"
          );
        });
        if (!resumeBtn) {
          Core.log("\u65E0\u6CD5\u53D1\u9001\u7B80\u5386\uFF0C\u672A\u627E\u5230\u53D1\u7B80\u5386\u6309\u94AE");
          return false;
        }
        if (resumeBtn.classList.contains("unable")) {
          Core.log("\u5BF9\u65B9\u672A\u56DE\u590D\uFF0C\u60A8\u65E0\u6743\u53D1\u9001\u7B80\u5386");
          return false;
        }
        let positionName = Core.getPositionName();
        if (!positionName) {
          Core.log("\u672A\u627E\u5230\u5C97\u4F4D\u540D\u79F0\u5143\u7D20");
        }
        await Core.simulateClick(resumeBtn);
        await Core.smartDelay(state.settings.actionDelays.click, "click");
        await Core.smartDelay(800, "resume_load");
        const confirmDialog = document.querySelector(".panel-resume.sentence-popover");
        if (confirmDialog) {
          Core.log("\u60A8\u53EA\u6709\u4E00\u4EFD\u9644\u4EF6\u7B80\u5386");
          const confirmBtn = confirmDialog.querySelector(".btn-sure-v2");
          if (!confirmBtn) {
            Core.log("\u672A\u627E\u5230\u786E\u8BA4\u6309\u94AE");
            return false;
          }
          await Core.simulateClick(confirmBtn);
          return true;
        }
        const resumeList = await Core.waitForElement("ul.resume-list");
        if (!resumeList) {
          Core.log("\u672A\u627E\u5230\u7B80\u5386\u5217\u8868");
          return false;
        }
        const resumeItems = Array.from(resumeList.querySelectorAll("li.list-item"));
        if (resumeItems.length === 0) {
          Core.log("\u672A\u627E\u5230\u7B80\u5386\u5217\u8868\u9879");
          return false;
        }
        let selectedResumeItem = null;
        if (positionName) {
          selectedResumeItem = this._findMatchingResume(resumeItems, positionName);
        }
        if (!selectedResumeItem) {
          selectedResumeItem = resumeItems[0];
          const resumeName = selectedResumeItem.querySelector(".resume-name").textContent.trim();
          Core.log('\u4F7F\u7528\u7B2C\u4E00\u4E2A\u7B80\u5386: "' + resumeName + '"');
        }
        await Core.simulateClick(selectedResumeItem);
        await Core.smartDelay(state.settings.actionDelays.click, "click");
        await Core.smartDelay(500, "selection");
        const sendBtn = await Core.waitForElement("button.btn-v2.btn-sure-v2.btn-confirm");
        if (!sendBtn) {
          Core.log("\u672A\u627E\u5230\u53D1\u9001\u6309\u94AE");
          return false;
        }
        if (sendBtn.disabled) {
          Core.log("\u53D1\u9001\u6309\u94AE\u4E0D\u53EF\u7528\uFF0C\u53EF\u80FD\u7B80\u5386\u672A\u6B63\u786E\u9009\u62E9");
          return false;
        }
        await Core.simulateClick(sendBtn);
        return true;
      } catch (error) {
        Core.log(`\u53D1\u9001\u7B80\u5386\u51FA\u9519: ${error.message}`);
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
              Core.log(`\u667A\u80FD\u5339\u914D: "${resume.path}" \u4F9D\u636E: "${keyword}"`);
              return resume;
            }
          }
        }
        return state.settings.imageResumes[0];
      } catch (error) {
        Core.log(`\u9009\u62E9\u56FE\u7247\u7B80\u5386\u51FA\u9519: ${error.message}`);
        return state.settings.imageResumes[0] || null;
      }
    }
    static async sendImageResume() {
      try {
        if (!state.settings.useAutoSendImageResume || !state.settings.imageResumes || state.settings.imageResumes.length === 0) {
          return false;
        }
        let positionName = Core.getPositionName();
        if (!positionName) {
          Core.log("\u672A\u627E\u5230\u5C97\u4F4D\u540D\u79F0\u5143\u7D20");
        }
        const selectedResume = this.selectImageResume(positionName);
        if (!selectedResume || !selectedResume.data) {
          Core.log("\u6CA1\u6709\u53EF\u53D1\u9001\u7684\u56FE\u7247\u7B80\u5386\u6570\u636E");
          return false;
        }
        const imageSendBtn = await Core.waitForElement(
          '.toolbar-btn-content.icon.btn-sendimg input[type="file"]'
        );
        if (!imageSendBtn) {
          Core.log("\u672A\u627E\u5230\u56FE\u7247\u53D1\u9001\u6309\u94AE");
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
          lastModified: (/* @__PURE__ */ new Date()).getTime()
        });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        imageSendBtn.files = dataTransfer.files;
        const event = new Event("change", { bubbles: true });
        imageSendBtn.dispatchEvent(event);
        return true;
      } catch (error) {
        Core.log(`\u53D1\u9001\u56FE\u7247\u51FA\u9519: ${error.message}`);
        return false;
      }
    }
  };

  // src/15-settings-deferred.js
  var saveSettingsTimer = null;
  function debouncedSaveSettings() {
    if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
    saveSettingsTimer = setTimeout(() => {
      saveSettingsTimer = null;
      saveSettings();
    }, 400);
  }
  __name(debouncedSaveSettings, "debouncedSaveSettings");
  function loadGreetings() {
    if (!state.settings.greetingsList || state.settings.greetingsList.length === 0) {
      state.settings.greetingsList = [{ id: Date.now().toString(), content: "" }];
      saveSettings();
    }
    renderGreetingsList();
  }
  __name(loadGreetings, "loadGreetings");

  // src/13-greetings.js
  function addGreetingItem() {
    if (!state.settings.greetingsList) {
      state.settings.greetingsList = [];
    }
    const hasEmpty = state.settings.greetingsList.some((greeting) => !greeting.content.trim());
    if (hasEmpty) {
      return;
    }
    const newGreeting = {
      id: Date.now().toString(),
      content: ""
    };
    state.settings.greetingsList.push(newGreeting);
    saveSettings();
    renderGreetingsList();
  }
  __name(addGreetingItem, "addGreetingItem");
  function renderGreetingsList() {
    const greetingsList = document.getElementById("greetings-list");
    if (!greetingsList) return;
    greetingsList.innerHTML = "";
    if (!state.settings.greetingsList || state.settings.greetingsList.length === 0) {
      greetingsList.innerHTML = '<div style="color: #6b7280; text-align: center; padding: 20px;">\u6682\u65E0\u6253\u62DB\u547C\u5185\u5BB9</div>';
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
      indexEl.style.cssText = "width:24px;flex-shrink:0;text-align:right;margin-right:8px;font-size:14px;color:#333;";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "greeting-input";
      input.dataset.id = greeting.id;
      input.placeholder = index === 0 ? "\u7B2C\u4E00\u884C\uFF1A\u7F51\u9875\u81EA\u52A8\u53D1\u9001\u7684\u6253\u62DB\u547C\u8BED" : "\u540E\u7EED\u6D88\u606F";
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
      deleteBtn.textContent = "\u5220\u9664";
      deleteBtn.style.cssText = "margin-left:12px;width:56px;padding:0;flex-shrink:0;";
      greetingElement.append(indexEl, input, deleteBtn);
      greetingsList.appendChild(greetingElement);
    });
    attachGreetingEventListeners();
  }
  __name(renderGreetingsList, "renderGreetingsList");
  function attachGreetingEventListeners() {
    document.querySelectorAll(".delete-greeting-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const greetingId = e.target.dataset.id;
        state.settings.greetingsList = state.settings.greetingsList.filter(
          (g) => g.id !== greetingId
        );
        saveSettings();
        renderGreetingsList();
      });
    });
    document.querySelectorAll(".greeting-input").forEach((input) => {
      const greetingId = input.dataset.id;
      const greeting = (state.settings.greetingsList || []).find((g) => g.id === greetingId);
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
  __name(attachGreetingEventListeners, "attachGreetingEventListeners");

  // src/07-settings-dialog.js
  function createSettingsDialog() {
    const dialog = document.createElement("div");
    dialog.id = "boss-settings-dialog";
    dialog.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: clamp(300px, 90vw, 840px);
        height: 80vh;
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.15);
        z-index: 999999;
        display: none;
        flex-direction: column;
        font-family: 'Segoe UI', sans-serif;
        overflow: hidden;
        transition: all 0.3s ease;
    `;
    dialog.innerHTML += `
        <style>
            #boss-settings-dialog {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.95);
            }
            #boss-settings-dialog.active {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
            .setting-item {
                transition: border-color 0.2s ease;
            }
            .settings-card .setting-item:last-child {
                border-bottom: none;
            }
            #apply-interval-input,
            #max-apply-input {
                -moz-appearance: textfield;
                appearance: textfield;
            }
            #apply-interval-input::-webkit-outer-spin-button,
            #apply-interval-input::-webkit-inner-spin-button,
            #max-apply-input::-webkit-outer-spin-button,
            #max-apply-input::-webkit-inner-spin-button {
                -webkit-appearance: none;
                margin: 0;
            }
            #boss-settings-dialog .settings-btn {
                height: 32px;
                padding: 0 16px;
                border-radius: 4px;
                border: 1px solid transparent;
                font-size: 14px;
                font-weight: 500;
                line-height: 1;
                cursor: pointer;
                box-sizing: border-box;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                white-space: nowrap;
                transition: background-color 0.2s, border-color 0.2s, color 0.2s;
            }
            #boss-settings-dialog .settings-btn:disabled {
                opacity: 0.6;
                cursor: not-allowed;
            }
            #boss-settings-dialog .settings-btn-primary {
                background: #1a73e8;
                border-color: #1a73e8;
                color: #ffffff;
            }
            #boss-settings-dialog .settings-btn-primary:hover {
                background: #1557b0;
                border-color: #1557b0;
            }
            #boss-settings-dialog .settings-btn-secondary {
                background: #e8f0fe;
                border-color: #a8c7fa;
                color: #1a73e8;
            }
            #boss-settings-dialog .settings-btn-secondary:hover {
                background: #d2e3fc;
            }
            #boss-settings-dialog .settings-btn-neutral {
                background: #ffffff;
                border-color: #dadce0;
                color: #5f6368;
            }
            #boss-settings-dialog .settings-btn-neutral:hover {
                background: #f1f3f4;
            }
            #boss-settings-dialog .settings-btn-danger {
                background: #ffffff;
                border-color: #ff4d4f;
                color: #ff4d4f;
            }
            #boss-settings-dialog .settings-btn-danger:hover {
                background: #fff1f0;
            }
            .multi-select-container {
                position: relative;
                width: 100%;
                margin-top: 10px;
            }
            .multi-select-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px;
                border-radius: 8px;
                border: 1px solid #d1d5db;
                background: white;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .multi-select-header:hover {
                border-color: rgba(26, 115, 232, 0.7);
            }
            .multi-select-options {
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                max-height: 200px;
                overflow-y: auto;
                border-radius: 8px;
                border: 1px solid #d1d5db;
                background: white;
                z-index: 100;
                box-shadow: 0 4px 10px rgba(0,0,0,0.1);
                display: none;
            }
            .multi-select-option {
                padding: 10px;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .multi-select-option:hover {
                background-color: rgba(26, 115, 232, 0.05);
            }
            .multi-select-option.selected {
                background-color: rgba(26, 115, 232, 0.1);
            }
            .multi-select-clear {
                color: #666;
                cursor: pointer;
                margin-left: 5px;
            }
            .multi-select-clear:hover {
                color: #333;
            }
        </style>
    `;
    const dialogHeader = createDialogHeader(
      "\u8BBE\u7F6E",
      "boss-settings-dialog",
      null,
      closeSettingsDialog
    );
    const dialogContent = document.createElement("div");
    dialogContent.style.cssText = `
        padding: 18px;
        background: #f8f9fa;
        flex: 1;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(26, 115, 232, 0.5) rgba(0, 0, 0, 0.05);
    `;
    dialogContent.innerHTML += `
    <style>
        #boss-settings-dialog ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        #boss-settings-dialog ::-webkit-scrollbar-track {
            background: rgba(0,0,0,0.05);
            border-radius: 10px;
            margin: 8px 0;
        }
        #boss-settings-dialog ::-webkit-scrollbar-thumb {
            background: rgba(26, 115, 232, 0.5);
            border-radius: 10px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            transition: all 0.2s ease;
        }
        #boss-settings-dialog ::-webkit-scrollbar-thumb:hover {
            background: rgba(26, 115, 232, 0.7);
            box-shadow: 0 1px 5px rgba(0,0,0,0.15);
        }
    </style>
    `;
    const generalSettingsPanel = document.createElement("div");
    generalSettingsPanel.id = "general-settings-panel";
    const jobSettingsPanel = document.createElement("div");
    jobSettingsPanel.id = "job-settings-panel";
    const chatSettingsPanel = document.createElement("div");
    chatSettingsPanel.id = "chat-settings-panel";
    const apiGroup = createSettingsGroup("AI API \u914D\u7F6E");
    [
      {
        id: "ai-api-url-input",
        label: "API \u5730\u5740",
        desc: "\u517C\u5BB9 OpenAI \u534F\u8BAE\u7684\u63A5\u53E3\u5730\u5740",
        placeholder: "https://api.deepseek.com/v1/chat/completions"
      },
      {
        id: "ai-api-key-input",
        label: "API Key",
        desc: "\u4EC5\u4FDD\u5B58\u5728\u672C\u5730\u6D4F\u89C8\u5668\uFF0C\u8BF7\u52FF\u5728\u516C\u7528\u7535\u8111\u4F7F\u7528",
        placeholder: "sk-xxx",
        password: true
      },
      {
        id: "ai-model-input",
        label: "\u6A21\u578B\u540D\u79F0",
        desc: "\u9ED8\u8BA4 deepseek-chat",
        placeholder: "deepseek-chat"
      }
    ].forEach(function(cf) {
      const field = createSettingItem(cf.label, cf.desc, () => document.getElementById(cf.id));
      var ip = Object.assign(document.createElement("input"), {
        type: cf.password ? "password" : "text",
        id: cf.id,
        placeholder: cf.placeholder
      });
      ip.style.cssText = "width:100%;padding:9px 14px;border-radius:6px;border:1px solid transparent;background:#f1f3f4;font-size:13px;margin-top:12px;box-sizing:border-box;outline:none;transition:all 0.2s;";
      addFocusBlurEffects(ip);
      field.settingItem.append(ip);
      apiGroup.card.append(field.settingItem);
    });
    var apiFooter = document.createElement("div");
    apiFooter.style.cssText = "padding:10px 0 14px;";
    var btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;";
    var ab = createSettingsButton("\u4FDD\u5B58 API \u914D\u7F6E", "primary");
    ab.style.flex = "1";
    function collectApi() {
      var a = document.getElementById("ai-api-url-input");
      if (a) settings.aiApiUrl = a.value.trim();
      var b = document.getElementById("ai-api-key-input");
      if (b) settings.aiApiKey = b.value.trim();
      var c = document.getElementById("ai-model-input");
      if (c) settings.aiModel = c.value.trim() || "deepseek-chat";
    }
    __name(collectApi, "collectApi");
    ab.addEventListener("click", function() {
      collectApi();
      saveSettings();
      showNotification("API \u914D\u7F6E\u5DF2\u4FDD\u5B58");
    });
    var tb = createSettingsButton("\u6D4B\u8BD5\u8FDE\u63A5", "secondary");
    tb.style.flex = "1";
    tb.addEventListener("click", async function() {
      collectApi();
      saveSettings();
      if (!settings.aiApiKey) {
        showNotification("\u8BF7\u5148\u586B\u5199 API Key", "error");
        return;
      }
      tb.disabled = true;
      tb.textContent = "\u6D4B\u8BD5\u4E2D...";
      try {
        var r = await Core.requestAi("\u4F60\u597D\uFF0C\u8BF7\u53EA\u56DE\u590D\u4E24\u4E2A\u5B57\uFF1A\u53EF\u7528", null, {
          retries: 0,
          label: "\u8FDE\u63A5\u6D4B\u8BD5"
        });
        showNotification(
          r ? "\u8FDE\u63A5\u6210\u529F\uFF1A" + String(r).slice(0, 20) : "\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u914D\u7F6E",
          "success"
        );
      } catch (e) {
        showNotification("\u8FDE\u63A5\u5931\u8D25\uFF1A" + e.message, "error");
      } finally {
        tb.disabled = false;
        tb.textContent = "\u6D4B\u8BD5\u8FDE\u63A5";
      }
    });
    btnRow.appendChild(ab);
    btnRow.appendChild(tb);
    apiFooter.appendChild(btnRow);
    apiGroup.card.append(apiFooter);
    const promptGroup = createSettingsGroup("\u6295\u9012\u63D0\u793A\u8BCD");
    const promptSettingResult = createSettingItem(
      "\u63D0\u793A\u8BCD\u5185\u5BB9",
      "\u5224\u5B9A\u7528\u7684\u7B80\u5386\u3001\u6295\u9012\u8981\u6C42\u4E0E\u89C4\u5219\uFF1B\u53EA\u6709 {jobTitle} / {jobDescription} \u4F1A\u88AB\u81EA\u52A8\u66FF\u6362",
      () => document.getElementById("edit-prompt-btn")
    );
    const editPromptBtn = createSettingsButton("\u7F16\u8F91\u63D0\u793A\u8BCD", "secondary");
    editPromptBtn.id = "edit-prompt-btn";
    editPromptBtn.style.flexShrink = "0";
    promptSettingResult.descriptionContainer.append(editPromptBtn);
    promptGroup.card.append(promptSettingResult.settingItem);
    generalSettingsPanel.append(apiGroup.group, promptGroup.group);
    const greetingsSettingResult = createSettingItem(
      "\u6253\u62DB\u547C\u5217\u8868",
      "\u7B2C\u4E00\u884C\u586B\u7F51\u9875\u81EA\u52A8\u53D1\u9001\u7684\u6253\u62DB\u547C\u8BED\uFF1B\u6700\u540E\u4E00\u6761\u6211\u65B9\u6D88\u606F\u4E0E\u5B83\u4E00\u81F4\u65F6\uFF0C\u811A\u672C\u624D\u4F9D\u6B21\u53D1\u9001\u7B2C\u4E8C\u884C\u53CA\u4EE5\u540E\u7684\u5185\u5BB9",
      () => document.getElementById("greetings-container")
    );
    const greetingsSetting = greetingsSettingResult.settingItem;
    greetingsSetting.style.padding = "16px 0";
    const greetingsContainer = document.createElement("div");
    greetingsContainer.id = "greetings-container";
    greetingsContainer.style.cssText = `
        width: 100%;
        margin-top: 14px;
    `;
    const greetingsList = document.createElement("div");
    greetingsList.id = "greetings-list";
    const addGreetingBtn = createSettingsButton("\u6DFB\u52A0\u4E00\u6761", "secondary", () => {
      addGreetingItem();
    });
    addGreetingBtn.style.flexShrink = "0";
    greetingsSettingResult.descriptionContainer.append(addGreetingBtn);
    greetingsContainer.append(greetingsList);
    greetingsSetting.append(greetingsContainer);
    const autoSendResumeSettingResult = createSettingItem(
      "\u81EA\u52A8\u53D1\u9001\u9644\u4EF6\u7B80\u5386",
      "\u5F00\u542F\u540E\u7CFB\u7EDF\u5C06\u81EA\u52A8\u53D1\u9001\u9644\u4EF6\u7B80\u5386\u7ED9 HR",
      () => document.querySelector("#toggle-auto-send-resume input")
    );
    const autoSendResumeSetting = autoSendResumeSettingResult.settingItem;
    const autoSendResumeDescriptionContainer = autoSendResumeSettingResult.descriptionContainer;
    const autoSendResumeToggle = createToggleSwitch(
      "auto-send-resume",
      settings.useAutoSendResume,
      (checked) => {
        settings.useAutoSendResume = checked;
      },
      true
    );
    autoSendResumeDescriptionContainer.append(autoSendResumeToggle);
    const excludeHeadhuntersSettingResult = createSettingItem(
      "\u6295\u9012\u65F6\u6392\u9664\u730E\u5934",
      "\u5F00\u542F\u540E\u5C06\u4E0D\u4F1A\u5411\u730E\u5934\u804C\u4F4D\u81EA\u52A8\u6295\u9012\u7B80\u5386",
      () => document.querySelector("#toggle-exclude-headhunters input")
    );
    const excludeHeadhuntersSetting = excludeHeadhuntersSettingResult.settingItem;
    const excludeHeadhuntersDescriptionContainer = excludeHeadhuntersSettingResult.descriptionContainer;
    const excludeHeadhuntersToggle = createToggleSwitch(
      "exclude-headhunters",
      settings.excludeHeadhunters,
      (checked) => {
        settings.excludeHeadhunters = checked;
      },
      true
    );
    excludeHeadhuntersDescriptionContainer.append(excludeHeadhuntersToggle);
    const autoAcceptCardSettingResult = createSettingItem(
      "\u81EA\u52A8\u540C\u610F\u4EA4\u6362",
      "HR \u53D1\u6765\u4EA4\u6362\u8054\u7CFB\u65B9\u5F0F\u5361\u7247\u65F6\u81EA\u52A8\u70B9\u300C\u540C\u610F\u300D\u3002\u9ED8\u8BA4\u5173\u95ED \u2014\u2014 \u5F00\u542F\u540E\u4F1A\u628A\u4F60\u7684\u8054\u7CFB\u65B9\u5F0F\u4EA4\u7ED9\u5BF9\u65B9",
      () => document.querySelector("#toggle-auto-accept-card input")
    );
    const autoAcceptCardSetting = autoAcceptCardSettingResult.settingItem;
    const autoAcceptCardDescriptionContainer = autoAcceptCardSettingResult.descriptionContainer;
    const autoAcceptCardToggle = createToggleSwitch(
      "auto-accept-card",
      settings.autoAcceptCard,
      (checked) => {
        settings.autoAcceptCard = checked;
      },
      true
    );
    autoAcceptCardDescriptionContainer.append(autoAcceptCardToggle);
    const imageResumeSettingResult = createSettingItem(
      "\u53D1\u9001\u56FE\u7247\u7B80\u5386",
      "\u9996\u6B21\u6C9F\u901A\u53D1\u9001\u56FE\u7247\u7B80\u5386\uFF08\u9700\u5148\u9009\u62E9JPG\u683C\u5F0F\u56FE\u7247\uFF09",
      () => document.querySelector("#toggle-auto-send-image-resume input")
    );
    const imageResumeSetting = imageResumeSettingResult.settingItem;
    const imageResumeDescriptionContainer = imageResumeSettingResult.descriptionContainer;
    if (!state.settings.imageResumes) {
      state.settings.imageResumes = [];
    }
    const fileInputContainer = document.createElement("div");
    fileInputContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: 100%;
        margin-top: 10px;
    `;
    const addResumeBtn = createSettingsButton("\u6DFB\u52A0\u56FE\u7247\u7B80\u5386", "secondary");
    addResumeBtn.id = "add-image-resume-btn";
    addResumeBtn.style.alignSelf = "flex-start";
    const fileNameDisplay = document.createElement("div");
    fileNameDisplay.id = "image-resume-filename";
    fileNameDisplay.style.cssText = `
        flex: 1;
        padding: 8px;
        border-radius: 6px;
        border: 1px solid #d1d5db;
        background: #f8fafc;
        color: #334155;
        font-size: 14px;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    `;
    const resumeCount = state.settings.imageResumes ? state.settings.imageResumes.length : 0;
    fileNameDisplay.textContent = resumeCount > 0 ? `\u5DF2\u4E0A\u4F20 ${resumeCount} \u4E2A\u7B80\u5386` : "\u672A\u9009\u62E9\u6587\u4EF6";
    const autoSendImageResumeToggle = (() => {
      const hasImageResumes = state.settings.imageResumes && state.settings.imageResumes.length > 0;
      const isValidState = hasImageResumes && settings.useAutoSendImageResume;
      if (!hasImageResumes) settings.useAutoSendImageResume = false;
      return createToggleSwitch(
        "auto-send-image-resume",
        isValidState,
        (checked) => {
          if (checked && (!state.settings.imageResumes || state.settings.imageResumes.length === 0)) {
            showNotification("\u8BF7\u5148\u9009\u62E9\u56FE\u7247\u6587\u4EF6", "error");
            const slider = document.querySelector("#toggle-auto-send-image-resume .toggle-slider");
            const container = document.querySelector("#toggle-auto-send-image-resume .toggle-switch");
            container.style.backgroundColor = "#e5e7eb";
            slider.style.transform = "translateX(0)";
            document.querySelector("#toggle-auto-send-image-resume input").checked = false;
          }
          settings.useAutoSendImageResume = checked;
          return true;
        },
        true
      );
    })();
    const hiddenFileInput = document.createElement("input");
    hiddenFileInput.id = "image-resume-input";
    hiddenFileInput.type = "file";
    hiddenFileInput.accept = ".jpg,.jpeg";
    hiddenFileInput.style.display = "none";
    const uploadedResumesContainer = document.createElement("div");
    uploadedResumesContainer.id = "uploaded-resumes-container";
    uploadedResumesContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
    `;
    function renderResumeItem(resume) {
      const resumeItem = document.createElement("div");
      resumeItem.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            border-radius: 6px;
            background: rgba(0, 0, 0, 0.05);
            font-size: 14px;
        `;
      const fileNameSpan = document.createElement("span");
      fileNameSpan.textContent = resume.path;
      fileNameSpan.style.cssText = `
            flex: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-right: 8px;
        `;
      const deleteBtn = createSettingsButton("\u5220\u9664", "danger");
      deleteBtn.style.width = "56px";
      deleteBtn.style.padding = "0";
      deleteBtn.addEventListener("click", () => {
        const list = state.settings.imageResumes;
        let idx = list.indexOf(resume);
        if (idx === -1) idx = list.findIndex((r) => r.path === resume.path);
        if (idx === -1) return;
        list.splice(idx, 1);
        resumeItem.remove();
        if (state.settings.imageResumes.length === 0) {
          state.settings.useAutoSendImageResume = false;
          const toggleInput = document.querySelector("#toggle-auto-send-image-resume input");
          if (toggleInput) {
            toggleInput.checked = false;
            toggleInput.dispatchEvent(new Event("change"));
          }
        }
        saveSettings();
      });
      resumeItem.appendChild(fileNameSpan);
      resumeItem.appendChild(deleteBtn);
      return resumeItem;
    }
    __name(renderResumeItem, "renderResumeItem");
    if (state.settings.imageResumes && state.settings.imageResumes.length > 0) {
      state.settings.imageResumes.forEach((resume) => {
        const resumeItem = renderResumeItem(resume);
        uploadedResumesContainer.appendChild(resumeItem);
      });
    }
    addResumeBtn.addEventListener("click", () => {
      if (state.settings.imageResumes.length >= 10) {
        showNotification("\u6700\u591A\u6DFB\u52A0 10 \u4E2A\u56FE\u7247\u7B80\u5386", "error");
      } else {
        hiddenFileInput.click();
      }
    });
    hiddenFileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) {
        const file = e.target.files[0];
        const fileName = file.name.toLowerCase();
        if (!fileName.endsWith(".jpg") && !fileName.endsWith(".jpeg")) {
          showNotification("\u4EC5\u652F\u6301 JPG/JPEG \u683C\u5F0F\u7684\u56FE\u7247\u6587\u4EF6", "error");
          hiddenFileInput.value = "";
          return;
        }
        const isDuplicate = state.settings.imageResumes.some((resume) => resume.path === file.name);
        if (isDuplicate) {
          showNotification("\u8BE5\u6587\u4EF6\u540D\u5DF2\u5B58\u5728", "error");
          return;
        }
        const reader = new FileReader();
        reader.onload = function(event) {
          const newResume = {
            path: file.name,
            data: event.target.result
          };
          state.settings.imageResumes.push(newResume);
          const resumeItem = renderResumeItem(newResume);
          uploadedResumesContainer.appendChild(resumeItem);
          if (!state.settings.useAutoSendImageResume) {
            state.settings.useAutoSendImageResume = true;
            const toggleInput = document.querySelector("#toggle-auto-send-image-resume input");
            if (toggleInput) {
              toggleInput.checked = true;
              toggleInput.dispatchEvent(new Event("change"));
            }
          }
          saveSettings();
        };
        reader.readAsDataURL(file);
      }
    });
    fileInputContainer.append(addResumeBtn, uploadedResumesContainer, hiddenFileInput);
    imageResumeDescriptionContainer.append(autoSendImageResumeToggle);
    imageResumeSetting.append(fileInputContainer);
    const recruiterStatusSettingResult = createSettingItem(
      "\u6295\u9012\u62DB\u8058\u8005\u72B6\u6001\uFF08\u591A\u9009\uFF09",
      "\u7B5B\u9009\u6D3B\u8DC3\u72B6\u6001\u7B26\u5408\u8981\u6C42\u7684\u62DB\u8058\u8005\u8FDB\u884C\u6295\u9012",
      () => document.querySelector("#recruiter-status-select .select-header")
    );
    const recruiterStatusSetting = recruiterStatusSettingResult.settingItem;
    recruiterStatusSetting.style.flexDirection = "row";
    recruiterStatusSetting.style.flexWrap = "wrap";
    recruiterStatusSetting.style.alignItems = "center";
    recruiterStatusSetting.style.gap = "16px 24px";
    recruiterStatusSettingResult.descriptionContainer.style.flex = "1 1 260px";
    recruiterStatusSettingResult.descriptionContainer.style.minWidth = "0";
    const statusSelect = document.createElement("div");
    statusSelect.id = "recruiter-status-select";
    statusSelect.className = "custom-select";
    statusSelect.style.cssText = `
        position: relative;
        flex: 0 1 440px;
        width: 440px;
        max-width: 100%;
        margin-left: auto;
        margin-top: 0;
    `;
    const statusHeader = document.createElement("div");
    statusHeader.className = "select-header";
    statusHeader.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        height: 36px;
        padding: 0 11px;
        border-radius: 6px;
        border: 1px solid #dcdfe6;
        background: white;
        cursor: pointer;
        transition: all 0.2s ease;
        box-sizing: border-box;
    `;
    const statusDisplay = document.createElement("div");
    statusDisplay.className = "select-value";
    statusDisplay.style.cssText = `
        flex: 1;
        text-align: left;
        color: #606266;
        font-size: 14px;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    `;
    statusDisplay.textContent = getStatusDisplayText();
    const statusIcon = document.createElement("div");
    statusIcon.className = "select-icon";
    statusIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    statusIcon.style.cssText = `
        margin-left: 10px;
        color: #a8abb2;
        display: flex;
        align-items: center;
        transition: transform 0.2s ease;
    `;
    statusHeader.append(statusDisplay, statusIcon);
    const statusOptions = document.createElement("div");
    statusOptions.className = "select-options";
    statusOptions.style.cssText = `
        position: absolute;
        top: calc(100% + 12px);
        left: 0;
        right: 0;
        max-height: 240px;
        overflow-y: auto;
        border-radius: 4px;
        border: 1px solid #e4e7ed;
        background: white;
        z-index: 100;
        box-shadow: 0 12px 32px 4px rgba(0, 0, 0, 0.04), 0 8px 20px rgba(0, 0, 0, 0.08);
        display: none;
        transition: all 0.2s ease;
        scrollbar-width: thin;
        scrollbar-color: #dcdfe6 transparent;
    `;
    statusOptions.innerHTML += `
        <style>
            .select-options::-webkit-scrollbar {
                width: 6px;
            }
            .select-options::-webkit-scrollbar-track {
                background: #f1f5f9;
                border-radius: 10px;
            }
            .select-options::-webkit-scrollbar-thumb {
                background: #cbd5e1;
                border-radius: 10px;
            }
            .select-options::-webkit-scrollbar-thumb:hover {
                background: #94a3b8;
            }
        </style>
    `;
    const statusOptionsList = [
      { value: "\u4E0D\u9650", text: "\u4E0D\u9650" },
      { value: "\u5728\u7EBF", text: "\u5728\u7EBF" },
      { value: "\u521A\u521A\u6D3B\u8DC3", text: "\u521A\u521A\u6D3B\u8DC3" },
      { value: "\u4ECA\u65E5\u6D3B\u8DC3", text: "\u4ECA\u65E5\u6D3B\u8DC3" },
      { value: "3\u65E5\u5185\u6D3B\u8DC3", text: "3\u65E5\u5185\u6D3B\u8DC3" },
      { value: "\u672C\u5468\u6D3B\u8DC3", text: "\u672C\u5468\u6D3B\u8DC3" },
      { value: "\u672C\u6708\u6D3B\u8DC3", text: "\u672C\u6708\u6D3B\u8DC3" },
      { value: "\u534A\u5E74\u524D\u6D3B\u8DC3", text: "\u534A\u5E74\u524D\u6D3B\u8DC3" }
    ];
    statusOptionsList.forEach((option) => {
      const isSelected = settings.recruiterActivityStatus && Array.isArray(settings.recruiterActivityStatus) && settings.recruiterActivityStatus.includes(option.value);
      const statusOption = document.createElement("div");
      statusOption.className = "select-option" + (isSelected ? " selected" : "");
      statusOption.dataset.value = option.value;
      statusOption.style.cssText = `
            height: 34px;
            padding: 0 20px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            font-size: 14px;
            color: ${isSelected ? "#1a73e8" : "#606266"};
            font-weight: ${isSelected ? "600" : "400"};
        `;
      const textSpan = document.createElement("span");
      textSpan.textContent = option.text;
      textSpan.style.flex = "1";
      const checkIcon = document.createElement("span");
      checkIcon.className = "check-icon";
      checkIcon.innerHTML = "\u2713";
      checkIcon.style.cssText = `
            margin-left: auto;
            color: #1a73e8;
            font-weight: bold;
            display: ${isSelected ? "inline" : "none"};
        `;
      statusOption.append(textSpan, checkIcon);
      statusOption.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleStatusOption(option.value);
      });
      statusOptions.appendChild(statusOption);
    });
    statusHeader.addEventListener("click", () => {
      const open = statusOptions.style.display !== "block";
      statusOptions.style.display = open ? "block" : "none";
      statusIcon.style.transform = open ? "rotate(180deg)" : "rotate(0)";
      statusHeader.style.borderColor = open ? "#1a73e8" : "#dcdfe6";
    });
    document.addEventListener("click", (e) => {
      if (!statusSelect.contains(e.target)) {
        statusOptions.style.display = "none";
        statusIcon.style.transform = "rotate(0)";
        statusHeader.style.borderColor = "#dcdfe6";
      }
    });
    statusHeader.addEventListener("mouseenter", () => {
      if (statusOptions.style.display !== "block") statusHeader.style.borderColor = "#c0c4cc";
    });
    statusHeader.addEventListener("mouseleave", () => {
      if (statusOptions.style.display !== "block") statusHeader.style.borderColor = "#dcdfe6";
    });
    statusSelect.append(statusHeader, statusOptions);
    recruiterStatusSetting.append(statusSelect);
    const paceSettingResult = createSettingItem(
      "\u6295\u9012\u8282\u594F (\u6BEB\u79D2)",
      "\u6BCF\u6295\u9012\u4E00\u4E2A\u5C97\u4F4D\u4E4B\u95F4\u7684\u95F4\u9694\uFF0C\u5EFA\u8BAE 2000-5000\uFF0C\u8FC7\u5C0F\u5BB9\u6613\u89E6\u53D1\u98CE\u63A7",
      () => document.getElementById("apply-interval-input")
    );
    const paceSetting = paceSettingResult.settingItem;
    const paceInput = document.createElement("input");
    paceInput.id = "apply-interval-input";
    paceInput.type = "number";
    paceInput.min = "800";
    paceInput.step = "100";
    paceInput.value = settings.applyInterval;
    paceInput.style.cssText = "width:100%;padding:9px 14px;border-radius:6px;border:1px solid transparent;background:#f1f3f4;font-size:13px;margin-top:12px;box-sizing:border-box;outline:none;transition:all 0.2s;";
    addFocusBlurEffects(paceInput);
    paceSetting.append(paceInput);
    const limitSettingResult = createSettingItem(
      "\u5355\u6B21\u6295\u9012\u4E0A\u9650",
      "\u4E00\u6B21\u8FD0\u884C\u6700\u591A\u6295\u9012\u591A\u5C11\u4E2A\u5C97\u4F4D\uFF0C\u9ED8\u8BA4 50\uFF0C\u907F\u514D\u6295\u9012\u8FC7\u591A",
      () => document.getElementById("max-apply-input")
    );
    const limitSetting = limitSettingResult.settingItem;
    const limitInput = document.createElement("input");
    limitInput.id = "max-apply-input";
    limitInput.type = "number";
    limitInput.min = "1";
    limitInput.step = "1";
    limitInput.value = settings.maxApplyPerRun;
    limitInput.style.cssText = "width:100%;padding:9px 14px;border-radius:6px;border:1px solid transparent;background:#f1f3f4;font-size:13px;margin-top:12px;box-sizing:border-box;outline:none;transition:all 0.2s;";
    addFocusBlurEffects(limitInput);
    limitSetting.append(limitInput);
    const jobGroup = createSettingsGroup("\u6295\u9012\u57FA\u7840\u8BBE\u7F6E");
    jobGroup.card.append(
      recruiterStatusSetting,
      excludeHeadhuntersSetting,
      paceSetting,
      limitSetting
    );
    jobSettingsPanel.append(jobGroup.group);
    const greetingGroup = createSettingsGroup("\u6253\u62DB\u547C\u8BBE\u7F6E");
    greetingGroup.card.append(greetingsSetting);
    const resumeGroup = createSettingsGroup("\u7B80\u5386\u53D1\u9001\u8BBE\u7F6E");
    resumeGroup.card.append(autoSendResumeSetting, imageResumeSetting);
    const chatOtherGroup = createSettingsGroup("\u5176\u4ED6");
    chatOtherGroup.card.append(autoAcceptCardSetting);
    chatSettingsPanel.append(greetingGroup.group, resumeGroup.group, chatOtherGroup.group);
    const dialogFooter = document.createElement("div");
    dialogFooter.style.cssText = `
        padding: 8px 16px;
        border-top: 1px solid #e5e7eb;
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        background: rgba(0, 0, 0, 0.03);
        flex-shrink: 0;
    `;
    const cancelBtn = createSettingsButton("\u53D6\u6D88", "neutral", () => {
      closeSettingsDialog();
    });
    const saveBtn = createSettingsButton("\u4FDD\u5B58\u8BBE\u7F6E", "primary", () => {
      try {
        const val = /* @__PURE__ */ __name((id) => {
          const el = document.getElementById(id);
          return el ? el.value : void 0;
        }, "val");
        const apiUrl = val("ai-api-url-input");
        if (apiUrl !== void 0) settings.aiApiUrl = apiUrl.trim();
        const apiKey = val("ai-api-key-input");
        if (apiKey !== void 0) settings.aiApiKey = apiKey.trim();
        const model = val("ai-model-input");
        if (model !== void 0) settings.aiModel = model.trim() || "deepseek-chat";
        const template = val("prompt-template-input");
        if (template !== void 0) settings.promptTemplate = template;
        const intervalEl = val("apply-interval-input");
        if (intervalEl !== void 0 && intervalEl !== "") {
          const n = parseInt(intervalEl, 10);
          if (!isNaN(n) && n >= 800) settings.applyInterval = n;
        }
        const maxEl = val("max-apply-input");
        if (maxEl !== void 0 && maxEl !== "") {
          const n = parseInt(maxEl, 10);
          if (!isNaN(n) && n > 0) settings.maxApplyPerRun = n;
        }
        saveSettings();
        refreshPanelModeUI();
        showNotification("\u8BBE\u7F6E\u5DF2\u4FDD\u5B58");
        closeSettingsDialog();
      } catch (error) {
        showNotification("\u4FDD\u5B58\u5931\u8D25: " + error.message, "error");
        console.error("[BOSS\u6295\u9012\u52A9\u624B] \u4FDD\u5B58\u8BBE\u7F6E\u5931\u8D25:", error);
      }
    });
    dialogFooter.append(cancelBtn, saveBtn);
    dialogContent.append(generalSettingsPanel, jobSettingsPanel, chatSettingsPanel);
    dialog.append(dialogHeader, dialogContent, dialogFooter);
    const promptEditorStyle = document.createElement("style");
    promptEditorStyle.textContent = `
    #prompt-editor-overlay {
      position: absolute; inset: 0; z-index: 30;
      display: none; justify-content: center; align-items: center;
      background: rgba(32, 33, 36, 0.6);
      opacity: 0; visibility: hidden;
      transition: opacity 0.2s ease, visibility 0.2s ease;
    }
    #prompt-editor-overlay.show { opacity: 1; visibility: visible; }
    #prompt-editor-overlay .prompt-editor-modal {
      transform: translateY(20px);
      transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    #prompt-editor-overlay.show .prompt-editor-modal { transform: translateY(0); }
  `;
    const promptOverlay = document.createElement("div");
    promptOverlay.id = "prompt-editor-overlay";
    const promptModal = document.createElement("div");
    promptModal.className = "prompt-editor-modal";
    promptModal.style.cssText = "width:calc(100% - 48px);max-width:560px;max-height:calc(100% - 48px);overflow-y:auto;background:#fff;border-radius:8px;padding:24px 32px 32px;box-shadow:0 10px 25px rgba(0,0,0,0.2);box-sizing:border-box;";
    const promptTitle = document.createElement("h2");
    promptTitle.textContent = "\u7F16\u8F91\u63D0\u793A\u8BCD";
    promptTitle.style.cssText = "margin:0 0 16px;font-size:20px;font-weight:400;color:#202124;";
    const promptInput = document.createElement("textarea");
    promptInput.id = "prompt-template-input";
    promptInput.placeholder = "\u8BF7\u5728\u6B64\u8F93\u5165\u6216\u4FEE\u6539\u60A8\u7684\u63D0\u793A\u8BCD...";
    promptInput.style.cssText = "width:100%;min-height:200px;height:min(320px, 42vh);padding:16px;background:#f1f3f4;border:none;border-bottom:2px solid transparent;border-radius:4px;font-size:14px;line-height:1.6;color:#202124;outline:none;resize:none;box-sizing:border-box;transition:border-color 0.2s ease;";
    promptInput.addEventListener("focus", () => {
      promptInput.style.borderBottomColor = "#1a73e8";
    });
    promptInput.addEventListener("blur", () => {
      promptInput.style.borderBottomColor = "transparent";
    });
    const promptFooter = document.createElement("div");
    promptFooter.style.cssText = "display:flex;justify-content:flex-end;gap:12px;margin-top:24px;";
    const promptCancelBtn = createSettingsButton("\u53D6\u6D88", "neutral");
    promptCancelBtn.id = "prompt-editor-cancel";
    const promptSaveBtn = createSettingsButton("\u4FDD\u5B58", "primary");
    promptSaveBtn.id = "prompt-editor-save";
    promptFooter.append(promptCancelBtn, promptSaveBtn);
    promptModal.append(promptTitle, promptInput, promptFooter);
    promptOverlay.appendChild(promptModal);
    dialog.append(promptEditorStyle, promptOverlay);
    const openPromptEditor = /* @__PURE__ */ __name(() => {
      promptInput.value = settings.promptTemplate || PROMPT_TEMPLATE_DEFAULT;
      promptOverlay.style.display = "flex";
      requestAnimationFrame(() => promptOverlay.classList.add("show"));
      setTimeout(() => {
        promptInput.focus();
        promptInput.setSelectionRange(0, 0);
        promptInput.scrollTop = 0;
      }, 50);
    }, "openPromptEditor");
    const closePromptEditor = /* @__PURE__ */ __name((revert = false) => {
      if (revert) promptInput.value = settings.promptTemplate || PROMPT_TEMPLATE_DEFAULT;
      promptOverlay.classList.remove("show");
      promptOverlay.style.display = "none";
    }, "closePromptEditor");
    editPromptBtn.addEventListener("click", openPromptEditor);
    promptCancelBtn.addEventListener("click", () => closePromptEditor(true));
    promptSaveBtn.addEventListener("click", () => {
      const value = promptInput.value;
      if (!value.trim()) {
        showNotification("\u8BF7\u8F93\u5165\u63D0\u793A\u8BCD\u5185\u5BB9", "error");
        promptInput.focus();
        return;
      }
      settings.promptTemplate = value;
      saveSettings();
      showNotification("\u63D0\u793A\u8BCD\u5DF2\u4FDD\u5B58");
      closePromptEditor();
    });
    promptOverlay.addEventListener("click", (e) => {
      if (e.target === promptOverlay) closePromptEditor(true);
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) {
        closeSettingsDialog();
      }
    });
    return dialog;
  }
  __name(createSettingsDialog, "createSettingsDialog");
  var panelTransformBeforeDialog = null;
  function hidePanelForDialog() {
    if (!elements.panel) return;
    panelTransformBeforeDialog = elements.panel.style.transform || "";
    elements.panel.style.transform = CONFIG.UI.PANEL_HIDDEN_TRANSFORM;
  }
  __name(hidePanelForDialog, "hidePanelForDialog");
  function restorePanelAfterDialog() {
    if (!elements.panel || panelTransformBeforeDialog === null) return;
    elements.panel.style.transform = panelTransformBeforeDialog;
    panelTransformBeforeDialog = null;
  }
  __name(restorePanelAfterDialog, "restorePanelAfterDialog");
  function closeSettingsDialog() {
    const dialog = document.getElementById("boss-settings-dialog");
    if (dialog) {
      dialog.style.display = "none";
      const promptOverlay = document.getElementById("prompt-editor-overlay");
      if (promptOverlay) {
        promptOverlay.classList.remove("show");
        promptOverlay.style.display = "none";
      }
    }
    restorePanelAfterDialog();
  }
  __name(closeSettingsDialog, "closeSettingsDialog");
  function showSettingsDialog() {
    let dialog = document.getElementById("boss-settings-dialog");
    if (!dialog) {
      dialog = createSettingsDialog();
      document.body.appendChild(dialog);
    }
    hidePanelForDialog();
    dialog.style.display = "flex";
    setTimeout(() => {
      dialog.classList.add("active");
      setTimeout(loadSettingsIntoUI, 100);
    }, 10);
  }
  __name(showSettingsDialog, "showSettingsDialog");
  function toggleStatusOption(value) {
    if (value === "\u4E0D\u9650") {
      settings.recruiterActivityStatus = ["\u4E0D\u9650"];
    } else {
      if (settings.recruiterActivityStatus.includes("\u4E0D\u9650")) {
        settings.recruiterActivityStatus = [value];
      } else {
        if (settings.recruiterActivityStatus.includes(value)) {
          settings.recruiterActivityStatus = settings.recruiterActivityStatus.filter(
            (v) => v !== value
          );
        } else {
          settings.recruiterActivityStatus.push(value);
        }
        if (settings.recruiterActivityStatus.length === 0) {
          settings.recruiterActivityStatus = ["\u4E0D\u9650"];
        }
      }
    }
    if (state.settings) {
      state.settings.recruiterActivityStatus = settings.recruiterActivityStatus;
    }
    updateStatusOptions();
  }
  __name(toggleStatusOption, "toggleStatusOption");
  function updateStatusOptions() {
    const options = document.querySelectorAll("#recruiter-status-select .select-option");
    options.forEach((option) => {
      const isSelected = settings.recruiterActivityStatus.includes(option.dataset.value);
      option.className = "select-option" + (isSelected ? " selected" : "");
      option.querySelector(".check-icon").style.display = isSelected ? "inline" : "none";
      if (option.dataset.value === "\u4E0D\u9650") {
        if (isSelected) {
          options.forEach((opt) => {
            if (opt.dataset.value !== "\u4E0D\u9650") {
              opt.className = "select-option";
              opt.querySelector(".check-icon").style.display = "none";
            }
          });
        }
      } else if (settings.recruiterActivityStatus.includes("\u4E0D\u9650")) {
        option.querySelector(".check-icon").style.display = "none";
        option.className = "select-option";
      }
    });
    options.forEach((option) => {
      const selected = option.classList.contains("selected");
      option.style.color = selected ? "#1a73e8" : "#606266";
      option.style.fontWeight = selected ? "600" : "400";
    });
    document.querySelector("#recruiter-status-select .select-value").textContent = getStatusDisplayText();
    if (state.settings) {
      state.settings.recruiterActivityStatus = settings.recruiterActivityStatus;
    }
  }
  __name(updateStatusOptions, "updateStatusOptions");
  function getStatusDisplayText() {
    if (settings.recruiterActivityStatus.includes("\u4E0D\u9650")) {
      return "\u4E0D\u9650";
    }
    if (settings.recruiterActivityStatus.length === 0) {
      return "\u4E0D\u9650";
    }
    if (settings.recruiterActivityStatus.length <= 3) {
      return settings.recruiterActivityStatus.join("\u3001");
    }
    return `${settings.recruiterActivityStatus.slice(0, 3).join("\u3001")} \u7B49 ${settings.recruiterActivityStatus.length} \u9879`;
  }
  __name(getStatusDisplayText, "getStatusDisplayText");
  function loadSettingsIntoUI() {
    const apiUrlInput = document.getElementById("ai-api-url-input");
    if (apiUrlInput) apiUrlInput.value = settings.aiApiUrl || "";
    const apiKeyInput = document.getElementById("ai-api-key-input");
    if (apiKeyInput) apiKeyInput.value = settings.aiApiKey || "";
    const modelInput = document.getElementById("ai-model-input");
    if (modelInput) modelInput.value = settings.aiModel || "";
    const templateInput = document.getElementById("prompt-template-input");
    if (templateInput) templateInput.value = settings.promptTemplate || PROMPT_TEMPLATE_DEFAULT;
    syncToggle("auto-send-resume", settings.useAutoSendResume);
    syncToggle("exclude-headhunters", settings.excludeHeadhunters);
    syncToggle(
      "auto-send-image-resume",
      !!(settings.useAutoSendImageResume && settings.imageResumes && settings.imageResumes.length > 0)
    );
    const modeNew = document.getElementById("communication-mode-new");
    const modeAuto = document.getElementById("communication-mode-auto");
    if (modeNew && modeAuto) {
      const isAuto = settings.communicationMode === "auto";
      modeNew.checked = !isAuto;
      modeAuto.checked = isAuto;
    }
    const applyIntervalInput = document.getElementById("apply-interval-input");
    if (applyIntervalInput) applyIntervalInput.value = settings.applyInterval;
    const maxApplyInput = document.getElementById("max-apply-input");
    if (maxApplyInput) maxApplyInput.value = settings.maxApplyPerRun;
    loadGreetings();
    updateStatusOptions();
    refreshImageResumeCount();
  }
  __name(loadSettingsIntoUI, "loadSettingsIntoUI");
  function syncToggle(id, checked) {
    const input = document.getElementById("toggle-" + id);
    if (!input) return;
    input.checked = !!checked;
    const container = input.closest(".toggle-switch");
    if (!container) return;
    const slider = container.querySelector(".toggle-slider");
    container.style.backgroundColor = checked ? "#1a73e8" : "#e4e7ed";
    if (slider) slider.style.left = checked ? "19px" : "3px";
  }
  __name(syncToggle, "syncToggle");
  function refreshImageResumeCount() {
    const display = document.getElementById("image-resume-filename");
    if (!display) return;
    const count = settings.imageResumes && settings.imageResumes.length || 0;
    display.textContent = count > 0 ? `\u5DF2\u4E0A\u4F20 ${count} \u4E2A\u7B80\u5386` : "\u672A\u9009\u62E9\u6587\u4EF6";
  }
  __name(refreshImageResumeCount, "refreshImageResumeCount");
  function createDialogHeader(title, dialogId = "boss-settings-dialog", tabs = null, onClose = null) {
    const header = document.createElement("div");
    header.className = "boss-dialog-header";
    header.style.cssText = `
        padding: 12px 18px;
        background: #ffffff;
        color: #202124;
        font-size: 17px;
        font-weight: 600;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        position: relative;
        border-radius: 12px 12px 0 0;
        border-bottom: 1px solid #e5e9f2;
        flex-shrink: 0;
    `;
    const titleElement = document.createElement("div");
    titleElement.textContent = title;
    titleElement.style.cssText = "font-weight: 600; white-space: nowrap;";
    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "\u2715";
    closeBtn.title = "\u5173\u95ED";
    closeBtn.style.cssText = `
        width: 28px;
        height: 28px;
        background: #e8f0fe;
        color: #1a73e8;
        border-radius: 50%;
        display: flex;
        justify-content: center;
        align-items: center;
        cursor: pointer;
        transition: all 0.2s ease;
        border: none;
        font-size: 16px;
        font-weight: bold;
    `;
    closeBtn.addEventListener("mouseenter", () => {
      closeBtn.style.backgroundColor = "#1a73e8";
      closeBtn.style.color = "#ffffff";
      closeBtn.style.transform = "scale(1.1)";
    });
    closeBtn.addEventListener("mouseleave", () => {
      closeBtn.style.backgroundColor = "#e8f0fe";
      closeBtn.style.color = "#1a73e8";
      closeBtn.style.transform = "scale(1)";
    });
    closeBtn.addEventListener("click", () => {
      if (onClose) {
        onClose();
        return;
      }
      const dialog = document.getElementById(dialogId);
      if (dialog) {
        dialog.style.display = "none";
      }
    });
    const leftGroup = document.createElement("div");
    leftGroup.style.cssText = "display:flex;align-items:center;gap:14px;min-width:0;";
    leftGroup.append(titleElement);
    if (tabs) leftGroup.append(tabs);
    header.append(leftGroup, closeBtn);
    return header;
  }
  __name(createDialogHeader, "createDialogHeader");
  function createSettingsGroup(title) {
    const group = document.createElement("div");
    group.className = "settings-group";
    group.style.marginBottom = "24px";
    const heading = document.createElement("h3");
    heading.textContent = title;
    heading.style.cssText = `
        margin: 0 0 12px;
        padding-left: 4px;
        color: #202124;
        font-size: 14px;
        font-weight: 500;
    `;
    const card = document.createElement("div");
    card.className = "settings-card";
    card.style.cssText = `
        background: #fff;
        border-radius: 12px;
        border: 1px solid #e5e9f2;
        padding: 0 20px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
    `;
    group.append(heading, card);
    return { group, card };
  }
  __name(createSettingsGroup, "createSettingsGroup");
  function createSettingItem(title, description, controlGetter) {
    const settingItem = document.createElement("div");
    settingItem.className = "setting-item";
    settingItem.style.cssText = `
        padding: 10px 0;
        border-bottom: 1px solid #f1f3f4;
        display: flex;
        flex-direction: column;
    `;
    const titleElement = document.createElement("h4");
    titleElement.textContent = title;
    titleElement.style.cssText = `
        margin: 0 0 4px;
        color: #202124;
        font-size: 14px;
        font-weight: 500;
    `;
    const descElement = document.createElement("p");
    descElement.textContent = description;
    descElement.style.cssText = `
        margin: 0;
        color: #5f6368;
        font-size: 12px;
        line-height: 1.5;
    `;
    const descriptionContainer = document.createElement("div");
    descriptionContainer.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
    `;
    const textContainer = document.createElement("div");
    textContainer.append(titleElement, descElement);
    descriptionContainer.append(textContainer);
    settingItem.append(descriptionContainer);
    settingItem.addEventListener("click", (e) => {
      if (e.target && e.target.closest && e.target.closest("input, textarea, select, button")) return;
      const control = controlGetter();
      if (control && typeof control.focus === "function") {
        control.focus();
      }
    });
    return {
      settingItem,
      descriptionContainer
    };
  }
  __name(createSettingItem, "createSettingItem");
  function createToggleSwitch(id, isChecked, onChange) {
    const container = document.createElement("div");
    container.className = "toggle-container";
    container.style.cssText = "display: flex; justify-content: space-between; align-items: center;";
    const switchContainer = document.createElement("div");
    switchContainer.className = "toggle-switch";
    switchContainer.style.cssText = `
        position: relative;
        width: 38px;
        height: 22px;
        border-radius: 22px;
        background-color: ${isChecked ? "#1a73e8" : "#e4e7ed"};
        cursor: pointer;
        opacity: 1;
        flex-shrink: 0;
    `;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `toggle-${id}`;
    checkbox.checked = isChecked;
    checkbox.style.display = "none";
    const slider = document.createElement("span");
    slider.className = "toggle-slider";
    slider.style.cssText = `
        position: absolute;
        top: 3px;
        left: ${isChecked ? "19px" : "3px"};
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background-color: white;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        transition: none;
    `;
    const forceUpdateUI = /* @__PURE__ */ __name((checked) => {
      checkbox.checked = checked;
      switchContainer.style.backgroundColor = checked ? "#1a73e8" : "#e4e7ed";
      slider.style.left = checked ? "19px" : "3px";
    }, "forceUpdateUI");
    checkbox.addEventListener("change", () => {
      let allowChange = true;
      if (onChange) {
        allowChange = onChange(checkbox.checked) !== false;
      }
      if (!allowChange) {
        forceUpdateUI(!checkbox.checked);
        return;
      }
      forceUpdateUI(checkbox.checked);
    });
    switchContainer.addEventListener("click", () => {
      const newState = !checkbox.checked;
      if (onChange) {
        if (onChange(newState) !== false) {
          forceUpdateUI(newState);
        }
      } else {
        forceUpdateUI(newState);
      }
    });
    switchContainer.append(checkbox, slider);
    container.append(switchContainer);
    return container;
  }
  __name(createToggleSwitch, "createToggleSwitch");
  function createSettingsButton(text, variant = "primary", onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.className = `settings-btn settings-btn-${variant}`;
    if (onClick) button.addEventListener("click", onClick);
    return button;
  }
  __name(createSettingsButton, "createSettingsButton");
  function addFocusBlurEffects(element) {
    element.addEventListener("focus", () => {
      element.style.borderColor = "rgba(26, 115, 232, 0.7)";
      element.style.boxShadow = "0 0 0 3px rgba(26, 115, 232, 0.2)";
    });
    element.addEventListener("blur", () => {
      element.style.borderColor = "#d1d5db";
      element.style.boxShadow = "none";
    });
  }
  __name(addFocusBlurEffects, "addFocusBlurEffects");
  function refreshPanelModeUI() {
    try {
      if (elements.controlBtn && !state.isRunning) {
        const isChat = PAGE.isChat();
        elements.controlBtn.textContent = isChat ? "\u5F00\u59CB\u804A\u5929" : "\u5F00\u59CB\u6295\u9012";
        elements.controlBtn.style.background = "var(--primary-color)";
      }
    } catch (e) {
      console.error("[BOSS\u6295\u9012\u52A9\u624B] \u5237\u65B0\u9762\u677F UI \u5931\u8D25:", e);
    }
  }
  __name(refreshPanelModeUI, "refreshPanelModeUI");
  function refreshStatsUI() {
    const map = {
      "stat-greeted": state.stats.greeted,
      "stat-skipped": state.stats.skipped,
      "stat-failed": state.stats.failed
    };
    Object.keys(map).forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(map[id]);
    });
  }
  __name(refreshStatsUI, "refreshStatsUI");
  function resetStats() {
    state.stats.greeted = 0;
    state.stats.skipped = 0;
    state.stats.failed = 0;
    state.stats.startTime = Date.now();
    refreshStatsUI();
  }
  __name(resetStats, "resetStats");
  function showNotification(message, type = "success") {
    const notification = document.createElement("div");
    const isSuccess = type === "success";
    const background = isSuccess ? "rgba(232, 240, 254, 0.92)" : "rgba(252, 232, 230, 0.94)";
    const color = isSuccess ? "#1a73e8" : "#d93025";
    const border = isSuccess ? "rgba(26, 115, 232, 0.25)" : "rgba(217, 48, 37, 0.25)";
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${background};
        color: ${color};
        border: 1px solid ${border};
        padding: 10px 15px;
        border-radius: 8px;
        box-shadow: 0 4px 14px rgba(26, 115, 232, 0.16);
        backdrop-filter: blur(6px);
        z-index: 9999999;
        opacity: 0;
        transition: opacity 0.3s ease;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => notification.style.opacity = "1", 10);
    setTimeout(() => {
      notification.style.opacity = "0";
      setTimeout(() => document.body.removeChild(notification), 300);
    }, 2e3);
  }
  __name(showNotification, "showNotification");

  // src/09-process.js
  function toggleProcess() {
    state.isRunning = !state.isRunning;
    if (state.isRunning) {
      state.comments.isCommentMode = false;
      state.jobList = [];
      if (elements.controlBtn) {
        elements.controlBtn.textContent = "\u505C\u6B62\u6295\u9012";
        elements.controlBtn.style.background = "#ef4444";
      }
      const logPanel = document.querySelector("#pro-log");
      if (logPanel) logPanel.innerHTML = "";
      const startTime = /* @__PURE__ */ new Date();
      Core.log(`\u5F00\u59CB\u8FD0\u884C\uFF0C\u65F6\u95F4\uFF1A${startTime.toLocaleTimeString()}`);
      Core.log("\u6B63\u5728\u9010\u4E2A\u6253\u5F00\u5C97\u4F4D\uFF0C\u4EA4\u7ED9 AI \u5224\u65AD\u662F\u5426\u6295\u9012\u2026");
      Core.startProcessing();
    } else {
      if (elements.controlBtn) {
        elements.controlBtn.textContent = "\u5F00\u59CB\u6295\u9012";
        elements.controlBtn.style.background = "var(--primary-color)";
      }
      state.isRunning = false;
      state.currentIndex = 0;
      if (typeof Core.stopAutoScroll === "function") {
        try {
          Core.stopAutoScroll();
        } catch (e) {
        }
      }
    }
  }
  __name(toggleProcess, "toggleProcess");
  function toggleChatProcess() {
    state.isRunning = !state.isRunning;
    if (state.isRunning) {
      elements.controlBtn.textContent = "\u505C\u6B62\u804A\u5929";
      elements.controlBtn.style.background = "#ef4444";
      const startTime = /* @__PURE__ */ new Date();
      Core.log(`\u5F00\u59CB\u804A\u5929\uFF0C\u65F6\u95F4\uFF1A${startTime.toLocaleTimeString()}`);
      Core.startProcessing();
    } else {
      elements.controlBtn.textContent = "\u5F00\u59CB\u804A\u5929";
      elements.controlBtn.style.background = "var(--primary-color)";
      state.isRunning = false;
      Core.resetChatScan();
      if (Core.messageObserver) {
        Core.messageObserver.disconnect();
        Core.messageObserver = null;
      }
      const stopTime = /* @__PURE__ */ new Date();
      Core.log(`\u505C\u6B62\u804A\u5929\uFF0C\u65F6\u95F4\uFF1A${stopTime.toLocaleTimeString()}`);
    }
  }
  __name(toggleChatProcess, "toggleChatProcess");

  // src/05-ui.js
  var PANEL_ICON = "data:image/png;base64,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";
  var svgIcon = /* @__PURE__ */ __name((body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`, "svgIcon");
  var ICONS = {
    settings: svgIcon(
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
    ),
    close: svgIcon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')
  };
  var UI = {
    PAGE_TYPES: {
      JOB_LIST: "jobList",
      CHAT: "chat"
    },
    currentPageType: null,
    init() {
      this.currentPageType = PAGE.isChat() ? this.PAGE_TYPES.CHAT : this.PAGE_TYPES.JOB_LIST;
      this._applyTheme();
      this.createControlPanel();
      this.createMiniIcon();
      this._restorePanelPosition();
    },
    /** 恢复面板上次的拖拽位置 */
    _restorePanelPosition() {
      try {
        const pos = settings.panelPosition;
        if (pos && elements.panel && typeof pos.left === "number") {
          elements.panel.style.right = "auto";
          elements.panel.style.top = pos.top + "px";
          elements.panel.style.left = pos.left + "px";
          this._clampPanelToViewport(elements.panel);
        }
      } catch (e) {
      }
    },
    /**
     * 把面板夹回视口内。
     *
     * 面板是 position: fixed，视口就是浏览器 tab 的可视区域 —— 夹住它就等于"永远在 tab 内"。
     * 面板比视口还大时（窗口很矮）整体放不下，退而求其次贴左上角，
     * 至少保证标题栏留在可视区里，用户还能拖得动。
     */
    _clampPanelToViewport(panel) {
      if (!panel) return;
      const MARGIN = 8;
      const rect = panel.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const maxLeft = Math.max(viewportWidth - rect.width - MARGIN, MARGIN);
      const maxTop = Math.max(viewportHeight - rect.height - MARGIN, MARGIN);
      const left = Math.min(Math.max(rect.left, MARGIN), maxLeft);
      const top = Math.min(Math.max(rect.top, MARGIN), maxTop);
      if (left !== rect.left || top !== rect.top) {
        panel.style.right = "auto";
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
      }
    },
    /** 旧版调用了未定义的 UI.notify，这里补上（对应"招呼语开关检测"提示） */
    notify(message, type) {
      if (typeof showNotification === "function") {
        showNotification(message, type === "warning" ? "error" : type || "success");
      } else {
        console.log("[BOSS\u6295\u9012\u52A9\u624B]", message);
      }
    },
    createControlPanel() {
      if (document.getElementById("boss-pro-panel")) {
        document.getElementById("boss-pro-panel").remove();
      }
      elements.panel = this._createPanel();
      const header = this._createHeader();
      const controls = this._createPageControls();
      elements.log = this._createLogger();
      elements.panel.append(header, controls, elements.log);
      document.body.appendChild(elements.panel);
      this._makeDraggable(elements.panel);
      refreshPanelModeUI();
      refreshStatsUI();
      this._clampPanelToViewport(elements.panel);
    },
    _applyTheme() {
      CONFIG.COLORS = this.currentPageType === this.PAGE_TYPES.JOB_LIST ? this.THEMES.JOB_LIST : this.THEMES.CHAT;
      document.documentElement.style.setProperty("--primary-color", CONFIG.COLORS.primary);
      document.documentElement.style.setProperty("--secondary-color", CONFIG.COLORS.secondary);
      document.documentElement.style.setProperty("--accent-color", CONFIG.COLORS.accent);
      document.documentElement.style.setProperty("--neutral-color", CONFIG.COLORS.neutral);
    },
    THEMES: {
      JOB_LIST: {
        primary: "#1a73e8",
        secondary: "#eff6ff",
        accent: "#dbeafe",
        neutral: "#5f6368"
      },
      CHAT: {
        primary: "#1a73e8",
        secondary: "#eff6ff",
        accent: "#dbeafe",
        neutral: "#5f6368"
      }
    },
    _createPanel() {
      const panel = document.createElement("div");
      panel.id = "boss-pro-panel";
      panel.className = this.currentPageType === this.PAGE_TYPES.JOB_LIST ? "boss-joblist-panel" : "boss-chat-panel";
      const baseStyles = `
            position: fixed;
            top: 36px;
            right: 24px;
            width: clamp(300px, 80vw, 400px);
            /* \u9ED8\u8BA4\u662F content-box\uFF1A\u4E0D\u52A0\u8FD9\u884C\u7684\u8BDD max-height \u53EA\u7EA6\u675F\u5185\u5BB9\u76D2\uFF0C
               12px padding + 1px border \u4F1A\u6F0F\u5728\u5916\u9762\uFF0C\u9762\u677F\u4ECD\u80FD\u8D85\u51FA\u89C6\u53E3 26px */
            box-sizing: border-box;
            border-radius: 12px;
            padding: 12px;
            font-family: 'Segoe UI', system-ui, sans-serif;
            z-index: 2147483647;
            display: flex;
            flex-direction: column;
            /* \u9762\u677F\u6BD4\u89C6\u53E3\u8FD8\u9AD8\u65F6\u5185\u90E8\u6EDA\u52A8\uFF0C\u4FDD\u8BC1\u6574\u4F53\u59CB\u7EC8\u4E0D\u8D85\u51FA tab */
            max-height: calc(100vh - 16px);
            overflow-x: hidden;
            overflow-y: auto;
            transition: all 0.3s ease;
            background: #ffffff;
            box-shadow: 0 10px 25px rgba(var(--primary-rgb), 0.15);
            border: 1px solid var(--accent-color);
            cursor: default;
        `;
      panel.style.cssText = baseStyles;
      const rgbColor = this._hexToRgb(CONFIG.COLORS.primary);
      document.documentElement.style.setProperty("--primary-rgb", rgbColor);
      return panel;
    },
    _createHeader() {
      const header = document.createElement("div");
      header.className = this.currentPageType === this.PAGE_TYPES.JOB_LIST ? "boss-header" : "boss-chat-header";
      header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0 10px 15px;
            margin-bottom: 15px;
            border-bottom: 1px solid var(--accent-color);
        `;
      const title = this._createTitle();
      const buttonContainer = document.createElement("div");
      buttonContainer.style.cssText = `
            display: flex;
            gap: 8px;
        `;
      const buttonTitles = this.currentPageType === this.PAGE_TYPES.JOB_LIST ? {
        activate: "\u6FC0\u6D3B\u63D2\u4EF6",
        settings: "\u63D2\u4EF6\u8BBE\u7F6E",
        close: "\u6700\u5C0F\u5316\u6295\u9012\u9762\u677F"
      } : {
        activate: "\u6FC0\u6D3B\u63D2\u4EF6",
        settings: "\u63D2\u4EF6\u8BBE\u7F6E",
        close: "\u6700\u5C0F\u5316\u804A\u5929\u9762\u677F"
      };
      var settingsBtn = this._createIconButton(
        ICONS.settings,
        function() {
          try {
            showSettingsDialog();
          } catch (e) {
            console.error("[BOSS\u6295\u9012\u52A9\u624B] \u6253\u5F00\u8BBE\u7F6E\u5931\u8D25:", e);
            if (typeof showNotification === "function") {
              showNotification("\u6253\u5F00\u8BBE\u7F6E\u5931\u8D25\uFF1A" + e.message, "error");
            }
          }
        },
        buttonTitles.settings
      );
      var closeBtn = this._createIconButton(
        ICONS.close,
        function() {
          state.isMinimized = true;
          elements.panel.style.transform = CONFIG.UI.PANEL_HIDDEN_TRANSFORM;
          if (elements.miniIcon) elements.miniIcon.style.display = "flex";
        },
        buttonTitles.close
      );
      buttonContainer.append(settingsBtn, closeBtn);
      header.append(title, buttonContainer);
      return header;
    },
    _createTitle() {
      const title = document.createElement("div");
      title.style.display = "flex";
      title.style.alignItems = "center";
      title.style.gap = "10px";
      const titleConfig = {
        main: `<span style="color:var(--primary-color);">BOSS</span>\u6295\u9012\u52A9\u624B`,
        sub: ""
      };
      title.innerHTML = `
        <div class="boss-panel-drag-handle" title="\u6309\u4F4F\u62D6\u52A8\u9762\u677F" style="
            width: 40px;
            height: 40px;
            background: #ffffff;
            border: 1px solid var(--accent-color);
            border-radius: 10px;
            display: flex;
            justify-content: center;
            align-items: center;
            font-weight: bold;
            box-shadow: 0 2px 8px rgba(var(--primary-rgb), 0.2);
            overflow: hidden;
        ">
            <img src="${PANEL_ICON}" alt="" draggable="false" style="width:100%;height:100%;object-fit:cover;display:block;">
        </div>
        <div>
            <h3 style="
                margin: 0;
                color: #2c3e50;
                font-weight: 600;
                font-size: 1.2rem;
            ">
                ${titleConfig.main}
            </h3>
            ${titleConfig.sub ? `<span style="font-size:0.8em;color:var(--neutral-color);">${titleConfig.sub}</span>` : ""}
        </div>
    `;
      return title;
    },
    _createPageControls() {
      if (this.currentPageType === this.PAGE_TYPES.JOB_LIST) {
        return this._createJobListControls();
      } else {
        return this._createChatControls();
      }
    },
    _createJobListControls() {
      const container = document.createElement("div");
      container.className = "boss-joblist-controls";
      container.style.marginBottom = "15px";
      container.style.padding = "0 10px";
      const box = document.createElement("div");
      box.style.cssText = `
            background: var(--secondary-color);
            border-radius: 12px;
            padding: 15px;
        `;
      elements.controlBtn = this._createTextButton("\u5F00\u59CB\u6295\u9012", "var(--primary-color)", () => {
        toggleProcess();
      });
      box.append(this._createStats(), elements.controlBtn);
      container.append(box);
      return container;
    },
    _createChatControls() {
      this._injectChatModeStyles();
      const container = document.createElement("div");
      container.className = "boss-chat-controls";
      container.style.cssText = `
            margin-left: 10px;
            margin-right: 10px;
            margin-bottom: 15px;
        `;
      const actionCard = document.createElement("div");
      actionCard.style.cssText = `
            background: var(--secondary-color);
            padding: 12px 16px;
            border-radius: 12px;
        `;
      const makeRadio = /* @__PURE__ */ __name((id, value) => {
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.id = id;
        radio.name = "boss-chat-communication-mode";
        radio.value = value;
        radio.className = "chat-mode-radio";
        return radio;
      }, "makeRadio");
      const newOnlyRadio = makeRadio("communication-mode-new", "new-only");
      const autoRadio = makeRadio("communication-mode-auto", "auto");
      const isAuto = settings.communicationMode === "auto";
      newOnlyRadio.checked = !isAuto;
      autoRadio.checked = isAuto;
      const segmented = document.createElement("div");
      segmented.className = "segmented-control";
      const makeModeLabel = /* @__PURE__ */ __name((forId, text) => {
        const label = document.createElement("label");
        label.htmlFor = forId;
        label.textContent = text;
        return label;
      }, "makeModeLabel");
      segmented.append(
        makeModeLabel("communication-mode-new", "\u4EC5\u65B0\u6D88\u606F"),
        makeModeLabel("communication-mode-auto", "\u81EA\u52A8\u8F6E\u8BE2")
      );
      const helper = document.createElement("div");
      helper.className = "chat-mode-helper";
      const helperNew = document.createElement("span");
      helperNew.className = "chat-mode-text text-new";
      helperNew.textContent = "\u53EA\u770B\u4F1A\u8BDD\u5217\u8868\u6700\u4E0A\u9762\u4E00\u6761\uFF0C\u6709\u53D8\u5316\u65F6\u624D\u5904\u7406";
      const helperAuto = document.createElement("span");
      helperAuto.className = "chat-mode-text text-auto";
      helperAuto.textContent = "\u4ECE\u7B2C\u4E00\u6761\u5F00\u59CB\u9010\u6761\u6253\u5F00\u5904\u7406\uFF0C\u5230\u6700\u540E\u4E00\u6761\u81EA\u52A8\u505C\u6B62";
      helper.append(helperNew, helperAuto);
      const onModeChange = /* @__PURE__ */ __name((mode) => {
        settings.communicationMode = mode;
        saveSettings();
      }, "onModeChange");
      newOnlyRadio.addEventListener("change", () => {
        if (newOnlyRadio.checked) onModeChange("new-only");
      });
      autoRadio.addEventListener("change", () => {
        if (autoRadio.checked) onModeChange("auto");
      });
      elements.controlBtn = this._createTextButton("\u5F00\u59CB\u804A\u5929", "var(--primary-color)", () => {
        toggleChatProcess();
      });
      elements.controlBtn.style.padding = "10px";
      elements.controlBtn.style.borderRadius = "8px";
      elements.controlBtn.style.fontSize = "15px";
      actionCard.append(newOnlyRadio, autoRadio, segmented, helper, elements.controlBtn);
      container.append(actionCard);
      return container;
    },
    /** 沟通模式分段控制器的样式。挂在 document.head，面板重建时不重复注入 */
    _injectChatModeStyles() {
      if (document.getElementById("boss-chat-mode-style")) return;
      const style2 = document.createElement("style");
      style2.id = "boss-chat-mode-style";
      style2.textContent = `
      #boss-pro-panel .chat-mode-radio { display: none; }
      #boss-pro-panel .segmented-control {
        display: flex;
        background-color: #dbeafe;
        padding: 3px;
        border-radius: 10px;
        margin-bottom: 4px;
      }
      #boss-pro-panel .segmented-control label {
        flex: 1;
        text-align: center;
        padding: 5px 0;
        font-size: 14px;
        color: #4b5563;
        cursor: pointer;
        border-radius: 8px;
        transition: all 0.2s ease;
        user-select: none;
      }
      #boss-pro-panel #communication-mode-new:checked ~ .segmented-control label[for="communication-mode-new"],
      #boss-pro-panel #communication-mode-auto:checked ~ .segmented-control label[for="communication-mode-auto"] {
        background-color: #ffffff;
        color: #1a73e8;
        font-weight: 600;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.05);
      }
      #boss-pro-panel .chat-mode-helper {
        height: 16px;
        margin-bottom: 2px;
        padding-left: 4px;
        line-height: 16px;
      }
      #boss-pro-panel .chat-mode-text {
        display: none;
        align-items: center;
        font-size: 12px;
        line-height: 16px;
        color: #94a3b8;
      }
      #boss-pro-panel #communication-mode-new:checked ~ .chat-mode-helper .text-new,
      #boss-pro-panel #communication-mode-auto:checked ~ .chat-mode-helper .text-auto {
        display: flex;
      }
    `;
      document.head.appendChild(style2);
    },
    _createLogger() {
      const log = document.createElement("div");
      log.id = "pro-log";
      log.className = this.currentPageType === this.PAGE_TYPES.JOB_LIST ? "boss-joblist-log" : "boss-chat-log";
      const height = this.currentPageType === this.PAGE_TYPES.JOB_LIST ? "260px" : "260px";
      log.style.cssText = `
            height: ${height};
            overflow-y: auto;
            background: var(--secondary-color);
            border-radius: 12px;
            padding: 12px;
            font-size: 13px;
            line-height: 1.5;
            margin-bottom: 15px;
            margin-left: 10px;
            margin-right: 10px;
            transition: all 0.3s ease;
            user-select: text;
            scrollbar-width: thin;
            scrollbar-color: var(--primary-color) var(--secondary-color);
        `;
      log.innerHTML += `
            <style>
                #pro-log::-webkit-scrollbar {
                    width: 6px;
                }
                #pro-log::-webkit-scrollbar-track {
                    background: var(--secondary-color);
                    border-radius: 4px;
                }
                #pro-log::-webkit-scrollbar-thumb {
                    background-color: var(--primary-color);
                    border-radius: 4px;
                }
            </style>
        `;
      return log;
    },
    /** 统计栏只放一份：全局靠 id 取值，重复挂载会让 refreshStatsUI 更新到失效的那份 */
    _createStats() {
      const statsContainer = document.createElement("div");
      statsContainer.id = "boss-panel-stats";
      statsContainer.style.cssText = `
            display: flex;
            justify-content: space-around;
            margin-bottom: 15px;
            gap: 6px;
        `;
      statsContainer.innerHTML = `
        <div style="flex:1;text-align:center;"><div id="stat-greeted" style="font-size:16px;font-weight:600;color:var(--primary-color);">0</div><div style="font-size:11px;color:#94a3b8;">\u5DF2\u6C9F\u901A</div></div>
        <div style="flex:1;text-align:center;"><div id="stat-skipped" style="font-size:16px;font-weight:600;color:#94a3b8;">0</div><div style="font-size:11px;color:#94a3b8;">\u5DF2\u8DF3\u8FC7</div></div>
        <div style="flex:1;text-align:center;"><div id="stat-failed" style="font-size:16px;font-weight:600;color:#ef4444;">0</div><div style="font-size:11px;color:#94a3b8;">\u5931\u8D25</div></div>
      `;
      return statsContainer;
    },
    _createTextButton(text, bgColor, onClick) {
      const btn = document.createElement("button");
      btn.className = "boss-btn";
      btn.textContent = text;
      btn.style.cssText = `
            width: 100%;
            padding: 10px 16px;
            background: ${bgColor};
            color: #fff;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            font-size: 15px;
            font-weight: 500;
            transition: all 0.3s ease;
            display: flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 4px 10px rgba(0,0,0,0.1);
            transform: translateY(0px);
            margin: 0 auto;
        `;
      this._addButtonHoverEffects(btn);
      btn.addEventListener("click", onClick);
      return btn;
    },
    /**
     * 面板头部的圆形图标按钮。
     *
     * hover 只切换按钮自己的 `color` / `background`，图标靠 `currentColor` 跟着变。
     * 旧版是逐个把 `svg path` 的 `fill` 改成白色、离开再改回来 —— 那套只对"单色剪影"
     * 图标成立，换成描边图标（fill:none）会把整个图形填成一坨白。
     */
    _createIconButton(icon, onClick, title) {
      const btn = document.createElement("button");
      btn.className = "boss-icon-btn";
      btn.innerHTML = icon;
      btn.title = title;
      btn.style.cssText = "width:32px;height:32px;border-radius:50%;border:none;background:var(--accent-color);cursor:pointer;display:flex;justify-content:center;align-items:center;color:var(--primary-color);padding:0;line-height:0;transition:all 0.2s ease;";
      btn.addEventListener("click", onClick);
      btn.addEventListener("mouseenter", function() {
        btn.style.backgroundColor = "var(--primary-color)";
        btn.style.color = "#fff";
        btn.style.transform = "scale(1.1)";
      });
      btn.addEventListener("mouseleave", function() {
        btn.style.backgroundColor = "var(--accent-color)";
        btn.style.color = "var(--primary-color)";
        btn.style.transform = "scale(1)";
      });
      return btn;
    },
    _addButtonHoverEffects(btn) {
      btn.addEventListener("mouseenter", () => {
        btn.style.boxShadow = `0 6px 15px rgba(var(--primary-rgb), 0.3)`;
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.boxShadow = "0 4px 10px rgba(0,0,0,0.1)";
      });
    },
    /**
     * 面板拖拽（按住标题栏左侧的图标移动）。
     *
     * 相比旧版改了三处：
     *   1. 拖拽区从整条标题栏缩到左边那个 40x40 图标。标题栏整条可拖时，点标题文字、
     *      想选中日志里的文字都很容易误拖，面板一跑就找不着了。
     *   2. 拖动过程中就把面板夹在视口内。旧版只改 left/top 不限范围，很容易整块被拖到
     *      窗口外，之后连标题栏都点不到，面板就再也拉不回来了。
     *   3. mousemove/mouseup 改成拖拽期间才挂、松手立刻摘。旧版在 _makeDraggable 里直接
     *      往 document 上挂，而每次路由切换都会重建面板并重跑一遍，监听越叠越多。
     */
    _makeDraggable(panel) {
      const handle = panel.querySelector(".boss-panel-drag-handle");
      if (!handle) return;
      handle.style.cursor = "move";
      let isDragging = false;
      let startX = 0, startY = 0;
      let initialX = 0, initialY = 0;
      const onMouseMove = /* @__PURE__ */ __name((e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        panel.style.right = "auto";
        panel.style.left = `${initialX + dx}px`;
        panel.style.top = `${initialY + dy}px`;
        this._clampPanelToViewport(panel);
      }, "onMouseMove");
      const onMouseUp = /* @__PURE__ */ __name(() => {
        if (!isDragging) return;
        isDragging = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        panel.style.transition = "all 0.3s ease";
        panel.style.zIndex = "2147483646";
        try {
          const rect = panel.getBoundingClientRect();
          settings.panelPosition = { left: rect.left, top: rect.top };
          debouncedSaveSettings();
        } catch (e) {
        }
      }, "onMouseUp");
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;
        panel.style.right = "auto";
        panel.style.left = `${initialX}px`;
        panel.style.top = `${initialY}px`;
        panel.style.transition = "none";
        panel.style.zIndex = "2147483647";
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });
      if (!this._viewportClampBound) {
        this._viewportClampBound = true;
        window.addEventListener("resize", () => {
          this._clampPanelToViewport(document.getElementById("boss-pro-panel"));
        });
      }
    },
    createMiniIcon() {
      const oldMini = document.getElementById("boss-mini-icon");
      if (oldMini) oldMini.remove();
      elements.miniIcon = document.createElement("div");
      elements.miniIcon.id = "boss-mini-icon";
      elements.miniIcon.title = "\u5C55\u5F00 BOSS \u6295\u9012\u52A9\u624B";
      elements.miniIcon.style.cssText = `
        width: ${CONFIG.UI.MINI_ICON_SIZE || 48}px;
        height: ${CONFIG.UI.MINI_ICON_SIZE || 48}px;
        position: fixed;
        bottom: 40px;
        left: 40px;
        background: #ffffff;
        border: 1px solid var(--accent-color);
        border-radius: 50%;
        box-shadow: 0 6px 16px rgba(var(--primary-rgb), 0.3);
        cursor: pointer;
        display: none;
        justify-content: center;
        align-items: center;
        z-index: 2147483647;
        transition: all 0.3s ease;
        overflow: hidden;

    `;
      elements.miniIcon.innerHTML = `<img src="${PANEL_ICON}" alt="" draggable="false" style="width:100%;height:100%;object-fit:cover;display:block;">`;
      elements.miniIcon.addEventListener("mouseenter", () => {
        elements.miniIcon.style.transform = "scale(1.1)";
        elements.miniIcon.style.boxShadow = `0 8px 20px rgba(var(--primary-rgb), 0.5)`;
      });
      elements.miniIcon.addEventListener("mouseleave", () => {
        elements.miniIcon.style.transform = "scale(1)";
        elements.miniIcon.style.boxShadow = `0 6px 16px rgba(var(--primary-rgb), 0.4)`;
      });
      elements.miniIcon.addEventListener("click", () => {
        state.isMinimized = false;
        elements.panel.style.transform = "translateY(0)";
        elements.miniIcon.style.display = "none";
      });
      document.body.appendChild(elements.miniIcon);
    },
    _hexToRgb(hex) {
      hex = hex.replace("#", "");
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      return `${r}, ${g}, ${b}`;
    }
  };

  // src/10-storage.js
  var STORAGE = {
    GUIDE: "shouldShowGuide",
    VISITED_GREET_SET: "hasVisitedGreetSet"
  };

  // src/08-core.js
  var Core = {
    CONFIG,
    messageObserver: null,
    lastProcessedMessage: null,
    processingMessage: false,
    currentMonitoredHR: null,
    /** 「自动轮询」的全量遍历游标（见 handleChatPageAuto） */
    chatScan: null,
    chatScanMode: "",
    chatStoreWarned: false,
    /** 每轮聊天的运行令牌：避免"停止后立刻重启"时旧循环还活着、变成两个循环 */
    chatRunId: 0,
    domCache: {},
    /** 右侧详情区根节点的缓存（BOSS 改版后 class 名不可靠，见 findDetailRoot） */
    _detailRoot: null,
    getCachedElement(selector, forceRefresh = false) {
      if (forceRefresh || !this.domCache[selector]) {
        this.domCache[selector] = document.querySelector(selector);
      }
      return this.domCache[selector];
    },
    getCachedElements(selector, forceRefresh = false) {
      if (forceRefresh || !this.domCache[selector + "[]"]) {
        this.domCache[selector + "[]"] = document.querySelectorAll(selector);
      }
      return this.domCache[selector + "[]"];
    },
    clearDomCache() {
      this.domCache = {};
      this._detailRoot = null;
    },
    extractJobInfo(card) {
      try {
        const jobLink = card.querySelector('a[href*="/job_detail/"]');
        if (!jobLink) {
          this.log("\u672A\u627E\u5230\u804C\u4F4D\u8BE6\u60C5\u94FE\u63A5");
          return null;
        }
        const href = jobLink.getAttribute("href");
        this.log(`\u804C\u4F4D\u94FE\u63A5: ${href}`);
        const jobIdMatch = href.match(/job_detail\/([^.]+)\.html/);
        if (!jobIdMatch) {
          this.log("\u65E0\u6CD5\u63D0\u53D6jobId");
          return null;
        }
        const jobId = jobIdMatch[1];
        const securityIdMatch = href.match(/securityId=([^&]+)/);
        const securityId = securityIdMatch ? securityIdMatch[1] : null;
        const lidMatch = href.match(/lid=([^&]+)/);
        const lid = lidMatch ? lidMatch[1] : "";
        this.log(
          `\u63D0\u53D6\u4FE1\u606F - jobId: ${jobId}, securityId: ${securityId ? "\u5DF2\u83B7\u53D6" : "\u672A\u627E\u5230"}, lid: ${lid}`
        );
        return {
          jobId,
          securityId,
          lid
        };
      } catch (error) {
        this.log(`\u63D0\u53D6\u804C\u4F4D\u4FE1\u606F\u5931\u8D25: ${error.message}`);
        return null;
      }
    },
    async sendFriendRequest(jobId, securityId, lid) {
      try {
        if (!securityId) {
          throw new Error("\u7F3A\u5C11securityId\u53C2\u6570");
        }
        const timestamp = Date.now();
        const url = `/wapi/zpgeek/friend/add.json?securityId=${encodeURIComponent(securityId)}&jobId=${encodeURIComponent(jobId || "")}&lid=${encodeURIComponent(lid || "")}&_=${timestamp}`;
        const response = await fetch(url, {
          method: "POST",
          body: "sessionId="
        });
        const result = await response.json();
        if (result.code === 0) {
          return result;
        } else {
          throw new Error(result.message || "\u8BF7\u6C42\u5931\u8D25");
        }
      } catch (error) {
        throw error;
      }
    },
    /* =====================================================================
     * v2.1.0 重写：投递主流程
     *
     * 旧版致命问题：
     *   1) 用 location.pathname.includes("/jobs") 判断页面，而真实地址是
     *      /web/geek/job（无 s） → while 循环里两个分支都不命中，
     *      表现就是"脚本只是在找，不会投递"；
     *   2) 把 li.job-card-box 的 DOM 节点缓存进 state.jobList，BOSS 在点击后会
     *      重新渲染列表，缓存节点变成游离节点，后续 click() 全部无效；
     *   3) 点完「立即沟通」后只点了"留在此页"，既不校验是否真的投递成功，
     *      也不会发送 AI 生成的招呼语。
     * ===================================================================== */
    /** 取页面上的职位卡片（兼容两种 DOM 结构） */
    getJobCards() {
      let cards = Array.from(document.querySelectorAll("li.job-card-box"));
      if (!cards.length) {
        cards = Array.from(
          document.querySelectorAll(".job-list-box .job-card-wrapper, ul.job-list-box > li")
        );
      }
      return cards;
    },
    /** 取职位的稳定标识（优先 jobId，其次标题+公司） */
    getCardJobId(card) {
      if (!card) return null;
      try {
        if (card.dataset && (card.dataset.jobid || card.dataset.lid)) {
          return card.dataset.jobid || card.dataset.lid;
        }
        const a = card.querySelector('a[href*="/job_detail/"]') || (card.tagName === "A" ? card : null);
        if (a) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/job_detail\/([^.\/?#]+)\.html/);
          if (m) return m[1];
        }
        const inner = card.querySelector("[data-jobid]");
        if (inner && inner.dataset.jobid) return inner.dataset.jobid;
        const t = card.querySelector(".job-name");
        const c = card.querySelector(".company-name, .company-info .name");
        if (t) {
          return (t.textContent.trim() + "|" + (c ? c.textContent.trim() : "")).slice(0, 120);
        }
      } catch (e) {
      }
      return null;
    },
    /** 按标识重新查一次卡片，避免使用已被 React 替换掉的游离节点 */
    findCardById(jobId) {
      if (!jobId) return null;
      const cards = this.getJobCards();
      for (const c of cards) {
        if (this.getCardJobId(c) === jobId) return c;
      }
      return null;
    },
    async startProcessing() {
      if (PAGE.isChat()) {
        this.log("\u5F00\u59CB\u76D1\u542C\u62DB\u8058\u8005\u6D88\u606F\u2026");
        this.resetChatScan();
        this.chatScanMode = settings.communicationMode;
        this.chatStoreWarned = false;
        const runId = ++this.chatRunId;
        while (state.isRunning && this.chatRunId === runId) {
          if (this.chatScanMode !== settings.communicationMode) {
            this.chatScanMode = settings.communicationMode;
            const modeLabel = settings.communicationMode === "auto" ? "\u81EA\u52A8\u8F6E\u8BE2" : "\u4EC5\u65B0\u6D88\u606F";
            this.log(`\u6C9F\u901A\u6A21\u5F0F\u5DF2\u5207\u6362\u4E3A\u300C${modeLabel}\u300D\uFF0C\u5DF2\u91CD\u7F6E\u4F1A\u8BDD\u72B6\u6001`);
            this.resetChatScan();
            this.resetMessageState();
            this.currentMonitoredHR = null;
            if (this.messageObserver) {
              this.messageObserver.disconnect();
              this.messageObserver = null;
            }
          }
          try {
            if (settings.communicationMode === "auto") {
              await this.handleChatPageAuto();
            } else {
              await this.handleChatPage();
            }
          } catch (e) {
            this.log(`\u804A\u5929\u5904\u7406\u5F02\u5E38: ${e.message}`);
          }
          const wait = settings.communicationMode === "auto" ? CONFIG.CHAT.POLL_INTERVAL : CONFIG.BASIC_INTERVAL;
          await this.delay(wait);
        }
        return;
      }
      if (!PAGE.isJobList()) {
        this.log("\u5F53\u524D\u9875\u9762\u4E0D\u662F\u804C\u4F4D\u5217\u8868\uFF0C\u8BF7\u6253\u5F00 www.zhipin.com/web/geek/jobs \u540E\u91CD\u8BD5");
        if (state.isRunning) toggleProcess();
        return;
      }
      if (!settings.aiApiKey) {
        this.log("\u65E0\u6CD5\u5F00\u59CB\uFF1A\u8BF7\u5148\u5728\u300C\u8BBE\u7F6E \u2192 \u901A\u7528\u300D\u4E2D\u914D\u7F6E API Key");
        if (state.isRunning) toggleProcess();
        return;
      }
      const { missing } = renderPrompt(settings.promptTemplate || PROMPT_TEMPLATE_DEFAULT, {});
      if (missing.length) {
        this.log(
          `\u26A0\uFE0F \u63D0\u793A\u8BCD\u91CC\u6709 ${missing.length} \u5904\u5360\u4F4D\u7B26\u6CA1\u6CD5\u66FF\u6362\uFF1A${missing.map((n) => `{${n}}`).join("\u3001")}`
        );
        this.log(
          `\u3000\u53EF\u7528\u53D8\u91CF\u53EA\u6709 ${BUILTIN_PROMPT_VARS.map((n) => `{${n}}`).join(" ")}\uFF0C\u5176\u4F59\u7684\u4F1A\u539F\u6837\u53D1\u7ED9 AI\uFF08\u672C\u6B21\u7167\u5E38\u7EE7\u7EED\uFF09`
        );
      }
      resetStats();
      await this.autoScrollJobList();
      if (!state.isRunning) return;
      const allCards = this.getJobCards();
      const cards = this.filterJobCards(allCards);
      if (!cards.length) {
        this.log(
          allCards.length ? `\u5171 ${allCards.length} \u4E2A\u5C97\u4F4D\uFF0C\u90FD\u88AB\u672C\u5730\u89C4\u5219\u8FC7\u6EE4\u6389\u4E86\uFF08\u68C0\u67E5\u662F\u5426\u5F00\u542F\u4E86\u300C\u6392\u9664\u730E\u5934\u300D\uFF09` : "\u9875\u9762\u4E0A\u6CA1\u6709\u627E\u5230\u804C\u4F4D\u5361\u7247\uFF0C\u8BF7\u786E\u8BA4\u804C\u4F4D\u5217\u8868\u5DF2\u52A0\u8F7D\u5B8C\u6210\uFF08\u53EF\u5148\u624B\u52A8\u641C\u7D22\u4E00\u6B21\uFF09"
        );
        if (state.isRunning) toggleProcess();
        return;
      }
      this.log(`\u5171 ${cards.length}/${allCards.length} \u4E2A\u804C\u4F4D\uFF0C\u5F00\u59CB\u9010\u4E2A\u4EA4\u7ED9 AI \u5224\u5B9A\u2026`);
      const maxApply = settings.maxApplyPerRun || CONFIG.SAFETY.MAX_APPLY_PER_RUN;
      const interval = Math.max(800, settings.applyInterval || CONFIG.SAFETY.APPLY_INTERVAL);
      const done = /* @__PURE__ */ new Set();
      let applied = 0;
      for (let i = 0; i < cards.length; i++) {
        if (!state.isRunning) break;
        if (applied >= maxApply) {
          this.log(`\u5DF2\u8FBE\u5230\u5355\u6B21\u6295\u9012\u4E0A\u9650 ${maxApply} \u4E2A\uFF0C\u81EA\u52A8\u505C\u6B62\uFF08\u53EF\u5728\u8BBE\u7F6E\u4E2D\u8C03\u6574\uFF09`);
          break;
        }
        state.currentIndex = i;
        const jobId = this.getCardJobId(cards[i]);
        if (jobId && done.has(jobId)) {
          continue;
        }
        if (jobId) done.add(jobId);
        try {
          const ok = await this.processOneJob(cards[i], i, cards.length);
          if (ok) applied++;
        } catch (e) {
          state.stats.failed++;
          refreshStatsUI();
          this.log(`\u5904\u7406\u7B2C ${i + 1} \u4E2A\u804C\u4F4D\u51FA\u9519\uFF1A${e.message}`);
        }
        await this.delay(interval);
      }
      if (state.isRunning) {
        this.log(
          `\u672C\u6B21\u8FD0\u884C\u7ED3\u675F\uFF1A\u6210\u529F\u6C9F\u901A ${applied} \u4E2A\uFF0C\u8DF3\u8FC7 ${state.stats.skipped} \u4E2A\uFF0C\u5931\u8D25 ${state.stats.failed} \u4E2A`
        );
        toggleProcess();
      }
    },
    /** 自动滚动加载岗位列表（旧版没有步数上限，页面持续增长时会无限递归） */
    async autoScrollJobList() {
      return new Promise((resolve) => {
        const waitTime = CONFIG.BASIC_INTERVAL;
        const maxSteps = CONFIG.SAFETY.MAX_SCROLL_STEPS;
        let history2 = [];
        let step = 0;
        let stopped = false;
        this.stopAutoScroll = () => {
          stopped = true;
          resolve(null);
        };
        const scrollStep = /* @__PURE__ */ __name(async () => {
          if (stopped || !state.isRunning) return resolve(null);
          step++;
          const cards = this.getJobCards();
          history2.push(cards.length);
          if (history2.length > 3) history2.shift();
          const stable = history2.length === 3 && new Set(history2).size === 1;
          if (stable || step >= maxSteps) {
            this.log(
              `\u5C97\u4F4D\u5217\u8868\u52A0\u8F7D\u5B8C\u6210\uFF0C\u5171 ${cards.length} \u4E2A${step >= maxSteps ? "\uFF08\u5DF2\u8FBE\u6EDA\u52A8\u4E0A\u9650\uFF09" : ""}`
            );
            return resolve(cards);
          }
          window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: "smooth"
          });
          await this.delay(waitTime);
          scrollStep();
        }, "scrollStep");
        scrollStep();
      });
    },
    /** 读取招聘者活跃状态 */
    getRecruiterActiveTime() {
      try {
        const onlineTag = document.querySelector(".boss-online-tag");
        if (onlineTag && onlineTag.textContent.trim() === "\u5728\u7EBF") return "\u5728\u7EBF";
        const el = document.querySelector(".boss-active-time") || document.querySelector(".job-detail-box .boss-active-time");
        return el && el.textContent.trim() || "\u672A\u77E5";
      } catch (e) {
        return "\u672A\u77E5";
      }
    },
    /**
     * 找到详情区的沟通按钮。
     * v2.1.0 修复：旧版用 document.querySelector("a.op-btn-chat")，
     * 而职位卡片的底部按钮也用同一个 class，于是永远取到的是"卡片上的按钮"，
     * 点完之后按钮变成"继续沟通"，下一个职位又被判定为"已沟通过" → 表现为只找不投递。
     * 因此这里必须优先在详情区里找。
     */
    findChatButton() {
      const detailScopes = this.DETAIL_SCOPES;
      const innerSelectors = [
        "a.op-btn-chat",
        ".op-btn-chat",
        "a.btn-startchat",
        ".btn-startchat",
        "a[ka*='job-detail-chat']",
        "a[href*='chat']",
        ".btn.btn-primary"
      ];
      const isChatText = /* @__PURE__ */ __name((el) => {
        const text = (el.textContent || "").replace(/\s+/g, "");
        return text.indexOf("\u6C9F\u901A") !== -1 || text.indexOf("\u6295\u9012") !== -1 || text.indexOf("\u6253\u62DB\u547C") !== -1;
      }, "isChatText");
      for (const scope of detailScopes) {
        const root = document.querySelector(scope);
        if (!root) continue;
        for (const sel of innerSelectors) {
          const els = root.querySelectorAll(sel);
          for (const el of els) {
            if (isChatText(el)) return el;
          }
        }
      }
      for (const sel of innerSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!isChatText(el)) continue;
          if (el.closest("li.job-card-box, .job-card-wrapper")) continue;
          return el;
        }
      }
      return null;
    },
    /**
     * 本地预过滤。职位名/工作地这类语义筛选已经交给 AI 判定，
     * 这里只保留不需要花 token 就能判定的规则。
     */
    filterJobCards(cards) {
      if (!settings.excludeHeadhunters) return (cards || []).filter(Boolean);
      return (cards || []).filter((card) => {
        if (!card) return false;
        const tagEl = card.querySelector(".job-tag-icon");
        const altText = tagEl ? tagEl.alt || "" : "";
        const cardText = card.textContent || "";
        return altText.indexOf("\u730E\u5934") === -1 && cardText.indexOf("\u730E\u5934") === -1;
      });
    },
    /**
     * 找职位卡片自带的「立即沟通」按钮。
     * 直接点卡片上的按钮比"先点卡片、再等详情区刷新"稳定得多，
     * 也是真人最常用的操作路径。
     */
    getCardChatButton(card) {
      if (!card) return null;
      const selectors = [
        ".job-card-footer a.op-btn-chat",
        "a.op-btn-chat",
        ".op-btn-chat",
        ".btn-startchat",
        ".job-card-footer .btn",
        ".start-chat-btn"
      ];
      for (const sel of selectors) {
        const el = card.querySelector(sel);
        if (el) return el;
      }
      return null;
    },
    /** 按钮文案归一化 */
    normalizeBtnText(text) {
      return String(text || "").replace(/\s+/g, "").trim();
    },
    isAlreadyGreeted(text) {
      const t = this.normalizeBtnText(text);
      return t.indexOf("\u7EE7\u7EED\u6C9F\u901A") !== -1 || t.indexOf("\u7EE7\u7EED\u804A") !== -1 || t.indexOf("\u5DF2\u6C9F\u901A") !== -1 || t.indexOf("\u5DF2\u6295\u9012") !== -1;
    },
    isGreetButton(text) {
      const t = this.normalizeBtnText(text);
      return t.indexOf("\u7ACB\u5373\u6C9F\u901A") !== -1 || t === "\u6C9F\u901A" || t.indexOf("\u6253\u62DB\u547C") !== -1;
    },
    /* ---------------- 详情区读取（不依赖具体 class 名） ----------------
     *
     * v2.2.1 修：v2.2.0 用一组写死的 class（.job-detail-box / .job-sec-text …）定位详情区，
     * 线上这些名字全部落空 —— 每个岗位都抓不到「岗位要求」，AI 只能回一句"信息不足"，
     * 48 个岗位全军覆没。所以现在：
     *   1) 优先用 detail.json 的接口返回（见 03-infra.js，字段名变了也能兜住）
     *   2) DOM 侧三级定位：语义锚点 → 已知 class → 视口右半屏
     */
    /** 历史遗留的详情区 class，只是候选之一 */
    DETAIL_SCOPES: [
      ".job-detail-op",
      ".job-detail-box",
      ".job-detail-section",
      ".job-detail-container",
      ".detail-content",
      "#job-detail"
    ],
    /** 详情区里「岗位要求」正文的候选 class */
    DESC_SELECTORS: [
      ".job-sec-text",
      ".job-detail-section .text",
      ".job-detail-box .text",
      "[class*='sec-text']",
      "[class*='job-desc'] p",
      ".text"
    ],
    /** 「岗位要求」小节的标题文案，认不出 class 时靠它定位 */
    DESC_TITLES: [
      "\u804C\u4F4D\u63CF\u8FF0",
      "\u5C97\u4F4D\u63CF\u8FF0",
      "\u804C\u4F4D\u8981\u6C42",
      "\u5C97\u4F4D\u8981\u6C42",
      "\u4EFB\u804C\u8981\u6C42",
      "\u5C97\u4F4D\u804C\u8D23",
      "\u5DE5\u4F5C\u804C\u8D23",
      "\u804C\u4F4D\u8BE6\u60C5",
      "\u5C97\u4F4D\u5185\u5BB9"
    ],
    /** 这个节点是不是左侧职位卡片区域 */
    isJobCardArea(el) {
      if (!el || !el.closest) return false;
      try {
        if (el.closest("li.job-card-box, .job-card-wrapper")) return true;
        return el.querySelectorAll("li.job-card-box, .job-card-wrapper").length > 1;
      } catch (e) {
        return false;
      }
    },
    /** 是不是我们自己的 UI —— 面板是 fixed 贴在右侧的，取点时会挡到 */
    isOwnElement(el) {
      if (!el || !el.closest) return false;
      try {
        return !!el.closest(
          "#boss-pro-panel, #boss-settings-dialog, #boss-mini-icon, #guide-overlay, #guide-tooltip"
        );
      } catch (e) {
        return false;
      }
    },
    /** 在容器里找「岗位要求」正文 */
    pickDescElement(root) {
      if (!root) return null;
      for (const sel of this.DESC_SELECTORS) {
        let el = null;
        try {
          el = root.querySelector(sel);
        } catch (e) {
          continue;
        }
        if (el && (el.textContent || "").trim().length > 30) return el;
      }
      return null;
    },
    /** 这个容器里看起来像是有「岗位要求」正文（认得出正文 class，或至少有那个小标题） */
    hasDescriptionText(root) {
      if (this.pickDescElement(root)) return true;
      const text = (root.textContent || "").replace(/\s+/g, "");
      return this.DESC_TITLES.some((title) => text.indexOf(title) !== -1);
    },
    /** 找右侧详情区根节点：已知 class → 语义锚点 → 视口右半屏 */
    findDetailRoot() {
      const cached = this._detailRoot;
      if (cached && document.contains(cached) && !this.isJobCardArea(cached)) return cached;
      const root = this.findDetailByClass() || this.findDetailByAnchor() || this.findDetailByViewport();
      this._detailRoot = root || null;
      return root;
    },
    /** ① 已知 class：必须真的含有「岗位要求」正文，避免命中空壳或左栏 */
    findDetailByClass() {
      for (const scope of this.DETAIL_SCOPES) {
        let nodes = [];
        try {
          nodes = document.querySelectorAll(scope);
        } catch (e) {
          continue;
        }
        for (const el of nodes) {
          if (this.isOwnElement(el) || this.isJobCardArea(el)) continue;
          if (this.hasDescriptionText(el)) return el;
        }
      }
      return null;
    },
    /** ② 语义锚点：找到写着「职位描述」的小标题，取它的父容器（标题 + 正文） */
    findDetailByAnchor() {
      let nodes = [];
      try {
        nodes = document.querySelectorAll("h1, h2, h3, h4, h5, dt, strong, b, span, div, p");
      } catch (e) {
        return null;
      }
      for (const el of nodes) {
        if (el.childElementCount > 3) continue;
        const text = (el.textContent || "").replace(/\s+/g, "");
        if (!text || text.length > 12) continue;
        if (this.DESC_TITLES.indexOf(text) === -1) continue;
        if (this.isOwnElement(el) || this.isJobCardArea(el)) continue;
        const parent = el.parentElement;
        if (!parent || this.isOwnElement(parent) || this.isJobCardArea(parent)) continue;
        if ((parent.textContent || "").trim().length > text.length + 10) return parent;
        const next = el.nextElementSibling;
        if (next && (next.textContent || "").trim().length > 20) return el.parentElement || parent;
      }
      return null;
    },
    /**
     * ③ 视口右半屏：从右侧中部取一个点，往上找到"仍然没越出右栏"的最大容器。
     *
     * 落点会在三种地方失手，每一种都必须挡住，否则会把**整页**当成详情区
     * （被测试抓到过：取到 .page，于是 AI 拿到的是左侧列表的文字）：
     *   a) 我们自己的面板 —— 它就是 fixed 贴在右边的，正好在取点范围内
     *   b) 左侧职位列表
     *   c) 列表下方的页面空白 —— 那里露出来的是最外层容器，一路往上能爬到 .page / body
     */
    findDetailByViewport() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const points = [
        [0.72, 0.45],
        [0.72, 0.65],
        [0.6, 0.5],
        [0.65, 0.6],
        [0.85, 0.45]
      ];
      for (const point of points) {
        let el = null;
        try {
          el = document.elementFromPoint(Math.round(w * point[0]), Math.round(h * point[1]));
        } catch (e) {
        }
        if (!el || this.isOwnElement(el) || this.isJobCardArea(el)) continue;
        if (el.getBoundingClientRect().left < w * 0.35) continue;
        let best = el;
        for (let i = 0; i < 12 && el.parentElement; i++) {
          const parent = el.parentElement;
          if (parent === document.body || parent === document.documentElement) break;
          const rect = parent.getBoundingClientRect();
          if (rect.width < 200) break;
          if (rect.left < w * 0.35) break;
          if (this.isJobCardArea(parent)) break;
          best = parent;
          el = parent;
        }
        if (this.isJobCardArea(best)) continue;
        if ((best.textContent || "").trim().length > 40) return best;
      }
      return null;
    },
    /** 读右侧详情区的当前内容（标题 + 岗位要求） */
    readDetail() {
      const root = this.findDetailRoot();
      if (!root) return { title: "", description: "", root: null };
      let title = "";
      const titleSelectors = [
        ".position-name",
        ".job-name",
        "h1",
        ".job-title",
        "[class*='position-name']"
      ];
      for (const sel of titleSelectors) {
        let el = null;
        try {
          el = root.querySelector(sel);
        } catch (e) {
          continue;
        }
        if (el && (el.textContent || "").trim()) {
          title = el.textContent.trim();
          break;
        }
      }
      const descEl = this.pickDescElement(root);
      let description = descEl ? descEl.textContent.trim() : "";
      if (description.length < 30) description = (root.textContent || "").trim();
      return { title, description: this.cleanDetailText(description), root };
    },
    /** 详情文本清洗 + 限长，避免把整页塞进 prompt */
    cleanDetailText(text) {
      return String(text || "").replace(/[​-‍﻿]/g, "").replace(/[ \t 　]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim().slice(0, 3e3);
    },
    /** 详情区当前内容的指纹（标题 + 正文前 200 字），用来判断它有没有切到新岗位 */
    detailSignature() {
      const d = this.readDetail();
      if (!d.title && !d.description) return "";
      return d.title + "\n" + d.description.slice(0, 200);
    },
    /** 标题宽松比对：卡片上的标题可能被截断或带后缀 */
    sameTitle(a, b) {
      const x = String(a || "").replace(/\s+/g, "");
      const y = String(b || "").replace(/\s+/g, "");
      if (!x || !y) return false;
      return x === y || x.indexOf(y) === 0 || y.indexOf(x) === 0;
    },
    /**
     * 取"本次点击之后"接口返回的职位详情。
     * 标题对不上说明是上一个岗位的残留，宁可不用。
     */
    pickApiDetail(title, since) {
      const d = APIInterceptor.lastJobDetail;
      if (!d) return null;
      if (since && d.at < since) return null;
      if (title && d.title && !this.sameTitle(d.title, title)) return null;
      return d;
    },
    /**
     * 等右侧详情区 / 接口真的切到目标岗位，返回切换来源（"api" / "dom" / null）。
     *
     * 只等 .job-sec-text 出现是不够的：上一个岗位的详情还留在 DOM 里，会立刻命中，
     * 结果 AI 拿着上一个岗位的「岗位要求」判定当前岗位，按钮状态也全是上一个岗位的。
     */
    async waitForJobDetail(title, prevSignature, since, timeout = CONFIG.OPERATION_INTERVAL * 3) {
      const check = /* @__PURE__ */ __name(() => {
        const api = this.pickApiDetail(title, since);
        if (api && api.description) return "api";
        const cur = this.detailSignature();
        if (!cur) return null;
        if (title && this.sameTitle(cur.split("\n")[0], title)) return "dom";
        if (cur !== prevSignature) return "dom";
        return null;
      }, "check");
      let ready = check();
      if (ready) return ready;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        await this.delay(150);
        ready = check();
        if (ready) return ready;
      }
      return null;
    },
    /**
     * 卡片自带的沟通按钮是否已变成「继续沟通」。
     * 只认卡片上的按钮 —— 详情区的按钮属于"当前打开的那个岗位"，
     * 新岗位的详情渲染出来之前它还是上一个岗位的，拿它判断会把新岗位误判成"已沟通过"。
     */
    isCardAlreadyGreeted(card) {
      const btn = this.getCardChatButton(card);
      return !!(btn && this.isAlreadyGreeted(btn.textContent));
    },
    /**
     * 处理单个职位：打开详情 → 本地免费过滤 → AI 判定 → 投递。
     *
     * 判定需要「岗位要求」文本，而它只在右侧详情区里，所以每个岗位都得先点开卡片。
     * 把不花钱的检查（已沟通过、招聘者不活跃）放在 AI 调用之前，能省掉大量无谓的 token。
     */
    async processOneJob(card, index, total) {
      if (!card) return false;
      const jobId = this.getCardJobId(card);
      const titleEl = card.querySelector(".job-name");
      const title = titleEl ? titleEl.textContent.trim() : "\u672A\u77E5\u804C\u4F4D";
      const label = `[${index + 1}/${total}] ${title}`;
      let liveCard = jobId ? this.findCardById(jobId) : card;
      if (!liveCard) liveCard = card;
      const prevDetail = this.detailSignature();
      const since = Date.now();
      liveCard.scrollIntoView({ behavior: "smooth", block: "center" });
      await this.delay(300);
      this.simulateClickSync(liveCard);
      const syncSource = await this.waitForJobDetail(title, prevDetail, since);
      await this.delay(CONFIG.DELAYS.MEDIUM_SHORT);
      if (this.isCardAlreadyGreeted(liveCard)) {
        state.stats.skipped++;
        refreshStatsUI();
        this.log(`${label} \u5DF2\u6C9F\u901A\u8FC7\uFF0C\u8DF3\u8FC7`);
        return false;
      }
      const activeTime = this.getRecruiterActiveTime();
      const filter = Array.isArray(settings.recruiterActivityStatus) ? settings.recruiterActivityStatus : [];
      const hasStatusFilter = filter.length > 0 && !filter.includes("\u4E0D\u9650");
      if (hasStatusFilter && !filter.includes(activeTime)) {
        state.stats.skipped++;
        refreshStatsUI();
        this.log(`${label} \u8DF3\u8FC7\uFF1A\u62DB\u8058\u8005\u72B6\u6001\u300C${activeTime}\u300D\u4E0D\u5728\u7B5B\u9009\u8303\u56F4\u5185`);
        return false;
      }
      const jobInfo = this.extractJobDetail(title, since, syncSource);
      jobInfo.title = jobInfo.title || title;
      state.currentJobTitle = jobInfo.title;
      if (!jobInfo.description || jobInfo.description.length < 20) {
        state.stats.failed++;
        refreshStatsUI();
        this.log(`${label} \u26A0\uFE0F \u6CA1\u6293\u5230\u5C97\u4F4D\u8981\u6C42\uFF0C\u8DF3\u8FC7\u4EE5\u514D\u8BEF\u5224`);
        this.logDetailDiagnostic();
        return false;
      }
      const verdict = await this.judgeJob(jobInfo);
      if (!verdict.match) {
        state.stats.skipped++;
        refreshStatsUI();
        this.log(`${label} \u274C \u8DF3\u8FC7\uFF1A${verdict.reason}`);
        return false;
      }
      this.log(`${label} \u2705 \u901A\u8FC7\uFF1A${verdict.reason}`);
      let chatBtn = this.getCardChatButton(liveCard);
      if (!chatBtn || !this.isGreetButton(chatBtn.textContent)) {
        const detailBtn = this.findChatButton();
        if (detailBtn && this.isGreetButton(detailBtn.textContent)) chatBtn = detailBtn;
      }
      if (!chatBtn) {
        state.stats.failed++;
        refreshStatsUI();
        this.log(`${label} \u672A\u627E\u5230\u300C\u7ACB\u5373\u6C9F\u901A\u300D\u6309\u94AE\uFF0C\u53EF\u80FD\u9875\u9762\u7ED3\u6784\u5DF2\u53D8\u5316`);
        return false;
      }
      if (!this.isGreetButton(chatBtn.textContent)) {
        state.stats.skipped++;
        refreshStatsUI();
        this.log(`${label} \u6309\u94AE\u6587\u6848\u4E3A\u300C${this.normalizeBtnText(chatBtn.textContent)}\u300D\uFF0C\u8DF3\u8FC7`);
        return false;
      }
      const ok = await this.applyToJob(liveCard, chatBtn, label);
      if (ok) {
        state.stats.greeted++;
        refreshStatsUI();
        if (jobId) {
          try {
            StorageManager.addRecordWithLimit(
              CONFIG.STORAGE_KEYS.PROCESSED_HRS,
              jobId,
              state.hrInteractions.processedHRs,
              CONFIG.STORAGE_LIMITS.PROCESSED_HRS
            );
          } catch (e) {
          }
        }
      } else {
        state.stats.failed++;
        refreshStatsUI();
      }
      return ok;
    },
    /**
     * 真正执行一次投递，并校验结果。
     * 返回 true 表示这次沟通确实生效。
     */
    async applyToJob(card, chatBtn, label) {
      const beforeText = (chatBtn.textContent || "").replace(/\s+/g, "");
      if (settings.useApiApply) {
        const info = this.extractJobInfo(card);
        let sec = APIInterceptor.getCurrentSecurityId();
        if (!sec && info && info.securityId) {
          sec = { securityId: info.securityId, lid: info.lid, jobId: info.jobId };
        }
        if (sec && sec.securityId) {
          try {
            await this.sendFriendRequest(
              sec.jobId || info && info.jobId || "",
              sec.securityId,
              sec.lid || ""
            );
            this.log(`${label} \u5DF2\u901A\u8FC7\u7AD9\u5185\u63A5\u53E3\u53D1\u8D77\u6C9F\u901A`);
            return true;
          } catch (e) {
            this.log(`${label} \u63A5\u53E3\u65B9\u5F0F\u5931\u8D25\uFF08${e.message}\uFF09\uFF0C\u56DE\u9000\u5230\u6A21\u62DF\u70B9\u51FB`);
          }
        }
      }
      await this.simulateClick(chatBtn);
      const result = await this.waitApplyResult(beforeText, chatBtn);
      if (!result.ok) {
        this.log(`${label} \u6C9F\u901A\u7ED3\u679C\u672A\u77E5\uFF1A\u6CA1\u6709\u68C0\u6D4B\u5230\u6210\u529F\u63D0\u793A\uFF0C\u4E5F\u672A\u770B\u5230\u6309\u94AE\u53D8\u5316`);
        return false;
      }
      await this.closeGreetingModal();
      return true;
    },
    /** 等待投递结果：按钮文案变化 / 弹窗 / 出现聊天输入框 / toast 提示 */
    async waitApplyResult(beforeText, clickedBtn, timeout = 8e3) {
      const start2 = Date.now();
      const before = this.normalizeBtnText(beforeText);
      while (Date.now() - start2 < timeout) {
        if (clickedBtn && clickedBtn.isConnected) {
          const now = this.normalizeBtnText(clickedBtn.textContent);
          if (now && now !== before) return { ok: true, reason: "button-changed" };
        }
        const modal = document.querySelector(
          '.greet-boss-dialog, .dialog-container, .dialog-wrap, [class*="greet"][class*="dialog"]'
        );
        if (modal) return { ok: true, reason: "modal" };
        if (document.querySelector(
          "#chat-input, .chat-input, .input-area textarea, .chat-input-box textarea"
        )) {
          return { ok: true, reason: "chat-opened" };
        }
        const toast = document.querySelector(".toast, .message-tip, .ui-tip, [class*='toast']");
        if (toast && /成功|已发送|已投递|已沟通|打招呼|发送成功/.test(toast.textContent || "")) {
          return { ok: true, reason: "toast" };
        }
        await this.delay(200);
      }
      return { ok: false };
    },
    /**
     * 关闭打招呼弹窗并留在当前列表页（点「去沟通」会跳走并中断批量）。
     *
     * 必须"等一会儿再找"：弹窗是点击「立即沟通」之后才由 BOSS 渲染出来的，
     * 而 waitApplyResult() 经常在按钮文案一变（早于弹窗出现）时就返回了。
     * 以前这段空隙是 1200ms 的招呼语发送白等出来的，那部分逻辑已删除，
     * 所以这里改成在 OPERATION_INTERVAL 内轮询：弹窗一出现就点，始终不出现也不多等。
     * 最长耗时与改动前一致（600 + 1200），但常见情况下不必再傻等到最后一刻。
     */
    async closeGreetingModal() {
      const findStayBtn = /* @__PURE__ */ __name(() => Array.from(
        document.querySelectorAll(
          ".default-btn.cancel-btn, .dialog-container button, .greet-boss-dialog button, .dialog-wrap button"
        )
      ).find((b) => {
        const t = (b.textContent || "").replace(/\s+/g, "");
        return t === "\u7559\u5728\u6B64\u9875" || t === "\u53D6\u6D88" || t === "\u7A0D\u540E" || t === "\u5173\u95ED" || t === "\u77E5\u9053\u4E86";
      }), "findStayBtn");
      try {
        await this.delay(600);
        const stay = await this.waitForElement(findStayBtn, CONFIG.OPERATION_INTERVAL);
        if (!stay) return;
        await this.simulateClick(stay);
        await this.delay(400);
      } catch (e) {
      }
    },
    /** 同步版点击（用于点卡片，不必模拟完整鼠标序列） */
    simulateClickSync(element) {
      if (!element) return;
      try {
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      } catch (e) {
        try {
          element.click();
        } catch (e2) {
        }
      }
    },
    async handleChatPage() {
      const latestChatLi = await this.waitForElement(this.getLatestChatLi);
      if (!latestChatLi) return;
      const nameEl = latestChatLi.querySelector(".name-text");
      const companyEl = latestChatLi.querySelector(".name-box span:nth-child(2)");
      const name = (nameEl?.textContent || "\u672A\u77E5").trim();
      const company = (companyEl?.textContent || "").trim();
      const hrKey = `${name}-${company}`.toLowerCase();
      if (this.currentMonitoredHR === hrKey && this.messageObserver) {
        return;
      }
      this.currentMonitoredHR = hrKey;
      this.resetMessageState();
      if (this.messageObserver) {
        this.messageObserver.disconnect();
        this.messageObserver = null;
      }
      if (!latestChatLi.classList.contains("last-clicked")) {
        await this.simulateClick(latestChatLi.querySelector(".figure"));
        latestChatLi.classList.add("last-clicked");
        await this.delay(CONFIG.OPERATION_INTERVAL);
        DOMCache.clear();
        await HRInteractionManager.handleHRInteraction(hrKey);
      }
      await this.setupMessageObserver(hrKey);
    },
    /* =====================================================================
     * 自动轮询：扫描会话列表（chatStore），而不是只盯顶部一条
     *
     * 实机探测（zhipin-chat-probe.md）结论：
     *   - 会话列表 DOM 没有稳定 id；
     *   - window.chatStore.friendInfos 有 uid / encryptBossId / lastTS 等字段；
     *   - 一次运行按列表顺序从第一条到底部逐条打开，每条只走一次，到尾部停止；
     *   - 点开会话会标已读。
     * ===================================================================== */
    /** Tampermonkey 沙箱里 window 是包装对象，页面全局变量必须走 unsafeWindow */
    getPageWindow() {
      try {
        if (typeof unsafeWindow !== "undefined" && unsafeWindow) return unsafeWindow;
      } catch (e) {
      }
      return document.defaultView || window;
    },
    getChatStore() {
      try {
        const w = this.getPageWindow();
        const store = w && w.chatStore;
        if (!store || !store.friendInfos || typeof store.friendInfos !== "object") return null;
        return store;
      } catch (e) {
        return null;
      }
    },
    /** 稳定会话键；uid=0 是系统/群引导行，不处理 */
    conversationKey(info) {
      if (!info) return "";
      const uid = info.uid;
      if (uid !== void 0 && uid !== null && String(uid) !== "") {
        return String(uid) === "0" ? "" : `uid:${uid}`;
      }
      if (info.encryptBossId) return `boss:${info.encryptBossId}`;
      return this.legacyHrKeyFromInfo(info);
    },
    /** 旧账本键，仅用于兼容与日志 */
    legacyHrKeyFromInfo(info) {
      if (!info) return "";
      const name = info.name || "\u672A\u77E5";
      const company = info.brandName || info.company || "";
      return `${name}-${company}`.toLowerCase();
    },
    chatDisplayName(info) {
      if (!info) return "\u672A\u77E5";
      const name = info.name || "\u672A\u77E5";
      const company = info.brandName || info.company || "";
      return company ? `${name} / ${company}` : name;
    },
    toConversationTarget(info) {
      return {
        uid: info.uid,
        encryptBossId: info.encryptBossId,
        name: info.name || "\u672A\u77E5",
        company: info.brandName || info.company || "",
        ledgerKey: this.conversationKey(info),
        legacyKey: this.legacyHrKeyFromInfo(info)
      };
    },
    getFriendInfoByUid(uid) {
      const store = this.getChatStore();
      if (!store || !store.friendInfos || uid === void 0 || uid === null) return null;
      const direct = store.friendInfos[`${uid}-0`];
      if (direct) return direct;
      return Object.values(store.friendInfos).find((f) => f && String(f.uid) === String(uid)) || null;
    },
    resetChatScan() {
      this.chatScan = null;
    },
    getChatScan() {
      if (!this.chatScan) {
        this.chatScan = {
          startedAt: 0,
          order: [],
          index: 0,
          processed: 0,
          done: false
        };
      }
      return this.chatScan;
    },
    /**
     * 建立这一轮的全量遍历顺序：从会话列表顶部到底部，每条只走一次。
     *
     * chatStore.friends 的顺序与左侧列表一致时优先用它；缺失或不全时，
     * 按 lastTS 倒序补上。遍历开始后新出现的会话不会插队 —— 这一轮只走快照。
     */
    initChatScan(store) {
      const scan = this.getChatScan();
      scan.startedAt = Date.now();
      scan.index = 0;
      scan.processed = 0;
      scan.done = false;
      const infos = Object.values(store.friendInfos || {}).filter(
        (f) => f && this.conversationKey(f)
      );
      const byUid = new Map(infos.map((f) => [String(f.uid), f]));
      const friends = Array.isArray(store.friends) ? store.friends : [];
      const order = [];
      const seen = /* @__PURE__ */ new Set();
      const push = /* @__PURE__ */ __name((info) => {
        const key = this.conversationKey(info);
        if (!key || seen.has(key)) return;
        seen.add(key);
        order.push({
          key,
          uid: info.uid,
          name: info.name || "\u672A\u77E5",
          company: info.brandName || info.company || "",
          info
        });
      }, "push");
      for (const uid of friends) {
        const info = byUid.get(String(uid));
        if (info) push(info);
      }
      infos.slice().sort((a, b) => Number(b.lastTS || 0) - Number(a.lastTS || 0)).forEach(push);
      scan.order = order;
      this.log(`\u81EA\u52A8\u8F6E\u8BE2\uFF1A\u5171 ${order.length} \u4E2A\u4F1A\u8BDD\uFF0C\u4ECE\u5934\u5230\u5C3E\u6253\u5F00\u4E00\u904D`);
    },
    nextSweepTargets(scan) {
      const end = Math.min(scan.index + CONFIG.CHAT.MAX_SWEEP_PER_CALL, scan.order.length);
      const targets = scan.order.slice(scan.index, end);
      scan.index = end;
      return targets;
    },
    /** 走到尾部：这一轮结束，停止聊天；再点开始会从顶部重新遍历 */
    finishChatSweep(scan) {
      if (scan.done) return;
      scan.done = true;
      this.log(`\u81EA\u52A8\u8F6E\u8BE2\u5B8C\u6210\uFF1A\u5DF2\u904D\u5386 ${scan.processed}/${scan.order.length} \u4E2A\u4F1A\u8BDD`);
      if (state.isRunning) {
        toggleChatProcess();
      }
    },
    async handleChatPageAuto() {
      const store = this.getChatStore();
      if (!store || !store.friendInfos) {
        if (!this.chatStoreWarned) {
          this.chatStoreWarned = true;
          this.log("\u672A\u68C0\u6D4B\u5230 chatStore\uFF0C\u81EA\u52A8\u8F6E\u8BE2\u56DE\u9000\u4E3A\u300C\u53EA\u770B\u9876\u90E8\u4F1A\u8BDD\u300D");
        }
        return this.handleChatPage();
      }
      const scan = this.getChatScan();
      if (!scan.startedAt) this.initChatScan(store);
      if (scan.done) return;
      const targets = this.nextSweepTargets(scan);
      if (!targets.length) {
        this.finishChatSweep(scan);
        return;
      }
      for (const target of targets) {
        if (!state.isRunning || settings.communicationMode !== "auto") return;
        await this.processSweepTarget(target, scan);
        await this.delay(CONFIG.CHAT.SWEEP_DELAY);
      }
      if (scan.index >= scan.order.length && state.isRunning) {
        this.finishChatSweep(scan);
      }
    },
    async processSweepTarget(target, scan) {
      const info = this.getFriendInfoByUid(target.uid) || target.info;
      const label = this.chatDisplayName(info);
      const position = scan.processed + 1;
      scan.processed++;
      this.log(`\u81EA\u52A8\u8F6E\u8BE2 [${position}/${scan.order.length}]\uFF1A${label}`);
      try {
        let li = this.findConversationLi(info);
        if (!li) {
          this.scrollChatListToRatio(position - 1, scan.order.length);
          await this.delay(300);
          li = this.findConversationLi(info);
        }
        if (!li) {
          this.log(`\u672A\u5728\u4F1A\u8BDD\u5217\u8868\u4E2D\u627E\u5230 ${label}\uFF0C\u8DF3\u8FC7`);
          return;
        }
        const clickTarget = li.querySelector(".friend-content") || li.querySelector(".figure") || li;
        await this.simulateClick(clickTarget);
        let switched = await this.waitForConversationSwitch(info, CONFIG.OPERATION_INTERVAL);
        if (!switched) {
          const figure = li.querySelector(".figure");
          if (figure && figure !== clickTarget) {
            await this.simulateClick(figure);
            switched = await this.waitForConversationSwitch(info, CONFIG.OPERATION_INTERVAL);
          }
        }
        if (!switched) {
          this.log(`\u6253\u5F00\u4F1A\u8BDD\u8D85\u65F6\uFF1A${label}\uFF0C\u7EE7\u7EED\u4E0B\u4E00\u4E2A`);
          return;
        }
        DOMCache.clear();
        await this.delay(CONFIG.DELAYS.MEDIUM_SHORT);
        await HRInteractionManager.handleHRInteraction(this.toConversationTarget(info));
      } catch (e) {
        this.log(`\u81EA\u52A8\u8F6E\u8BE2\u5904\u7406 ${label} \u51FA\u9519\uFF1A${e.message}`);
      }
    },
    /** 虚拟列表兜底：按当前进度把会话列表滚到大致位置 */
    scrollChatListToRatio(index, total) {
      try {
        const el = document.querySelector(".user-list-content");
        if (!el) return;
        const max = el.scrollHeight - el.clientHeight;
        if (max <= 0) return;
        el.scrollTop = Math.floor(index / Math.max(total, 1) * max);
      } catch (e) {
      }
    },
    findConversationLi(info) {
      const items = Array.from(
        document.querySelectorAll('.user-list-content ul[role="group"] li[role="listitem"]')
      );
      if (!items.length) return null;
      try {
        const store = this.getChatStore();
        const friends = store && Array.isArray(store.friends) ? store.friends : [];
        const index = friends.findIndex((uid) => String(uid) === String(info.uid));
        if (index >= 0 && items[index] && this.liMatchesInfo(items[index], info)) {
          return items[index];
        }
      } catch (e) {
      }
      for (const li of items) {
        if (this.liMatchesInfo(li, info)) return li;
      }
      return null;
    },
    liMatchesInfo(li, info) {
      if (!li || !info) return false;
      const name = (li.querySelector(".name-text")?.textContent || "").trim();
      const company = (li.querySelector(".name-box span:nth-child(2)")?.textContent || "").trim();
      const targetName = String(info.name || "").trim();
      const targetCompany = String(info.brandName || info.company || "").trim();
      if (!targetName) return false;
      if (name !== targetName) return false;
      if (targetCompany && company !== targetCompany) return false;
      return true;
    },
    /**
     * 等会话真的切换过去。
     * 探测报告：点击后约 200ms，.friend-content.selected 切换、.position-name 出现，
     * 并且 .chat-message 被整体替换。
     *
     * 注意不能强制要求“容器被替换”：启动时顶部会话可能本来就处于选中/打开状态，
     * 再点它不一定触发重渲染。此时只要选中项对得上、且有岗位名或消息，就可以采信；
     * 否则会误判超时，启动时的顶部会话永远不会被处理。
     */
    async waitForConversationSwitch(info, timeout = CONFIG.OPERATION_INTERVAL * 2) {
      const targetName = String(info.name || "").trim();
      const check = /* @__PURE__ */ __name(() => {
        const selected = document.querySelector(".user-list-content .friend-content.selected");
        if (!selected) return false;
        const selectedName = (selected.querySelector(".name-text")?.textContent || "").trim();
        if (targetName && selectedName !== targetName) return false;
        const chat = document.querySelector(".chat-message");
        if (!chat) return false;
        const position = (document.querySelector(".position-name")?.textContent || "").trim();
        const hasMessage = !!chat.querySelector(".im-list li[data-mid]");
        return !!(position || hasMessage);
      }, "check");
      if (check()) return true;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        await this.delay(100);
        if (check()) return true;
      }
      return false;
    },
    resetMessageState() {
      this.lastProcessedMessage = null;
      this.processingMessage = false;
    },
    async setupMessageObserver(hrKey) {
      const chatContainer = await this.waitForElement(".chat-message .im-list");
      if (!chatContainer) return;
      this.messageObserver = new MutationObserver(async (mutations) => {
        let hasNewFriendMessage = false;
        for (const mutation of mutations) {
          if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
            hasNewFriendMessage = Array.from(mutation.addedNodes).some(
              (node) => node.classList?.contains("item-friend")
            );
            if (hasNewFriendMessage) break;
          }
        }
        if (hasNewFriendMessage) {
          await this.handleNewMessage(hrKey);
        }
      });
      this.messageObserver.observe(chatContainer, {
        childList: true,
        subtree: true
      });
    },
    async handleNewMessage(hrKey) {
      if (!state.isRunning) return;
      if (this.processingMessage) return;
      this.processingMessage = true;
      try {
        await this.delay(CONFIG.OPERATION_INTERVAL);
        const lastMessage = await this.getLastFriendMessageText();
        if (!lastMessage) return;
        const cleanedMessage = this.cleanMessage(lastMessage);
        const shouldSendResumeOnly = cleanedMessage.includes("\u7B80\u5386");
        if (cleanedMessage === this.lastProcessedMessage) return;
        this.lastProcessedMessage = cleanedMessage;
        this.log(`\u6536\u5230 HR \u6D88\u606F\uFF1A${lastMessage}`);
        await this.delay(CONFIG.DELAYS.MEDIUM_SHORT);
        const updatedMessage = await this.getLastFriendMessageText();
        if (updatedMessage && this.cleanMessage(updatedMessage) !== cleanedMessage) {
          await this.handleNewMessage(hrKey);
          return;
        }
        const autoSendResume = settings.useAutoSendResume;
        if (shouldSendResumeOnly && autoSendResume) {
          this.log('\u5BF9\u65B9\u63D0\u5230"\u7B80\u5386"\uFF0C\u6B63\u5728\u53D1\u9001\u7B80\u5386');
          const sent = await HRInteractionManager.sendResume();
          if (sent) {
            StorageManager.addRecordWithLimit(
              CONFIG.STORAGE_KEYS.SENT_RESUME_HRS,
              hrKey,
              state.hrInteractions.sentResumeHRs,
              CONFIG.STORAGE_LIMITS.SENT_RESUME_HRS
            );
            this.log(`\u5DF2\u5411 ${hrKey} \u53D1\u9001\u7B80\u5386`);
          }
        } else {
          await HRInteractionManager.handleHRInteraction(hrKey);
        }
        await this.delay(CONFIG.DELAYS.MEDIUM_SHORT);
      } catch (error) {
        this.log(`\u5904\u7406\u6D88\u606F\u51FA\u9519: ${error.message}`);
      } finally {
        this.processingMessage = false;
      }
    },
    cleanMessage(message) {
      if (!message) return "";
      let clean = message.replace(/<[^>]*>/g, "");
      clean = clean.trim().replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "");
      return clean;
    },
    getLatestChatLi() {
      return document.querySelector(
        'ul[role="group"] li[role="listitem"][class]:has(.friend-content-warp)'
      );
    },
    /** 详情区里的技能标签（BOSS 各版本 class 名不一，命中不到就算了） */
    readSkillTags() {
      try {
        const tags = document.querySelectorAll(
          ".job-tag-box .tag-item, .job-tags .tag-item, .job-keyword-list .tag-item"
        );
        return tags.length ? Array.from(tags).map((x) => x.textContent.trim()).filter(Boolean).join("\u3001") : "";
      } catch (e) {
        return "";
      }
    },
    /**
     * 抓取当前岗位的职位信息（标题 / 岗位要求 / 技能标签）。
     *
     * 优先用 detail.json 的接口返回 —— 它最全，也不会随 BOSS 改版失效；
     * 接口没给才退回 DOM，而且只在 waitForJobDetail 确认详情区**已经切到目标岗位**时才采信，
     * 否则读到的是上一个岗位的内容（"串岗"）。
     * 标题一律用卡片上的标题兜底：直接查 .job-name 会命中左侧列表的第一张卡片。
     */
    extractJobDetail(title, since, syncSource) {
      const api = this.pickApiDetail(title, since);
      let description = "";
      let source = "";
      let domTitle = "";
      if (api && api.description) {
        description = api.description;
        source = "\u63A5\u53E3";
      } else if (syncSource === "dom") {
        const dom = this.readDetail();
        domTitle = dom.title;
        if (dom.description) {
          description = dom.description;
          source = "\u8BE6\u60C5\u533A";
        }
        const skills = this.readSkillTags();
        if (skills) description = [description, "\u6280\u80FD\uFF1A" + skills].filter(Boolean).join("\n");
      }
      return {
        title: api && api.title || domTitle || title || state.currentJobTitle || "",
        description: this.cleanDetailText(description),
        source
      };
    },
    /** 抓不到岗位要求时，把"到底看到了什么"写进日志，便于反馈是接口还是 DOM 的问题 */
    logDetailDiagnostic() {
      try {
        const api = APIInterceptor.lastJobDetail;
        const apiInfo = api ? `\u63A5\u53E3\u6700\u540E\u8FD4\u56DE\u300C${api.title || "?"}\u300D\uFF08\u63CF\u8FF0 ${(api.description || "").length} \u5B57\uFF09` : "\u6CA1\u6536\u5230 detail.json \u7684\u54CD\u5E94";
        const root = this.findDetailRoot();
        let rootInfo = "\u6CA1\u5B9A\u4F4D\u5230\u53F3\u4FA7\u8BE6\u60C5\u533A";
        if (root) {
          const cls = String(root.className || "").split(" ").filter(Boolean)[0];
          rootInfo = `\u8BE6\u60C5\u533A\u6839\u8282\u70B9 ${root.tagName.toLowerCase()}${cls ? "." + cls : ""}\uFF08\u6B63\u6587 ${(root.textContent || "").trim().length} \u5B57\uFF09`;
        }
        this.log(`\u3000\u8BCA\u65AD\uFF1A${apiInfo}\uFF1B${rootInfo}`);
        console.warn("[BOSS\u6295\u9012\u52A9\u624B] \u5C97\u4F4D\u8981\u6C42\u6293\u53D6\u8BCA\u65AD", { api, root });
      } catch (e) {
      }
    },
    /**
     * 从模型返回里抠出判定结果。兼容 ```json 包裹、以及前后夹带解释文字的情况。
     * 任何一步失败都返回 match:false —— 判不出来就不投，避免误投。
     */
    parseAiVerdict(text) {
      const fail = /* @__PURE__ */ __name((reason2) => ({ match: false, reason: reason2 }), "fail");
      if (!text || !String(text).trim()) return fail("AI \u672A\u8FD4\u56DE\u5185\u5BB9");
      const raw = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      const start2 = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start2 === -1 || end <= start2) return fail("AI \u672A\u8FD4\u56DE JSON");
      let obj;
      try {
        obj = JSON.parse(raw.slice(start2, end + 1));
      } catch (e) {
        return fail("AI \u8FD4\u56DE\u7684 JSON \u65E0\u6CD5\u89E3\u6790");
      }
      const match = obj.match === true || obj.match === "true";
      const reason = String(obj.reason || "").trim() || (match ? "\u7B26\u5408\u6295\u9012\u8981\u6C42" : "\u4E0D\u7B26\u5408\u6295\u9012\u8981\u6C42");
      return { match, reason };
    },
    /**
     * 一次 LLM 调用完成「是否投递」的判定。
     * 请求失败一律返回 match:false，由调用方记为跳过。
     */
    async judgeJob(jobInfo) {
      const { text: prompt } = renderPrompt(settings.promptTemplate || PROMPT_TEMPLATE_DEFAULT, {
        jobTitle: jobInfo.title || "",
        jobDescription: jobInfo.description || ""
      });
      try {
        const txt = await this.requestAi(prompt, AI_JUDGE_SYSTEM_ROLE, {
          temperature: 0.3,
          maxTokens: 800,
          label: `\u5224\u5B9A\u300C${jobInfo.title || "\u672A\u77E5\u804C\u4F4D"}\u300D`
        });
        return this.parseAiVerdict(txt);
      } catch (e) {
        return { match: false, reason: `AI \u5224\u5B9A\u5931\u8D25\uFF08${e.message}\uFF09` };
      }
    },
    getPositionName() {
      try {
        const positionNameElement = Core.getCachedElement(".position-name", true) || Core.getCachedElement(".job-name", true) || Core.getCachedElement('[class*="position-content"] .left-content .position-name', true) || document.querySelector(".position-name") || document.querySelector(".job-name");
        if (positionNameElement) {
          return positionNameElement.textContent.trim();
        } else {
          return "";
        }
      } catch (e) {
        Core.log(`\u83B7\u53D6\u5C97\u4F4D\u540D\u79F0\u51FA\u9519: ${e.message}`);
        return "";
      }
    },
    /**
     * 调用兼容 OpenAI 协议的对话接口。
     * v2.1.0 修复：
     *   - 旧版 system 提示词写成 localStorage.getItem("aiRole") || systemRole || ...，
     *     导致传入的 systemRole 永远被覆盖，生成招呼语时用的是"聊天回复"的角色设定；
     *   - 增加超时、失败重试与可读的错误信息（401/402/429 等）。
     */
    async requestAi(message, systemRole, options) {
      const opts = options || {};
      const retries = opts.retries === void 0 ? CONFIG.API.RETRY_COUNT : opts.retries;
      const authToken = settings.aiApiKey || "";
      const apiUrl = settings.aiApiUrl || "https://api.deepseek.com/v1/chat/completions";
      if (!apiUrl) throw new Error("\u672A\u914D\u7F6E API \u5730\u5740");
      const systemContent = systemRole || "\u4F60\u662F\u4E00\u4E2A\u4E50\u4E8E\u52A9\u4EBA\u7684\u52A9\u624B\u3002";
      const requestBody = {
        model: settings.aiModel || "deepseek-chat",
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: message }
        ],
        // 判定场景要的是稳定可解析的 JSON，所以允许调用方压低温度、抬高 token 上限
        temperature: opts.temperature === void 0 ? 0.9 : opts.temperature,
        top_p: 0.8,
        max_tokens: opts.maxTokens || 512,
        stream: false
      };
      let lastError = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
          this.log(`AI \u8BF7\u6C42\u5931\u8D25\uFF0C${CONFIG.API.RETRY_DELAY}ms \u540E\u91CD\u8BD5\uFF08${attempt}/${retries}\uFF09`);
          await this.delay(CONFIG.API.RETRY_DELAY);
        }
        try {
          const text = await this._doRequest(apiUrl, authToken, requestBody);
          if (text) return text;
        } catch (e) {
          lastError = e;
          if (/401|403|402|余额|额度|无效|Unauthorized/i.test(e.message)) break;
        }
      }
      throw lastError || new Error("AI \u8BF7\u6C42\u5931\u8D25");
    },
    _doRequest(apiUrl, authToken, requestBody) {
      return new Promise((resolve, reject) => {
        const finish = /* @__PURE__ */ __name((fn, arg) => {
          try {
            fn(arg);
          } catch (e) {
            console.error(e);
          }
        }, "finish");
        if (typeof GM_xmlhttpRequest !== "function") {
          return reject(new Error("\u5F53\u524D\u811A\u672C\u7BA1\u7406\u5668\u672A\u6388\u4E88\u8DE8\u57DF\u8BF7\u6C42\u6743\u9650\uFF08GM_xmlhttpRequest\uFF09"));
        }
        GM_xmlhttpRequest({
          method: "POST",
          url: apiUrl,
          timeout: CONFIG.API.TIMEOUT,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + (authToken || "")
          },
          data: JSON.stringify(requestBody),
          onload: /* @__PURE__ */ __name((response) => {
            const status = response.status;
            const body = response.responseText || "";
            let result = null;
            try {
              result = JSON.parse(body);
            } catch (e) {
              return finish(
                reject,
                new Error(`\u63A5\u53E3\u8FD4\u56DE\u4E86\u975E JSON \u5185\u5BB9\uFF08HTTP ${status}\uFF09\uFF1A${body.slice(0, 120)}`)
              );
            }
            const choice = result && result.choices && result.choices[0] || result.data && result.data.choices && result.data.choices[0];
            if (choice && choice.message && choice.message.content) {
              return finish(resolve, String(choice.message.content).trim());
            }
            if (status < 200 || status >= 300) {
              const msg = result && (result.error?.message || result.message) || `HTTP ${status}`;
              return finish(reject, new Error(msg));
            }
            if (result && result.code !== void 0 && result.code !== 0) {
              return finish(
                reject,
                new Error(`${result.message || "\u63A5\u53E3\u8FD4\u56DE\u9519\u8BEF"}\uFF08code: ${result.code}\uFF09`)
              );
            }
            return finish(reject, new Error("\u65E0\u6CD5\u8BC6\u522B\u7684\u63A5\u53E3\u8FD4\u56DE\u683C\u5F0F\uFF1A" + body.slice(0, 160)));
          }, "onload"),
          onerror: /* @__PURE__ */ __name(() => finish(reject, new Error("\u7F51\u7EDC\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 API \u5730\u5740\u4E0E\u7F51\u7EDC")), "onerror"),
          ontimeout: /* @__PURE__ */ __name(() => finish(reject, new Error(`\u8BF7\u6C42\u8D85\u65F6\uFF08${CONFIG.API.TIMEOUT / 1e3}s\uFF09`)), "ontimeout")
        });
      });
    },
    async getLastFriendMessageText() {
      try {
        const chatContainer = DOMCache.get(".chat-message .im-list");
        if (!chatContainer) return null;
        const friendMessages = Array.from(
          chatContainer.querySelectorAll("li.message-item.item-friend")
        );
        if (friendMessages.length === 0) return null;
        const lastMessageEl = friendMessages[friendMessages.length - 1];
        const textEl = lastMessageEl.querySelector(".text-content") || lastMessageEl.querySelector(".text span");
        return textEl?.textContent?.trim() || null;
      } catch (error) {
        ErrorHandler.handle(error, "Core.getLastFriendMessageText");
        this.log(`\u83B7\u53D6\u6D88\u606F\u51FA\u9519: ${error.message}`);
        return null;
      }
    },
    /** 当前会话里最后一条我方消息的文本；用于核对「网页已发出的打招呼语」 */
    async getLastSelfMessageText() {
      try {
        const chatContainer = DOMCache.get(".chat-message .im-list");
        if (!chatContainer) return null;
        const selfMessages = Array.from(
          chatContainer.querySelectorAll("li.message-item.item-myself")
        );
        if (selfMessages.length === 0) return null;
        const lastMessageEl = selfMessages[selfMessages.length - 1];
        const textEl = lastMessageEl.querySelector(".text-content") || lastMessageEl.querySelector(".text span");
        return textEl?.textContent?.trim() || null;
      } catch (error) {
        ErrorHandler.handle(error, "Core.getLastSelfMessageText");
        this.log(`\u83B7\u53D6\u6211\u65B9\u6D88\u606F\u51FA\u9519: ${error.message}`);
        return null;
      }
    },
    async simulateClick(element) {
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const dispatchMouseEvent = /* @__PURE__ */ __name((type, options = {}) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: document.defaultView,
          clientX: x,
          clientY: y,
          ...options
        });
        element.dispatchEvent(event);
      }, "dispatchMouseEvent");
      dispatchMouseEvent("mouseover");
      await this.delay(CONFIG.DELAYS.SHORT);
      dispatchMouseEvent("mousemove");
      await this.delay(CONFIG.DELAYS.SHORT);
      dispatchMouseEvent("mousedown", { button: 0 });
      await this.delay(CONFIG.DELAYS.SHORT);
      dispatchMouseEvent("mouseup", { button: 0 });
      await this.delay(CONFIG.DELAYS.SHORT);
      dispatchMouseEvent("click", { button: 0 });
    },
    async waitForElement(selectorOrFunction, timeout = 5e3) {
      return new Promise((resolve) => {
        let element;
        if (typeof selectorOrFunction === "function") element = selectorOrFunction();
        else element = document.querySelector(selectorOrFunction);
        if (element) return resolve(element);
        const timeoutId = setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, timeout);
        const observer = new MutationObserver(() => {
          if (typeof selectorOrFunction === "function") element = selectorOrFunction();
          else element = document.querySelector(selectorOrFunction);
          if (element) {
            clearTimeout(timeoutId);
            observer.disconnect();
            resolve(element);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
    },
    getContextMultiplier(context) {
      const multipliers = {
        dict_load: 1,
        click: 0.8,
        selection: 0.8,
        default: 1
      };
      return multipliers[context] || multipliers["default"];
    },
    async smartDelay(baseTime, context = "default") {
      const multiplier = this.getContextMultiplier(context);
      const adjustedTime = baseTime * multiplier;
      return this.delay(adjustedTime);
    },
    async delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    async handleGreetSettingsPage() {
      try {
        localStorage.setItem(STORAGE.VISITED_GREET_SET, "true");
        await this.delay(1e3);
        const titleElement = document.querySelector("h3.title-wrap");
        if (titleElement) {
          titleElement.textContent = "\u8BF7\u52A1\u5FC5\u6253\u5F00 \u6253\u62DB\u547C\u8BED\u529F\u80FD";
          titleElement.style.color = "red";
          titleElement.style.fontWeight = "bold";
          titleElement.style.fontSize = "18px";
        }
        const possibleSelectors = [
          "h4 .ui-switch",
          ".ui-switch",
          "span.ui-switch",
          "[class*='ui-switch']"
        ];
        let switchElement = null;
        for (const selector of possibleSelectors) {
          switchElement = document.querySelector(selector);
          if (switchElement) {
            break;
          }
        }
        if (switchElement) {
          const isChecked = switchElement.classList.contains("ui-switch-checked");
          if (!isChecked) {
            await this.simulateClick(switchElement);
            await this.delay(800);
            const newSwitchElement = document.querySelector(
              possibleSelectors.find((s) => document.querySelector(s))
            );
            if (newSwitchElement && newSwitchElement.classList.contains("ui-switch-checked")) {
              UI.notify("\u62DB\u547C\u8BED\u529F\u80FD\u5DF2\u542F\u7528", "success");
            } else {
              await this.simulateClick(switchElement);
              await this.delay(500);
              const finalSwitchElement = document.querySelector(
                possibleSelectors.find((s) => document.querySelector(s))
              );
              if (finalSwitchElement && finalSwitchElement.classList.contains("ui-switch-checked")) {
                UI.notify("\u62DB\u547C\u8BED\u529F\u80FD\u5DF2\u542F\u7528", "success");
              } else {
                UI.notify("\u8BF7\u624B\u52A8\u542F\u7528\u62DB\u547C\u8BED\u529F\u80FD", "warning");
              }
            }
          } else {
            UI.notify("\u62DB\u547C\u8BED\u529F\u80FD\u5DF2\u542F\u7528", "success");
          }
        } else {
          const allSwitches = document.querySelectorAll("[class*='switch']");
          allSwitches.forEach((el, index) => {
            this.log(`\u5F00\u5173 ${index + 1}: ${el.className}, \u6587\u672C: ${el.textContent?.trim()}`);
          });
        }
      } catch (error) {
        ErrorHandler.handle(error, "Core.handleGreetSettingsPage");
      }
    },
    extractTwoCharKeywords(text) {
      const keywords = [];
      const cleanedText = text.replace(/[\s,，.。:：;；""''\[\]\(\)\{\}]/g, "");
      for (let i = 0; i < cleanedText.length - 1; i++) {
        keywords.push(cleanedText.substring(i, i + 2));
      }
      return keywords;
    },
    resetCycle() {
      toggleProcess();
      this.log("\u6240\u6709\u5C97\u4F4D\u6C9F\u901A\u5B8C\u6210\uFF0C\u606D\u559C\u60A8\u5373\u5C06\u627E\u5230\u7406\u60F3\u5DE5\u4F5C\uFF01");
      state.currentIndex = 0;
    },
    log(message) {
      const logEntry = `[${(/* @__PURE__ */ new Date()).toLocaleTimeString()}] ${message}`;
      const logPanel = document.querySelector("#pro-log");
      if (logPanel) {
        if (state.comments.isCommentMode) {
          return;
        }
        const logItem = document.createElement("div");
        logItem.className = "log-item";
        logItem.style.padding = "0px 8px";
        logItem.textContent = logEntry;
        logPanel.appendChild(logItem);
        logPanel.scrollTop = logPanel.scrollHeight;
      }
    }
  };

  // src/03-infra.js
  var ErrorHandler = class {
    static {
      __name(this, "ErrorHandler");
    }
    static handle(error, context = "") {
      const errorInfo = {
        message: error.message,
        stack: error.stack,
        context,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      console.error(`[${context}]`, error);
      if (state.settings && state.settings.errorReporting) {
        this.report(errorInfo);
      }
      return errorInfo;
    }
    static async wrap(fn, context) {
      try {
        return await fn();
      } catch (error) {
        return this.handle(error, context);
      }
    }
    static report(errorInfo) {
      console.log("Error reported:", errorInfo);
    }
  };
  var APIInterceptor = class _APIInterceptor {
    static {
      __name(this, "APIInterceptor");
    }
    /** 最近一次 detail.json 的职位信息（标题 / 描述 / 技能），供岗位要求抓取使用 */
    static lastJobDetail = null;
    static init() {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        this._url = url;
        this._method = method;
        return originalOpen.apply(this, [method, url, ...args]);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        if (this._url && this._url.includes("/wapi/zpgeek/job/detail.json")) {
          const urlObj = new URL(this._url, window.location.origin);
          const securityId = urlObj.searchParams.get("securityId");
          const lid = urlObj.searchParams.get("lid");
          if (securityId) {
            const jobIdMatch = this._url.match(/job_detail\/([^.]+)\.html/);
            const jobId = jobIdMatch ? jobIdMatch[1] : null;
            state.securityIdCache.set("current", {
              securityId,
              lid,
              jobId,
              timestamp: Date.now()
            });
            console.log(`[API\u62E6\u622A\u5668] \u6355\u83B7securityId: ${securityId.substring(0, 20)}...`);
          }
        }
        if (this._url && this._url.includes("/wapi/zpgeek/job/detail.json")) {
          const xhr = this;
          xhr.addEventListener("load", () => _APIInterceptor.captureDetail(xhr));
        }
        return originalSend.apply(this, args);
      };
      console.log("[API\u62E6\u622A\u5668] \u5DF2\u542F\u52A8");
    }
    /** 读取 XHR 响应体并解析成 JSON；响应用不了（responseType 不匹配等）就返回 null */
    static readResponseJSON(xhr) {
      let data = xhr.response;
      if (typeof data === "string") {
        try {
          return JSON.parse(data);
        } catch (e) {
          return null;
        }
      }
      if (Object.prototype.toString.call(data) === "[object Object]" || Array.isArray(data)) {
        return data;
      }
      try {
        return JSON.parse(xhr.responseText);
      } catch (e) {
        return null;
      }
    }
    static captureDetail(xhr) {
      try {
        const json = _APIInterceptor.readResponseJSON(xhr);
        if (!json) return;
        const parsed = _APIInterceptor.pickJobDetail(json);
        if (!parsed || !parsed.description) return;
        _APIInterceptor.lastJobDetail = { ...parsed, at: Date.now() };
        console.log(
          `[API\u62E6\u622A\u5668] \u6355\u83B7\u804C\u4F4D\u8BE6\u60C5\u300C${parsed.title || "?"}\u300D\u63CF\u8FF0 ${parsed.description.length} \u5B57`
        );
      } catch (e) {
      }
    }
    /**
     * 从 detail.json 的返回里挑出职位标题 / 描述 / 技能。
     *
     * 字段名在不同版本里换过（jobName / postDescription / jobDescription …），
     * 所以先按已知字段名取，取不到再全量递归找"最长的那个字符串"兜底 ——
     * 一个职位详情响应里最长的文本，几乎一定是职位描述。
     */
    static pickJobDetail(json) {
      if (!json || typeof json !== "object") return null;
      const info = json.zpData && json.zpData.jobInfo || null;
      let title = "";
      let desc = "";
      let skills = "";
      if (info && typeof info === "object") {
        title = _APIInterceptor.firstString(info, ["jobName", "jobTitle", "positionName", "name"]);
        desc = _APIInterceptor.firstString(info, [
          "postDescription",
          "jobDescription",
          "jobDesc",
          "postDesc",
          "description",
          "content"
        ]);
        skills = _APIInterceptor.joinStrings(
          info.skills || info.skillList || info.jobLabels || info.jobKeywords
        );
      }
      if (!desc) desc = _APIInterceptor.longestString(json, 20);
      if (!title && json.zpData) title = _APIInterceptor.firstString(json.zpData, ["jobName"]);
      const description = _APIInterceptor.cleanDescription(
        [desc, skills ? "\u6280\u80FD\uFF1A" + skills : ""].filter(Boolean).join("\n")
      );
      return { title: String(title || "").trim(), description };
    }
    static firstString(obj, keys) {
      if (!obj || typeof obj !== "object") return "";
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return "";
    }
    static joinStrings(value) {
      if (!Array.isArray(value)) return "";
      return value.map((x) => typeof x === "string" ? x : x && (x.name || x.label || x.text) || "").map((x) => String(x).trim()).filter(Boolean).join("\u3001");
    }
    /** 深度优先找最长的字符串字段（限 6 层），跳过图片/链接一类显然不是正文的字段 */
    static longestString(node, min, depth = 0) {
      if (depth > 6 || node === null || node === void 0) return "";
      if (typeof node === "string") return node.length >= min ? node : "";
      if (typeof node !== "object") return "";
      let best = "";
      if (Array.isArray(node)) {
        for (const item of node) {
          const s = _APIInterceptor.longestString(item, min, depth + 1);
          if (s.length > best.length) best = s;
        }
        return best;
      }
      for (const key of Object.keys(node)) {
        if (/url|logo|icon|img|image|html|script|token|cookie|avatar/i.test(key)) continue;
        const s = _APIInterceptor.longestString(node[key], min, depth + 1);
        if (s.length > best.length) best = s;
      }
      return best;
    }
    /** 接口返回的描述带 <br> 和 HTML 实体，清洗成纯文本 */
    static cleanDescription(text) {
      return String(text || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/[ 	 　]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    }
    static getCurrentSecurityId() {
      const cached = state.securityIdCache.get("current");
      if (cached && Date.now() - cached.timestamp < 3e5) {
        return cached;
      }
      return null;
    }
  };
  var DOMCache = class {
    static {
      __name(this, "DOMCache");
    }
    static cache = /* @__PURE__ */ new Map();
    static maxAge = CONFIG.PERFORMANCE.DOM_CACHE_MAX_AGE;
    static get(selector) {
      const cached = this.cache.get(selector);
      if (cached && Date.now() - cached.time < this.maxAge) {
        return cached.element;
      }
      const element = document.querySelector(selector);
      if (element) {
        this.cache.set(selector, { element, time: Date.now() });
      }
      return element;
    }
    static getAll(selector) {
      return document.querySelectorAll(selector);
    }
    static clear() {
      this.cache.clear();
    }
    static remove(selector) {
      this.cache.delete(selector);
    }
  };
  var StorageManager = class {
    static {
      __name(this, "StorageManager");
    }
    static setItem(key, value) {
      try {
        localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
        return true;
      } catch (error) {
        Core.log(`\u8BBE\u7F6E\u5B58\u50A8\u9879 ${key} \u5931\u8D25: ${error.message}`);
        return false;
      }
    }
    static getItem(key, defaultValue = null) {
      try {
        const value = localStorage.getItem(key);
        return value !== null ? value : defaultValue;
      } catch (error) {
        Core.log(`\u83B7\u53D6\u5B58\u50A8\u9879 ${key} \u5931\u8D25: ${error.message}`);
        return defaultValue;
      }
    }
    static addRecordWithLimit(storageKey, record, currentSet, limit) {
      try {
        if (currentSet.has(record)) {
          return;
        }
        let records = this.getParsedItem(storageKey, []);
        records = Array.isArray(records) ? records : [];
        if (records.length >= limit) {
          records.shift();
        }
        records.push(record);
        currentSet.add(record);
        this.setItem(storageKey, records);
        console.log(
          `\u5B58\u50A8\u7BA1\u7406: \u6DFB\u52A0\u8BB0\u5F55${records.length >= limit ? "\u5E76\u5220\u9664\u6700\u65E9\u8BB0\u5F55" : ""}\uFF0C\u5F53\u524D${storageKey}\u6570\u91CF: ${records.length}/${limit}`
        );
      } catch (error) {
        console.log(`\u5B58\u50A8\u7BA1\u7406\u51FA\u9519: ${error.message}`);
      }
    }
    static getParsedItem(storageKey, defaultValue = []) {
      try {
        const data = this.getItem(storageKey);
        return data ? JSON.parse(data) : defaultValue;
      } catch (error) {
        Core.log(`\u89E3\u6790\u5B58\u50A8\u8BB0\u5F55\u51FA\u9519: ${error.message}`);
        return defaultValue;
      }
    }
    static ensureStorageLimits() {
      const limitConfigs = [
        {
          key: CONFIG.STORAGE_KEYS.PROCESSED_HRS,
          set: state.hrInteractions.processedHRs,
          limit: CONFIG.STORAGE_LIMITS.PROCESSED_HRS
        },
        {
          key: CONFIG.STORAGE_KEYS.SENT_GREETINGS_HRS,
          set: state.hrInteractions.sentGreetingsHRs,
          limit: CONFIG.STORAGE_LIMITS.SENT_GREETINGS_HRS
        },
        {
          key: CONFIG.STORAGE_KEYS.SENT_RESUME_HRS,
          set: state.hrInteractions.sentResumeHRs,
          limit: CONFIG.STORAGE_LIMITS.SENT_RESUME_HRS
        },
        {
          key: CONFIG.STORAGE_KEYS.SENT_IMAGE_RESUME_HRS,
          set: state.hrInteractions.sentImageResumeHRs,
          limit: CONFIG.STORAGE_LIMITS.SENT_IMAGE_RESUME_HRS
        }
      ];
      limitConfigs.forEach(({ key, set, limit }) => {
        const records = this.getParsedItem(key, []);
        if (records.length > limit) {
          const trimmedRecords = records.slice(-limit);
          this.setItem(key, trimmedRecords);
          set.clear();
          trimmedRecords.forEach((record) => set.add(record));
          console.log(`\u5B58\u50A8\u7BA1\u7406: \u6E05\u7406${key}\u8BB0\u5F55\uFF0C\u4ECE${records.length}\u51CF\u5C11\u5230${trimmedRecords.length}`);
        }
      });
    }
  };
  var StatePersistence = class {
    static {
      __name(this, "StatePersistence");
    }
    static loadState() {
      try {
        if (typeof settings !== "undefined" && settings) {
          if (Array.isArray(settings.imageResumes)) {
            state.settings.imageResumes = settings.imageResumes;
          }
          if (Array.isArray(settings.greetingsList)) {
            state.settings.greetingsList = settings.greetingsList;
          }
        }
        StorageManager.ensureStorageLimits();
      } catch (error) {
        console.warn("[BOSS\u6295\u9012\u52A9\u624B] \u52A0\u8F7D\u72B6\u6001\u5931\u8D25:", error);
      }
    }
  };

  // src/11-guide.js
  var style = document.createElement("style");
  style.textContent = `
    @keyframes guide-pulse {
        0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(79, 70, 229, 0.4); }
        70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(79, 70, 229, 0); }
        100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(79, 70, 229, 0); }
    }
    
    .guide-content .highlight {
        font-weight: 700;
        color: #1a73e8;
    }
    
    .guide-content .warning {
        font-weight: 700;
        color: #d93025;
    }
`;
  document.head.appendChild(style);

  // src/12-entry.js
  function waitForBody(timeout = 15e3) {
    return new Promise((resolve) => {
      if (document.body) return resolve(true);
      const start2 = Date.now();
      const timer = setInterval(() => {
        if (document.body) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - start2 > timeout) {
          clearInterval(timer);
          resolve(false);
        }
      }, 50);
    });
  }
  __name(waitForBody, "waitForBody");
  async function init() {
    try {
      StatePersistence.loadState();
      APIInterceptor.init();
      const ok = await waitForBody();
      if (!ok || !document.body) {
        console.warn("[BOSS\u6295\u9012\u52A9\u624B] \u9875\u9762\u7ED3\u6784\u4E0D\u53EF\u7528\uFF0C\u653E\u5F03\u6CE8\u5165");
        return;
      }
      UI.init();
      try {
        document.body.style.position = "relative";
      } catch (e) {
      }
      startPanelWatchdog();
      if (PAGE.isJobList()) {
        Core.log("\u6B22\u8FCE\u4F7F\u7528 BOSS\u6295\u9012\u52A9\u624B\u3002\u70B9\u300C\u5F00\u59CB\u6295\u9012\u300D\u540E\uFF0C\u6211\u4F1A\u9010\u4E2A\u6253\u5F00\u5C97\u4F4D\u4EA4\u7ED9 AI \u5224\u65AD\u662F\u5426\u6295\u9012\u3002");
      } else if (PAGE.isChat()) {
        Core.log("\u6B22\u8FCE\u4F7F\u7528 BOSS\u6295\u9012\u52A9\u624B\uFF0C\u6211\u5C06\u81EA\u52A8\u53D1\u9001\u7B80\u5386\uFF01");
      } else if (PAGE.isGreetSettings()) {
        Core.log("\u6B22\u8FCE\u4F7F\u7528 BOSS\u6295\u9012\u52A9\u624B\uFF0C\u6B63\u5728\u68C0\u6D4B\u62DB\u547C\u8BED\u5F00\u5173\u2026");
        Core.handleGreetSettingsPage();
      } else {
        Core.log("\u5F53\u524D\u9875\u9762\u6682\u4E0D\u652F\u6301\uFF0C\u8BF7\u6253\u5F00 BOSS \u76F4\u8058\u804C\u4F4D\u5217\u8868\u9875\uFF08www.zhipin.com/web/geek/jobs\uFF09");
      }
    } catch (error) {
      console.error("[BOSS\u6295\u9012\u52A9\u624B] \u521D\u59CB\u5316\u5931\u8D25:", error);
      try {
        if (typeof showNotification === "function") {
          showNotification("BOSS\u6295\u9012\u52A9\u624B\u521D\u59CB\u5316\u5F02\u5E38\uFF1A" + error.message, "error");
        }
      } catch (e) {
      }
    }
  }
  __name(init, "init");
  var panelWatchdogTimer = null;
  function startPanelWatchdog() {
    if (panelWatchdogTimer) return;
    panelWatchdogTimer = setInterval(() => {
      try {
        if (!document.body) return;
        if (!document.getElementById("boss-pro-panel")) {
          console.warn("[BOSS\u6295\u9012\u52A9\u624B] \u9762\u677F\u4E22\u5931\uFF0C\u91CD\u65B0\u6CE8\u5165");
          UI.createControlPanel();
          if (!document.getElementById("boss-mini-icon") && !elements.miniIcon) {
            UI.createMiniIcon();
          }
        }
      } catch (e) {
        console.error("[BOSS\u6295\u9012\u52A9\u624B] \u9762\u677F\u5B88\u62A4\u5F02\u5E38:", e);
      }
    }, 3e3);
  }
  __name(startPanelWatchdog, "startPanelWatchdog");
  var lastPageKey = null;
  function handleRouteChange() {
    const key = PAGE.key();
    if (key === lastPageKey) return;
    lastPageKey = key;
    console.log("[BOSS\u6295\u9012\u52A9\u624B] \u9875\u9762\u5207\u6362\u5230:", key);
    if (state.isRunning) {
      state.isRunning = false;
      state.currentIndex = 0;
      state.jobList = [];
      Core.log("\u9875\u9762\u5DF2\u5207\u6362\uFF0C\u5DF2\u505C\u6B62\u5F53\u524D\u4EFB\u52A1");
    }
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
      console.error("[BOSS\u6295\u9012\u52A9\u624B] \u91CD\u5EFA\u9762\u677F\u5931\u8D25:", e);
    }
  }
  __name(handleRouteChange, "handleRouteChange");
  function start() {
    lastPageKey = PAGE.key();
    init();
    watchRoute();
  }
  __name(start, "start");
  function watchRoute() {
    ["pushState", "replaceState"].forEach((name) => {
      const orig = history[name];
      if (typeof orig !== "function") return;
      history[name] = function() {
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
  __name(watchRoute, "watchRoute");

  // src/main.js
  start();
})();
