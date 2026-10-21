import { state } from "./02-state.js";

/* =========================================================================
 * 判定用的提示词：**只有一个主提示词模板**
 *
 * 简历、投递要求这些素材，用户直接写在模板正文里 —— 不再有"片段"这一层。
 * v2.3.0 曾经是「模板 + 一组可增删改的 kv 片段」，用户要在两个地方对着维护，
 * 两边名字对不上就静默失效（AI 收到裸 {resume}，表现为"所有岗位都不值得投"）。
 *
 * 唯一保留的占位符是**内置变量** {jobTitle} / {jobDescription}：
 * 它们的值只能由代码在每次判定时注入（见 BUILTIN_PROMPT_VARS），
 * 本质上不是"用户可维护的素材"，留着不违背"一个文本框"这件事。
 * ========================================================================= */

/** 只有规则段 —— 默认主提示词的前半截 */
export const PROMPT_RULES_DEFAULT =
  "你是求职者的投递助手。你会收到求职者的简历、投递要求和某个岗位的详情，" +
  "请判断这个岗位是否值得投递。" +
  "只有当岗位与简历、投递要求都匹配时才判为值得投递；" +
  "若岗位要求明显超出简历能力，或违反投递要求里的任意一条硬性条件，判为不值得；" +
  "若信息不足以判断，一律判为不值得。";

/**
 * v2.4.0（2026-10-20）起判定不再需要 AI 生成 greeting。
 * 老版本的默认规则段里留着这一整句；用户保存过的提示词若原样包含它，
 * 加载时删掉，免得模型继续白写一段没人消费的内容。
 * 只匹配这一个已知句子 —— 用户自己改过的规则一个字不动。
 */
const LEGACY_GREETING_RULE =
  "同时为值得投递的岗位写一条打招呼消息：先简洁自我介绍（学历/专业/年限），" +
  "再说明与岗位匹配的技能与成果，表达岗位意向，最后询问能否发一份简历；" +
  "口语化像真人聊天、20-100 字、不要客套废话。";

/**
 * 只有数据段 —— 默认主提示词的后半截。
 *
 * 【我的简历】【我的投递要求】两个小节**故意留空**：它们是"简历该写在这儿"的填写位，
 * 用户（以及迁移过来的老用户）直接往小节里写正文。
 */
export const PROMPT_SECTIONS_DEFAULT =
  "\n\n【我的简历】\n" +
  "\n\n【我的投递要求】\n" +
  "\n\n【岗位标题】\n{jobTitle}" +
  "\n\n【岗位要求】\n{jobDescription}";

export const PROMPT_TEMPLATE_DEFAULT = PROMPT_RULES_DEFAULT + PROMPT_SECTIONS_DEFAULT;

/**
 * v2.3.0 时代的数据段（带 {resume} / {require} 占位符）—— **只给老配置迁移用**。
 *
 * 别拿它当默认值：新版模板已经没有那两个占位符了（见 PROMPT_SECTIONS_DEFAULT）。
 * 但迁移必须用它 —— v2.2.x 老用户的简历存在 userResume 键里，只有先摆出含 {resume}
 * 的数据段、再把简历填进去，内容才有着落。直接换用新版常量会把简历**静默丢掉**。
 *
 * 全新用户走这条路时 resume/require 都是空串，填完恰好等于新版默认模板，两条路收敛。
 */
const PROMPT_SECTIONS_LEGACY =
  "\n\n【我的简历】\n{resume}" +
  "\n\n【我的投递要求】\n{require}" +
  "\n\n【岗位标题】\n{jobTitle}" +
  "\n\n【岗位要求】\n{jobDescription}";

/**
 * 内置变量名：值在每次判定时注入，模板里可以不写它们（那就抓不到岗位信息），
 * 但写了就必须由代码来填 —— 所以它们永远不进"未填占位符"的提醒（见 renderPrompt）。
 */
export const BUILTIN_PROMPT_VARS = ["jobTitle", "jobDescription"];

