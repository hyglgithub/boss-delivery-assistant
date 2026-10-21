import { CONFIG } from "./01-config.js";
import { state } from "./02-state.js";
import { settings } from "./06-settings.js";
import { Core } from "./08-core.js";
export class ErrorHandler {
  static handle(error, context = "") {
    const errorInfo = {
      message: error.message,
      stack: error.stack,
      context,
      timestamp: new Date().toISOString(),
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
}

export class APIInterceptor {
  /** 最近一次 detail.json 的职位信息（标题 / 描述 / 技能），供岗位要求抓取使用 */
  static lastJobDetail = null;

  static init() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      this._url = url;
      this._method = method;
      return originalOpen.apply(this, [method, url, ...args]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
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
            timestamp: Date.now(),
          });

          console.log(`[API拦截器] 捕获securityId: ${securityId.substring(0, 20)}...`);
        }
      }

      if (this._url && this._url.includes("/wapi/zpgeek/job/detail.json")) {
        // 顺手把响应体留下来。详情区的 DOM 结构会随 BOSS 改版而变
        // （v2.2.0 线上就出现过所有详情区选择器全部落空、AI 只能回"信息不足"），
        // 而接口返回的职位描述一直是全的，所以抓岗位要求优先用它。
        const xhr = this;
        xhr.addEventListener("load", () => APIInterceptor.captureDetail(xhr));
      }

      return originalSend.apply(this, args);
    };

    console.log("[API拦截器] 已启动");
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
    // responseType = "json" 时 response 已经是对象；blob/arraybuffer 一律不认
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
      const json = APIInterceptor.readResponseJSON(xhr);
      if (!json) return;

      const parsed = APIInterceptor.pickJobDetail(json);
      if (!parsed || !parsed.description) return;

      APIInterceptor.lastJobDetail = { ...parsed, at: Date.now() };
      console.log(
        `[API拦截器] 捕获职位详情「${parsed.title || "?"}」描述 ${parsed.description.length} 字`,
      );
    } catch (e) {}
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

    const info = (json.zpData && json.zpData.jobInfo) || null;
    let title = "";
    let desc = "";
    let skills = "";

    if (info && typeof info === "object") {
      title = APIInterceptor.firstString(info, ["jobName", "jobTitle", "positionName", "name"]);
      desc = APIInterceptor.firstString(info, [
        "postDescription",
        "jobDescription",
        "jobDesc",
        "postDesc",
        "description",
        "content",
      ]);
      skills = APIInterceptor.joinStrings(
        info.skills || info.skillList || info.jobLabels || info.jobKeywords,
      );
    }

    // 阈值放到 20 字：真正的职位描述永远是响应里最长的那个字段，
    // 卡太高反而会在描述本来就短的时候什么都拿不到（被测试抓到过）
    if (!desc) desc = APIInterceptor.longestString(json, 20);
    if (!title && json.zpData) title = APIInterceptor.firstString(json.zpData, ["jobName"]);

    const description = APIInterceptor.cleanDescription(
      [desc, skills ? "技能：" + skills : ""].filter(Boolean).join("\n"),
    );
    return { title: String(title || "").trim(), description: description };
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
    return value
      .map((x) => (typeof x === "string" ? x : (x && (x.name || x.label || x.text)) || ""))
      .map((x) => String(x).trim())
      .filter(Boolean)
      .join("、");
  }

  /** 深度优先找最长的字符串字段（限 6 层），跳过图片/链接一类显然不是正文的字段 */
  static longestString(node, min, depth = 0) {
    if (depth > 6 || node === null || node === undefined) return "";
    if (typeof node === "string") return node.length >= min ? node : "";
    if (typeof node !== "object") return "";

    let best = "";
    if (Array.isArray(node)) {
      for (const item of node) {
        const s = APIInterceptor.longestString(item, min, depth + 1);
        if (s.length > best.length) best = s;
      }
      return best;
    }
    for (const key of Object.keys(node)) {
      if (/url|logo|icon|img|image|html|script|token|cookie|avatar/i.test(key)) continue;
      const s = APIInterceptor.longestString(node[key], min, depth + 1);
      if (s.length > best.length) best = s;
    }
    return best;
  }

  /** 接口返回的描述带 <br> 和 HTML 实体，清洗成纯文本 */
  static cleanDescription(text) {
    return String(text || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ 	 　]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  static getCurrentSecurityId() {
    const cached = state.securityIdCache.get("current");
    if (cached && Date.now() - cached.timestamp < 300000) {
      return cached;
    }
    return null;
  }
}

export class DOMCache {
  static cache = new Map();
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
}

export class StorageManager {
  static setItem(key, value) {
    try {
      localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
      return true;
    } catch (error) {
      Core.log(`设置存储项 ${key} 失败: ${error.message}`);
      return false;
    }
  }

  static getItem(key, defaultValue = null) {
    try {
      const value = localStorage.getItem(key);
      return value !== null ? value : defaultValue;
    } catch (error) {
      Core.log(`获取存储项 ${key} 失败: ${error.message}`);
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
        `存储管理: 添加记录${
          records.length >= limit ? "并删除最早记录" : ""
        }，当前${storageKey}数量: ${records.length}/${limit}`,
      );
    } catch (error) {
      console.log(`存储管理出错: ${error.message}`);
    }
  }

  static getParsedItem(storageKey, defaultValue = []) {
    try {
      const data = this.getItem(storageKey);
      return data ? JSON.parse(data) : defaultValue;
    } catch (error) {
      Core.log(`解析存储记录出错: ${error.message}`);
      return defaultValue;
    }
  }

  static ensureStorageLimits() {
    const limitConfigs = [
      {
        key: CONFIG.STORAGE_KEYS.PROCESSED_HRS,
        set: state.hrInteractions.processedHRs,
        limit: CONFIG.STORAGE_LIMITS.PROCESSED_HRS,
      },
      {
        key: CONFIG.STORAGE_KEYS.SENT_GREETINGS_HRS,
        set: state.hrInteractions.sentGreetingsHRs,
        limit: CONFIG.STORAGE_LIMITS.SENT_GREETINGS_HRS,
      },
      {
        key: CONFIG.STORAGE_KEYS.SENT_RESUME_HRS,
        set: state.hrInteractions.sentResumeHRs,
        limit: CONFIG.STORAGE_LIMITS.SENT_RESUME_HRS,
      },
      {
        key: CONFIG.STORAGE_KEYS.SENT_IMAGE_RESUME_HRS,
        set: state.hrInteractions.sentImageResumeHRs,
        limit: CONFIG.STORAGE_LIMITS.SENT_IMAGE_RESUME_HRS,
      },
    ];

    limitConfigs.forEach(({ key, set, limit }) => {
      const records = this.getParsedItem(key, []);
      if (records.length > limit) {
        const trimmedRecords = records.slice(-limit);
        this.setItem(key, trimmedRecords);

        set.clear();
        trimmedRecords.forEach((record) => set.add(record));

        console.log(`存储管理: 清理${key}记录，从${records.length}减少到${trimmedRecords.length}`);
      }
    });
  }
}

export class StatePersistence {
  static loadState() {
    try {
      // 从配置层恢复，保证与设置弹窗展示的一致
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
      console.warn("[BOSS投递助手] 加载状态失败:", error);
    }
  }
}