/**
 * system 消息 = 固定的 JSON 输出契约，界面上只读。
 * 规则和素材都在 user 消息里（渲染后的主提示词），
 * 契约一旦被改坏，parseAiVerdict() 会一律返回 match:false ——
 * 表现为"一个岗位都投不出去，而且日志里没有任何报错"，所以不让用户碰。
 */
export const AI_JUDGE_SYSTEM_ROLE =
  "请按用户消息里的要求判断岗位是否值得投递。" +
  "只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释文字，格式为：" +
  '{"match": true 或 false, "reason": "不超过 30 字的中文理由"}';

export const SETTINGS_DEFAULTS = {
  // —— 运行模式 ——
  useAutoSendResume: false, // 自动发送附件简历
  useAutoSendImageResume: false, // 自动发送图片简历
  excludeHeadhunters: false, // 排除猎头
  useApiApply: false, // 尝试走站内接口投递（更快，但易随接口变动失效）
  autoAcceptCard: false, // HR 发来「交换联系方式」卡片时，自动点「同意」

  // —— 筛选 ——
  recruiterActivityStatus: ["不限"],

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
  imageResumeData: null,
};

export const SettingsStore = {
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
      return v === null || v === undefined ? def : v;
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
    greetingsList = greetingsList
      .filter((g) => g && typeof g === "object")
      .map((g, i) => ({
        id: String(g.id || i + 1),
        content: typeof g.content === "string" ? g.content : "",
      }));

    let imageResumes = this.readJSON("imageResumes", []);
    if (!Array.isArray(imageResumes)) imageResumes = [];

    let activityStatus = this.readJSON("recruiterActivityStatus", D.recruiterActivityStatus);
    if (!Array.isArray(activityStatus) || activityStatus.length === 0) {
      activityStatus = ["不限"];
    }

    // —— 提示词：只剩一个主模板，片段机制（v2.3.0）已退休 ——
    // 升级上来的用户，素材还散在片段里 / 更老的老键里，这里一次性合并进主提示词正文。
    // 闸门是 "promptVars" 这个键本身：合并完就把它删掉，之后每次加载都走 no-op
    // （就算删键失败也没关系 —— 合并后模板里已经没有 {resume} 了，再合并是空操作，
    //   幂等是结构自带的，不靠这个 removeItem 兜底）。
    const storedVars = this.readJSON("promptVars", null);
    const legacyVars =
      storedVars === null
        ? // v2.3.0 之前的三个老键
          [
            { name: "resume", value: this.readString("userResume", "") },
            { name: "require", value: this.readString("aiApplyCriteria", "") },
          ]
        : (Array.isArray(storedVars) ? storedVars : [])
            .filter((v) => v && typeof v === "object")
            .map((v) => ({
              name: typeof v.name === "string" ? v.name : "",
              value: typeof v.value === "string" ? v.value : "",
            }));

    const storedTemplate = this.readString("promptTemplate", null);
    const baseTemplate =
      storedTemplate === null
        ? // 老用户改过的规则段要保留；数据段用**老版**（带 {resume}/{require}）补上，
          // 否则下面没得可填，userResume 里的简历会被静默丢掉
          this.readString("aiJudgePrompt", PROMPT_RULES_DEFAULT) + PROMPT_SECTIONS_LEGACY
        : storedTemplate;

    const mergedTemplate = inlinePromptVars(baseTemplate, legacyVars);
    const promptTemplate = mergedTemplate.split(LEGACY_GREETING_RULE).join("");

    // 合并结果**必须先落盘**，否则是真正的静默丢数据：
    // 下次加载时 promptVars 已经删了，而 promptTemplate 还是带 {resume} 的旧版，
    // 那时 legacyVars 是空的 —— {resume} 会被替换成空串，简历就此消失。
    // 两句话写在同一个 try 里也是有意的：setItem 抛了（配额满 / 隐私模式）就**不删**源键，
    // 下次加载还能重新合并一遍。顺序反过来则会在写入失败时把唯一的副本一起弄丢。
    if (storedVars !== null) {
      try {
        localStorage.setItem("promptTemplate", promptTemplate);
        localStorage.removeItem("promptVars");
      } catch (e) {}
    } else if (promptTemplate !== mergedTemplate) {
      // 只删了老的「写一条打招呼消息」规则：没有片段要合并，单独落盘即可。
      try {
        localStorage.setItem("promptTemplate", promptTemplate);
      } catch (e) {}
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
      imageResumeData: this.readString("imageResumeData", null),
    };
  },

  /** 写入全部配置 */
  save(s) {
    if (!s) return;
    const write = (k, v) => {
      try {
        localStorage.setItem(k, v === null || v === undefined ? "" : String(v));
      } catch (e) {
        console.warn("[BOSS投递助手] 写入配置失败", k, e);
      }
    };
    const writeJSON = (k, v) => {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {
        console.warn("[BOSS投递助手] 写入配置失败", k, e);
      }
    };

    write("useAutoSendResume", s.useAutoSendResume);
    write("useAutoSendImageResume", s.useAutoSendImageResume);
    write("excludeHeadhunters", s.excludeHeadhunters);
    write("useApiApply", s.useApiApply);
    write("autoAcceptCard", s.autoAcceptCard);

    writeJSON("recruiterActivityStatus", s.recruiterActivityStatus || ["不限"]);

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
      } catch (e) {}
    }
  },
};

/** 唯一配置实例；state.settings 会指向同一个对象（见下方 state.settings = settings） */
export const settings = SettingsStore.load();

// 兼容旧代码写法 settings.ai.apiKey / settings.actionDelays.click
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
      },
    };
  },
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
      },
    };
  },
});

// 关键：让 state.settings 与全局 settings 变成同一个对象，彻底消除"两份配置不同步"
state.settings = settings;

/**
 * 把模板里的 {名字} 替换成对应的值，返回替换后的文本。
 *
 * 只给**老配置迁移**用（见 load）：v2.3.0 的片段、以及更老的 userResume /
 * aiApplyCriteria，都在这里被原地写回主提示词正文，从此只剩一个文本框。
 *
 * - 值为空 → 替换成**空串**，不留裸 `{resume}`。片段机制已经没了，用户没有任何地方
 *   可以再填它，留着只会让他每次启动都看到"占位符没填"的告警
 * - 名字是内置变量时**跳过**：用户可能自建过一个叫 jobTitle 的片段，照单全收的话
 *   `{jobTitle}` 会被那次片段值永久写死，岗位标题再也注入不进去（旧版是"内置优先"）
 * - 重名只取第一条、名字 trim 后为空则跳过（与 renderPrompt 的语义保持一致）
 */
function inlinePromptVars(template, vars) {
  const map = {};
  (vars || []).forEach((v) => {
    const name = v && v.name ? String(v.name).trim() : "";
    if (!name) return;
    if (BUILTIN_PROMPT_VARS.indexOf(name) !== -1) return;
    if (!(name in map)) map[name] = v.value == null ? "" : String(v.value);
  });

  return String(template || "").replace(/\{([A-Za-z0-9_-]+)\}/g, (whole, name) =>
    name in map ? map[name] : whole,
  );
}

/**
 * 把主提示词模板里的 {内置变量} 替换成运行时的值。
 *
 * - 只认 `{标识符}`，模板里写 `{"match": true}` 这类 JSON 不会被误伤
 * - 命中空值 / 找不到的占位符时**保留 `{名字}` 原文**，并由 missing 带出来 ——
 *   改写成空串的话，AI 日志里就看不出是哪一段没填了
 * - missing 只收集非内置名：内置变量的值由代码在判定时注入，
 *   启动校验那一刻它们本来就是空的，不该误报
 *
 * 片段机制退休后，mapping 里只剩 runtimeVars 这一层，missing 里的名字都是
 * "用户自己写错/写了但已经没法再填"的 —— 见 08-core.js 启动时的那条软提醒。
 *
 * @returns {{text: string, missing: string[]}} missing 是去重后的占位符名字
 */
export function renderPrompt(template, runtimeVars) {
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

/** 兼容旧调用点：保存配置并同步到 state */
export function saveSettings() {
  try {
    SettingsStore.save(settings);
    if (state && state.settings) Object.assign(state.settings, settings);
    return true;
  } catch (error) {
    console.error("[BOSS投递助手] 保存设置失败:", error);
    return false;
  }
}
