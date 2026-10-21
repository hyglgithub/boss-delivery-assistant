import { CONFIG, PAGE } from "./01-config.js";
import { state } from "./02-state.js";
import { APIInterceptor, DOMCache, ErrorHandler, StorageManager } from "./03-infra.js";
import { HRInteractionManager } from "./04-hr-interaction.js";
import { UI } from "./05-ui.js";
import {
  AI_JUDGE_SYSTEM_ROLE,
  BUILTIN_PROMPT_VARS,
  PROMPT_TEMPLATE_DEFAULT,
  renderPrompt,
  settings,
} from "./06-settings.js";
import { refreshStatsUI, resetStats } from "./07-settings-dialog.js";
import { toggleChatProcess, toggleProcess } from "./09-process.js";
import { STORAGE } from "./10-storage.js";
export const Core = {
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
        this.log("未找到职位详情链接");
        return null;
      }

      const href = jobLink.getAttribute("href");
      this.log(`职位链接: ${href}`);

      const jobIdMatch = href.match(/job_detail\/([^.]+)\.html/);
      if (!jobIdMatch) {
        this.log("无法提取jobId");
        return null;
      }

      const jobId = jobIdMatch[1];
      const securityIdMatch = href.match(/securityId=([^&]+)/);
      const securityId = securityIdMatch ? securityIdMatch[1] : null;

      const lidMatch = href.match(/lid=([^&]+)/);
      const lid = lidMatch ? lidMatch[1] : "";

      this.log(
        `提取信息 - jobId: ${jobId}, securityId: ${securityId ? "已获取" : "未找到"}, lid: ${lid}`,
      );

      return {
        jobId,
        securityId,
        lid,
      };
    } catch (error) {
      this.log(`提取职位信息失败: ${error.message}`);
      return null;
    }
  },

  async sendFriendRequest(jobId, securityId, lid) {
    try {
      if (!securityId) {
        throw new Error("缺少securityId参数");
      }

      const timestamp = Date.now();
      const url = `/wapi/zpgeek/friend/add.json?securityId=${encodeURIComponent(securityId)}&jobId=${encodeURIComponent(jobId || "")}&lid=${encodeURIComponent(lid || "")}&_=${timestamp}`;

      const response = await fetch(url, {
        method: "POST",
        body: "sessionId=",
      });

      const result = await response.json();

      if (result.code === 0) {
        return result;
      } else {
        throw new Error(result.message || "请求失败");
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
        document.querySelectorAll(".job-list-box .job-card-wrapper, ul.job-list-box > li"),
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
      const a =
        card.querySelector('a[href*="/job_detail/"]') || (card.tagName === "A" ? card : null);
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
    } catch (e) {}
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
    // —— 聊天页：监听并自动回复 ——
    if (PAGE.isChat()) {
      this.log("开始监听招聘者消息…");
      this.resetChatScan();
      this.chatScanMode = settings.communicationMode;
      this.chatStoreWarned = false;
      const runId = ++this.chatRunId;

      while (state.isRunning && this.chatRunId === runId) {
        // 运行中切模式：从新的模式状态重新开始（全量遍历会从头再走一遍）
        if (this.chatScanMode !== settings.communicationMode) {
          this.chatScanMode = settings.communicationMode;
          const modeLabel = settings.communicationMode === "auto" ? "自动轮询" : "仅新消息";
          this.log(`沟通模式已切换为「${modeLabel}」，已重置会话状态`);
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
          this.log(`聊天处理异常: ${e.message}`);
        }

        const wait =
          settings.communicationMode === "auto" ? CONFIG.CHAT.POLL_INTERVAL : CONFIG.BASIC_INTERVAL;
        await this.delay(wait);
      }
      return;
    }

    // —— 非职位页：给出明确提示而不是静默空转（旧版就是在这里什么都不做）——
    if (!PAGE.isJobList()) {
      this.log("当前页面不是职位列表，请打开 www.zhipin.com/web/geek/jobs 后重试");
      if (state.isRunning) toggleProcess();
      return;
    }

    // —— 前置校验：API Key 是硬门槛 ——
    if (!settings.aiApiKey) {
      this.log("无法开始：请先在「设置 → 通用」中配置 API Key");
      if (state.isRunning) toggleProcess();
      return;
    }

    // —— 软提醒：主提示词里有替换不了的 {xxx} ——
    // 片段机制退休后，只有 {jobTitle} / {jobDescription} 两个变量是代码能填的，
    // 其余任何 {名字} 都会**原样发给 AI**（既不会被替换，也没有地方可配）。
    // 最常见的两种来源：从旧版本迁移过来、模板里还留着 {resume}；手滑打错了变量名。
    // 不阻止启动，但 50 个岗位跑下来一个都没投时，这行日志就是最先该看的地方，
    // 所以放在这里报一次，而不是每个岗位刷一遍。
    const { missing } = renderPrompt(settings.promptTemplate || PROMPT_TEMPLATE_DEFAULT, {});
    if (missing.length) {
      this.log(
        `⚠️ 提示词里有 ${missing.length} 处占位符没法替换：${missing.map((n) => `{${n}}`).join("、")}`,
      );
      this.log(
        `　可用变量只有 ${BUILTIN_PROMPT_VARS.map((n) => `{${n}}`).join(" ")}，` +
          "其余的会原样发给 AI（本次照常继续）",
      );
    }

    // 通过全部前置校验，这一轮真的开始了：统计从零起算
    resetStats();

    // 1. 自动滚动加载全部岗位
    await this.autoScrollJobList();
    if (!state.isRunning) return;

    // 2. 收集岗位（只存标识，不存 DOM 节点）
    const allCards = this.getJobCards();
    const cards = this.filterJobCards(allCards);
    if (!cards.length) {
      this.log(
        allCards.length
          ? `共 ${allCards.length} 个岗位，都被本地规则过滤掉了（检查是否开启了「排除猎头」）`
          : "页面上没有找到职位卡片，请确认职位列表已加载完成（可先手动搜索一次）",
      );
      if (state.isRunning) toggleProcess();
      return;
    }
    this.log(`共 ${cards.length}/${allCards.length} 个职位，开始逐个交给 AI 判定…`);

    const maxApply = settings.maxApplyPerRun || CONFIG.SAFETY.MAX_APPLY_PER_RUN;
    const interval = Math.max(800, settings.applyInterval || CONFIG.SAFETY.APPLY_INTERVAL);
    const done = new Set();
    let applied = 0;

    for (let i = 0; i < cards.length; i++) {
      if (!state.isRunning) break;
      if (applied >= maxApply) {
        this.log(`已达到单次投递上限 ${maxApply} 个，自动停止（可在设置中调整）`);
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
        this.log(`处理第 ${i + 1} 个职位出错：${e.message}`);
      }

      await this.delay(interval);
    }

    if (state.isRunning) {
      this.log(
        `本次运行结束：成功沟通 ${applied} 个，跳过 ${state.stats.skipped} 个，失败 ${state.stats.failed} 个`,
      );
      toggleProcess();
    }
  },

  /** 自动滚动加载岗位列表（旧版没有步数上限，页面持续增长时会无限递归） */
  async autoScrollJobList() {
    return new Promise((resolve) => {
      const waitTime = CONFIG.BASIC_INTERVAL;
      const maxSteps = CONFIG.SAFETY.MAX_SCROLL_STEPS;
      let history = [];
      let step = 0;
      let stopped = false;

      this.stopAutoScroll = () => {
        stopped = true;
        resolve(null);
      };

      const scrollStep = async () => {
        if (stopped || !state.isRunning) return resolve(null);
        step++;

        const cards = this.getJobCards();
        history.push(cards.length);
        if (history.length > 3) history.shift();

        const stable = history.length === 3 && new Set(history).size === 1;

        if (stable || step >= maxSteps) {
          this.log(
            `岗位列表加载完成，共 ${cards.length} 个${step >= maxSteps ? "（已达滚动上限）" : ""}`,
          );
          return resolve(cards);
        }

        window.scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: "smooth",
        });
        await this.delay(waitTime);
        scrollStep();
      };

      scrollStep();
    });
  },

  /** 读取招聘者活跃状态 */
  getRecruiterActiveTime() {
    try {
      const onlineTag = document.querySelector(".boss-online-tag");
      if (onlineTag && onlineTag.textContent.trim() === "在线") return "在线";
      const el =
        document.querySelector(".boss-active-time") ||
        document.querySelector(".job-detail-box .boss-active-time");
      return (el && el.textContent.trim()) || "未知";
    } catch (e) {
      return "未知";
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
      ".btn.btn-primary",
    ];

    const isChatText = (el) => {
      const text = (el.textContent || "").replace(/\s+/g, "");
      return (
        text.indexOf("沟通") !== -1 || text.indexOf("投递") !== -1 || text.indexOf("打招呼") !== -1
      );
    };

    // 1) 优先在详情区里找
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

    // 2) 兜底：排除职位卡片上的按钮
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
      return altText.indexOf("猎头") === -1 && cardText.indexOf("猎头") === -1;
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
      ".start-chat-btn",
    ];
    for (const sel of selectors) {
      const el = card.querySelector(sel);
      if (el) return el;
    }
    return null;
  },

  /** 按钮文案归一化 */
  normalizeBtnText(text) {
    return String(text || "")
      .replace(/\s+/g, "")
      .trim();
  },

  isAlreadyGreeted(text) {
    const t = this.normalizeBtnText(text);
    return (
      t.indexOf("继续沟通") !== -1 ||
      t.indexOf("继续聊") !== -1 ||
      t.indexOf("已沟通") !== -1 ||
      t.indexOf("已投递") !== -1
    );
  },

  isGreetButton(text) {
    const t = this.normalizeBtnText(text);
    return t.indexOf("立即沟通") !== -1 || t === "沟通" || t.indexOf("打招呼") !== -1;
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
    "#job-detail",
  ],

  /** 详情区里「岗位要求」正文的候选 class */
  DESC_SELECTORS: [
    ".job-sec-text",
    ".job-detail-section .text",
    ".job-detail-box .text",
    "[class*='sec-text']",
    "[class*='job-desc'] p",
    ".text",
  ],

  /** 「岗位要求」小节的标题文案，认不出 class 时靠它定位 */
  DESC_TITLES: [
    "职位描述",
    "岗位描述",
    "职位要求",
    "岗位要求",
    "任职要求",
    "岗位职责",
    "工作职责",
    "职位详情",
    "岗位内容",
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
        "#boss-pro-panel, #boss-settings-dialog, #boss-mini-icon, #guide-overlay, #guide-tooltip",
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

    const root =
      this.findDetailByClass() || this.findDetailByAnchor() || this.findDetailByViewport();
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
      // 先看子节点数再看文本：textContent 会遍历整棵子树，不能对全页元素做
      if (el.childElementCount > 3) continue;
      const text = (el.textContent || "").replace(/\s+/g, "");
      if (!text || text.length > 12) continue;
      if (this.DESC_TITLES.indexOf(text) === -1) continue;
      if (this.isOwnElement(el) || this.isJobCardArea(el)) continue;

      const parent = el.parentElement;
      if (!parent || this.isOwnElement(parent) || this.isJobCardArea(parent)) continue;
      // 正文通常和标题同级（同一个 section 里），取父容器
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
      [0.85, 0.45],
    ];

    for (const point of points) {
      let el = null;
      try {
        el = document.elementFromPoint(Math.round(w * point[0]), Math.round(h * point[1]));
      } catch (e) {}
      if (!el || this.isOwnElement(el) || this.isJobCardArea(el)) continue;
      // 落点不在右半屏 → 说明右栏在这个位置是空的，换下一个取点
      if (el.getBoundingClientRect().left < w * 0.35) continue;

      let best = el;
      for (let i = 0; i < 12 && el.parentElement; i++) {
        const parent = el.parentElement;
        if (parent === document.body || parent === document.documentElement) break;
        const rect = parent.getBoundingClientRect();
        if (rect.width < 200) break;
        if (rect.left < w * 0.35) break; // 越出右半屏就停，免得把整页吞进来
        if (this.isJobCardArea(parent)) break;
        best = parent;
        el = parent;
      }
      // 兜底再查一次：候选里带着职位卡片的，一律不是详情区
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
      "[class*='position-name']",
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
    // 认不出描述块就退化成整个详情区的文本：宁可多给 AI 一点上下文，也别给空
    if (description.length < 30) description = (root.textContent || "").trim();

    return { title: title, description: this.cleanDetailText(description), root: root };
  },

  /** 详情文本清洗 + 限长，避免把整页塞进 prompt */
  cleanDetailText(text) {
    return String(text || "")
      .replace(/[​-‍﻿]/g, "")
      .replace(/[ \t 　]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim()
      .slice(0, 3000);
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
    const check = () => {
      const api = this.pickApiDetail(title, since);
      if (api && api.description) return "api";

      const cur = this.detailSignature();
      if (!cur) return null; // 详情区还没渲染出内容
      if (title && this.sameTitle(cur.split("\n")[0], title)) return "dom"; // 标题对上最可靠
      if (cur !== prevSignature) return "dom"; // 内容变了也算切过去了
      return null;
    };

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
    const title = titleEl ? titleEl.textContent.trim() : "未知职位";
    const label = `[${index + 1}/${total}] ${title}`;

    // 节点可能已被 React 重新渲染替换，按标识重新查一次
    let liveCard = jobId ? this.findCardById(jobId) : card;
    if (!liveCard) liveCard = card;

    // 1) 打开详情，并等右侧真的切到这个岗位（判定和按钮状态都以它为准）
    const prevDetail = this.detailSignature();
    const since = Date.now();
    liveCard.scrollIntoView({ behavior: "smooth", block: "center" });
    await this.delay(300);
    this.simulateClickSync(liveCard);
    const syncSource = await this.waitForJobDetail(title, prevDetail, since);
    await this.delay(CONFIG.DELAYS.MEDIUM_SHORT);

    // 2) 不花 token 的过滤，先做掉
    if (this.isCardAlreadyGreeted(liveCard)) {
      state.stats.skipped++;
      refreshStatsUI();
      this.log(`${label} 已沟通过，跳过`);
      return false;
    }

    const activeTime = this.getRecruiterActiveTime();
    const filter = Array.isArray(settings.recruiterActivityStatus)
      ? settings.recruiterActivityStatus
      : [];
    // 空数组按「不限」兜底：没有选择任何状态时不应该把所有岗位都过滤掉
    const hasStatusFilter = filter.length > 0 && !filter.includes("不限");
    if (hasStatusFilter && !filter.includes(activeTime)) {
      state.stats.skipped++;
      refreshStatsUI();
      this.log(`${label} 跳过：招聘者状态「${activeTime}」不在筛选范围内`);
      return false;
    }

    // 3) AI 判定：符合才投，判不出来一律按跳过处理
    const jobInfo = this.extractJobDetail(title, since, syncSource);
    jobInfo.title = jobInfo.title || title;
    state.currentJobTitle = jobInfo.title;

    // 没有岗位要求就别问 AI 了：模型只会回一句"信息不足"，白花一次调用
    if (!jobInfo.description || jobInfo.description.length < 20) {
      state.stats.failed++;
      refreshStatsUI();
      this.log(`${label} ⚠️ 没抓到岗位要求，跳过以免误判`);
      this.logDetailDiagnostic();
      return false;
    }

    const verdict = await this.judgeJob(jobInfo);
    if (!verdict.match) {
      state.stats.skipped++;
      refreshStatsUI();
      this.log(`${label} ❌ 跳过：${verdict.reason}`);
      return false;
    }
    this.log(`${label} ✅ 通过：${verdict.reason}`);

    // 4) 找「立即沟通」按钮：优先卡片自带的（节点稳定，不会被上一个岗位的详情污染），
    //    卡片上没有才去详情区找
    let chatBtn = this.getCardChatButton(liveCard);
    if (!chatBtn || !this.isGreetButton(chatBtn.textContent)) {
      const detailBtn = this.findChatButton();
      if (detailBtn && this.isGreetButton(detailBtn.textContent)) chatBtn = detailBtn;
    }

    if (!chatBtn) {
      state.stats.failed++;
      refreshStatsUI();
      this.log(`${label} 未找到「立即沟通」按钮，可能页面结构已变化`);
      return false;
    }
    if (!this.isGreetButton(chatBtn.textContent)) {
      state.stats.skipped++;
      refreshStatsUI();
      this.log(`${label} 按钮文案为「${this.normalizeBtnText(chatBtn.textContent)}」，跳过`);
      return false;
    }

    // 5) 执行沟通
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
            CONFIG.STORAGE_LIMITS.PROCESSED_HRS,
          );
        } catch (e) {}
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

    // 优先尝试站内接口（可选，默认关闭：接口易变且风控风险更高）
    if (settings.useApiApply) {
      const info = this.extractJobInfo(card);
      let sec = APIInterceptor.getCurrentSecurityId();
      if (!sec && info && info.securityId) {
        sec = { securityId: info.securityId, lid: info.lid, jobId: info.jobId };
      }
      if (sec && sec.securityId) {
        try {
          await this.sendFriendRequest(
            sec.jobId || (info && info.jobId) || "",
            sec.securityId,
            sec.lid || "",
          );
          this.log(`${label} 已通过站内接口发起沟通`);
          return true;
        } catch (e) {
          this.log(`${label} 接口方式失败（${e.message}），回退到模拟点击`);
        }
      }
    }

    // 模拟点击
    await this.simulateClick(chatBtn);

    const result = await this.waitApplyResult(beforeText, chatBtn);

    if (!result.ok) {
      this.log(`${label} 沟通结果未知：没有检测到成功提示，也未看到按钮变化`);
      return false;
    }

    // 招呼语不在这里发：点击「立即沟通」时 BOSS 已经用它自己配置的招呼语发过一条了，
    // 列表页上也没有可写入的 IM 输入框（那套选择器只在聊天页成立）。
    // 想用自定义内容，去 BOSS 设置页配「打招呼语」，或到聊天页按打招呼列表发后续消息。
    await this.closeGreetingModal();
    return true;
  },

  /** 等待投递结果：按钮文案变化 / 弹窗 / 出现聊天输入框 / toast 提示 */
  async waitApplyResult(beforeText, clickedBtn, timeout = 8000) {
    const start = Date.now();
    const before = this.normalizeBtnText(beforeText);

    while (Date.now() - start < timeout) {
      // 1) 被点的按钮文案变化（立即沟通 → 继续沟通）
      if (clickedBtn && clickedBtn.isConnected) {
        const now = this.normalizeBtnText(clickedBtn.textContent);
        if (now && now !== before) return { ok: true, reason: "button-changed" };
      }

      // 2) 出现打招呼弹窗
      const modal = document.querySelector(
        '.greet-boss-dialog, .dialog-container, .dialog-wrap, [class*="greet"][class*="dialog"]',
      );
      if (modal) return { ok: true, reason: "modal" };

      // 3) 出现聊天输入框（说明已进入沟通）
      if (
        document.querySelector(
          "#chat-input, .chat-input, .input-area textarea, .chat-input-box textarea",
        )
      ) {
        return { ok: true, reason: "chat-opened" };
      }

      // 4) 全局 toast 提示
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
    const findStayBtn = () =>
      Array.from(
        document.querySelectorAll(
          ".default-btn.cancel-btn, .dialog-container button, .greet-boss-dialog button, .dialog-wrap button",
        ),
      ).find((b) => {
        const t = (b.textContent || "").replace(/\s+/g, "");
        return t === "留在此页" || t === "取消" || t === "稍后" || t === "关闭" || t === "知道了";
      });

    try {
      await this.delay(600);
      const stay = await this.waitForElement(findStayBtn, CONFIG.OPERATION_INTERVAL);
      if (!stay) return;
      await this.simulateClick(stay);
      await this.delay(400);
    } catch (e) {}
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
      } catch (e2) {}
    }
  },

  async handleChatPage() {
    const latestChatLi = await this.waitForElement(this.getLatestChatLi);
    if (!latestChatLi) return;

    const nameEl = latestChatLi.querySelector(".name-text");
    const companyEl = latestChatLi.querySelector(".name-box span:nth-child(2)");
    const name = (nameEl?.textContent || "未知").trim();
    const company = (companyEl?.textContent || "").trim();
    const hrKey = `${name}-${company}`.toLowerCase();

    // 同一个顶部会话在 observer 正常时不要每轮重复处理
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
      // BOSS 切换会话时会整体替换 .chat-message，DOMCache 里的旧节点不能再用
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
    } catch (e) {}
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
    if (uid !== undefined && uid !== null && String(uid) !== "") {
      return String(uid) === "0" ? "" : `uid:${uid}`;
    }
    if (info.encryptBossId) return `boss:${info.encryptBossId}`;
    return this.legacyHrKeyFromInfo(info);
  },

  /** 旧账本键，仅用于兼容与日志 */
  legacyHrKeyFromInfo(info) {
    if (!info) return "";
    const name = info.name || "未知";
    const company = info.brandName || info.company || "";
    return `${name}-${company}`.toLowerCase();
  },

  chatDisplayName(info) {
    if (!info) return "未知";
    const name = info.name || "未知";
    const company = info.brandName || info.company || "";
    return company ? `${name} / ${company}` : name;
  },

  toConversationTarget(info) {
    return {
      uid: info.uid,
      encryptBossId: info.encryptBossId,
      name: info.name || "未知",
      company: info.brandName || info.company || "",
      ledgerKey: this.conversationKey(info),
      legacyKey: this.legacyHrKeyFromInfo(info),
    };
  },

  getFriendInfoByUid(uid) {
    const store = this.getChatStore();
    if (!store || !store.friendInfos || uid === undefined || uid === null) return null;
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
        done: false,
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
      (f) => f && this.conversationKey(f),
    );
    const byUid = new Map(infos.map((f) => [String(f.uid), f]));
    const friends = Array.isArray(store.friends) ? store.friends : [];
    const order = [];
    const seen = new Set();

    const push = (info) => {
      const key = this.conversationKey(info);
      if (!key || seen.has(key)) return;
      seen.add(key);
      order.push({
        key,
        uid: info.uid,
        name: info.name || "未知",
        company: info.brandName || info.company || "",
        info,
      });
    };

    for (const uid of friends) {
      const info = byUid.get(String(uid));
      if (info) push(info);
    }
    infos
      .slice()
      .sort((a, b) => Number(b.lastTS || 0) - Number(a.lastTS || 0))
      .forEach(push);

    scan.order = order;
    this.log(`自动轮询：共 ${order.length} 个会话，从头到尾打开一遍`);
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
    this.log(`自动轮询完成：已遍历 ${scan.processed}/${scan.order.length} 个会话`);
    if (state.isRunning) {
      toggleChatProcess();
    }
  },

  async handleChatPageAuto() {
    const store = this.getChatStore();
    if (!store || !store.friendInfos) {
      if (!this.chatStoreWarned) {
        this.chatStoreWarned = true;
        this.log("未检测到 chatStore，自动轮询回退为「只看顶部会话」");
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
    this.log(`自动轮询 [${position}/${scan.order.length}]：${label}`);

    try {
      let li = this.findConversationLi(info);
      if (!li) {
        // 可能是虚拟滚动：按遍历进度滚到大致位置，再找一次
        this.scrollChatListToRatio(position - 1, scan.order.length);
        await this.delay(300);
        li = this.findConversationLi(info);
      }
      if (!li) {
        this.log(`未在会话列表中找到 ${label}，跳过`);
        return;
      }

      const clickTarget = li.querySelector(".friend-content") || li.querySelector(".figure") || li;
      await this.simulateClick(clickTarget);

      // 有的版本把点击处理挂在头像上：第一次没切过去就再点头像试一次
      let switched = await this.waitForConversationSwitch(info, CONFIG.OPERATION_INTERVAL);
      if (!switched) {
        const figure = li.querySelector(".figure");
        if (figure && figure !== clickTarget) {
          await this.simulateClick(figure);
          switched = await this.waitForConversationSwitch(info, CONFIG.OPERATION_INTERVAL);
        }
      }
      if (!switched) {
        this.log(`打开会话超时：${label}，继续下一个`);
        return;
      }

      // 切换会话时 BOSS 会整体替换 .chat-message，旧缓存必须清掉
      DOMCache.clear();

      await this.delay(CONFIG.DELAYS.MEDIUM_SHORT);
      await HRInteractionManager.handleHRInteraction(this.toConversationTarget(info));
    } catch (e) {
      this.log(`自动轮询处理 ${label} 出错：${e.message}`);
    }
  },

  /** 虚拟列表兜底：按当前进度把会话列表滚到大致位置 */
  scrollChatListToRatio(index, total) {
    try {
      const el = document.querySelector(".user-list-content");
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      el.scrollTop = Math.floor((index / Math.max(total, 1)) * max);
    } catch (e) {}
  },

  findConversationLi(info) {
    const items = Array.from(
      document.querySelectorAll('.user-list-content ul[role="group"] li[role="listitem"]'),
    );
    if (!items.length) return null;

    // 探测报告：列表全量渲染，chatStore.friends 的顺序与 DOM 一致
    try {
      const store = this.getChatStore();
      const friends = store && Array.isArray(store.friends) ? store.friends : [];
      const index = friends.findIndex((uid) => String(uid) === String(info.uid));
      if (index >= 0 && items[index] && this.liMatchesInfo(items[index], info)) {
        return items[index];
      }
    } catch (e) {}

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

    const check = () => {
      const selected = document.querySelector(".user-list-content .friend-content.selected");
      if (!selected) return false;

      const selectedName = (selected.querySelector(".name-text")?.textContent || "").trim();
      if (targetName && selectedName !== targetName) return false;

      // 不再用 chatStore.friends 的数组下标校验 uid：线上列表顺序与 friends
      // 不一定一致（置顶、系统行都会让下标错位），会导致永远等不到切换。
      // 选中项昵称 + 内容信号已经足够；同名会话由 findConversationLi 的顺序映射负责。
      const chat = document.querySelector(".chat-message");
      if (!chat) return false;

      const position = (document.querySelector(".position-name")?.textContent || "").trim();
      const hasMessage = !!chat.querySelector(".im-list li[data-mid]");
      // 没有岗位名也没有消息时不能采信：可能是上一个会话的残留内容
      return !!(position || hasMessage);
    };

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
          hasNewFriendMessage = Array.from(mutation.addedNodes).some((node) =>
            node.classList?.contains("item-friend"),
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
      subtree: true,
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
      const shouldSendResumeOnly = cleanedMessage.includes("简历");

      if (cleanedMessage === this.lastProcessedMessage) return;

      this.lastProcessedMessage = cleanedMessage;
      // 这里只是收到一条 HR 消息，与"同意交换"无关（旧文案会误导排查）
      this.log(`收到 HR 消息：${lastMessage}`);

      await this.delay(CONFIG.DELAYS.MEDIUM_SHORT);
      const updatedMessage = await this.getLastFriendMessageText();
      if (updatedMessage && this.cleanMessage(updatedMessage) !== cleanedMessage) {
        await this.handleNewMessage(hrKey);
        return;
      }

      const autoSendResume = settings.useAutoSendResume;

      if (shouldSendResumeOnly && autoSendResume) {
        this.log('对方提到"简历"，正在发送简历');
        const sent = await HRInteractionManager.sendResume();
        if (sent) {
          StorageManager.addRecordWithLimit(
            CONFIG.STORAGE_KEYS.SENT_RESUME_HRS,
            hrKey,
            state.hrInteractions.sentResumeHRs,
            CONFIG.STORAGE_LIMITS.SENT_RESUME_HRS,
          );
          this.log(`已向 ${hrKey} 发送简历`);
        }
      } else {
        // AI 回复已移除；新消息仍走统一的跟进逻辑（交换卡片 / 简历）
        await HRInteractionManager.handleHRInteraction(hrKey);
      }

      await this.delay(CONFIG.DELAYS.MEDIUM_SHORT);
    } catch (error) {
      this.log(`处理消息出错: ${error.message}`);
    } finally {
      this.processingMessage = false;
    }
  },

  cleanMessage(message) {
    if (!message) return "";

    let clean = message.replace(/<[^>]*>/g, "");
    clean = clean
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "");
    return clean;
  },

  getLatestChatLi() {
    return document.querySelector(
      'ul[role="group"] li[role="listitem"][class]:has(.friend-content-warp)',
    );
  },

  /** 详情区里的技能标签（BOSS 各版本 class 名不一，命中不到就算了） */
  readSkillTags() {
    try {
      const tags = document.querySelectorAll(
        ".job-tag-box .tag-item, .job-tags .tag-item, .job-keyword-list .tag-item",
      );
      return tags.length
        ? Array.from(tags)
            .map((x) => x.textContent.trim())
            .filter(Boolean)
            .join("、")
        : "";
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
      source = "接口";
    } else if (syncSource === "dom") {
      const dom = this.readDetail();
      domTitle = dom.title;
      if (dom.description) {
        description = dom.description;
        source = "详情区";
      }
      const skills = this.readSkillTags();
      if (skills) description = [description, "技能：" + skills].filter(Boolean).join("\n");
    }

    return {
      title: (api && api.title) || domTitle || title || state.currentJobTitle || "",
      description: this.cleanDetailText(description),
      source: source,
    };
  },

  /** 抓不到岗位要求时，把"到底看到了什么"写进日志，便于反馈是接口还是 DOM 的问题 */
  logDetailDiagnostic() {
    try {
      const api = APIInterceptor.lastJobDetail;
      const apiInfo = api
        ? `接口最后返回「${api.title || "?"}」（描述 ${(api.description || "").length} 字）`
        : "没收到 detail.json 的响应";

      const root = this.findDetailRoot();
      let rootInfo = "没定位到右侧详情区";
      if (root) {
        const cls = String(root.className || "")
          .split(" ")
          .filter(Boolean)[0];
        rootInfo = `详情区根节点 ${root.tagName.toLowerCase()}${cls ? "." + cls : ""}（正文 ${(root.textContent || "").trim().length} 字）`;
      }

      this.log(`　诊断：${apiInfo}；${rootInfo}`);
      console.warn("[BOSS投递助手] 岗位要求抓取诊断", { api: api, root: root });
    } catch (e) {}
  },

  /**
   * 从模型返回里抠出判定结果。兼容 ```json 包裹、以及前后夹带解释文字的情况。
   * 任何一步失败都返回 match:false —— 判不出来就不投，避免误投。
   */
  parseAiVerdict(text) {
    const fail = (reason) => ({ match: false, reason: reason });

    if (!text || !String(text).trim()) return fail("AI 未返回内容");

    const raw = String(text)
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return fail("AI 未返回 JSON");

    let obj;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch (e) {
      return fail("AI 返回的 JSON 无法解析");
    }

    const match = obj.match === true || obj.match === "true";
    const reason = String(obj.reason || "").trim() || (match ? "符合投递要求" : "不符合投递要求");

    return { match: match, reason: reason };
  },

  /**
   * 一次 LLM 调用完成「是否投递」的判定。
   * 请求失败一律返回 match:false，由调用方记为跳过。
   */
  async judgeJob(jobInfo) {
    // 岗位标题/要求走内置变量注入；简历、投递要求等由用户配的片段提供。
    // 没填的占位符会原样留在 prompt 里 —— 启动时已经提醒过一次（见 startProcessing），
    // 这里不再逐岗位重复刷日志。
    const { text: prompt } = renderPrompt(settings.promptTemplate || PROMPT_TEMPLATE_DEFAULT, {
      jobTitle: jobInfo.title || "",
      jobDescription: jobInfo.description || "",
    });

    try {
      const txt = await this.requestAi(prompt, AI_JUDGE_SYSTEM_ROLE, {
        temperature: 0.3,
        maxTokens: 800,
        label: `判定「${jobInfo.title || "未知职位"}」`,
      });
      return this.parseAiVerdict(txt);
    } catch (e) {
      return { match: false, reason: `AI 判定失败（${e.message}）` };
    }
  },
  getPositionName() {
    try {
      const positionNameElement =
        Core.getCachedElement(".position-name", true) ||
        Core.getCachedElement(".job-name", true) ||
        Core.getCachedElement('[class*="position-content"] .left-content .position-name', true) ||
        document.querySelector(".position-name") ||
        document.querySelector(".job-name");

      if (positionNameElement) {
        return positionNameElement.textContent.trim();
      } else {
        // Silent failure is better here as we might check multiple times
        return "";
      }
    } catch (e) {
      Core.log(`获取岗位名称出错: ${e.message}`);
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
    const retries = opts.retries === undefined ? CONFIG.API.RETRY_COUNT : opts.retries;
    const authToken = settings.aiApiKey || "";
    const apiUrl = settings.aiApiUrl || "https://api.deepseek.com/v1/chat/completions";

    if (!apiUrl) throw new Error("未配置 API 地址");

    // 判定等场景由调用方传入 systemRole；连接测试没传，用一句通用角色兜底
    const systemContent = systemRole || "你是一个乐于助人的助手。";

    const requestBody = {
      model: settings.aiModel || "deepseek-chat",
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: message },
      ],
      // 判定场景要的是稳定可解析的 JSON，所以允许调用方压低温度、抬高 token 上限
      temperature: opts.temperature === undefined ? 0.9 : opts.temperature,
      top_p: 0.8,
      max_tokens: opts.maxTokens || 512,
      stream: false,
    };

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        this.log(`AI 请求失败，${CONFIG.API.RETRY_DELAY}ms 后重试（${attempt}/${retries}）`);
        await this.delay(CONFIG.API.RETRY_DELAY);
      }
      try {
        const text = await this._doRequest(apiUrl, authToken, requestBody);
        if (text) return text;
      } catch (e) {
        lastError = e;
        // 鉴权/额度类错误重试无意义，直接抛出
        if (/401|403|402|余额|额度|无效|Unauthorized/i.test(e.message)) break;
      }
    }
    throw lastError || new Error("AI 请求失败");
  },

  _doRequest(apiUrl, authToken, requestBody) {
    return new Promise((resolve, reject) => {
      const finish = (fn, arg) => {
        try {
          fn(arg);
        } catch (e) {
          console.error(e);
        }
      };

      if (typeof GM_xmlhttpRequest !== "function") {
        return reject(new Error("当前脚本管理器未授予跨域请求权限（GM_xmlhttpRequest）"));
      }

      GM_xmlhttpRequest({
        method: "POST",
        url: apiUrl,
        timeout: CONFIG.API.TIMEOUT,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + (authToken || ""),
        },
        data: JSON.stringify(requestBody),
        onload: (response) => {
          const status = response.status;
          const body = response.responseText || "";

          // 解析响应
          let result = null;
          try {
            result = JSON.parse(body);
          } catch (e) {
            return finish(
              reject,
              new Error(`接口返回了非 JSON 内容（HTTP ${status}）：${body.slice(0, 120)}`),
            );
          }

          // 兼容 OpenAI 格式与部分中转站的 {code,message} 格式
          const choice =
            (result && result.choices && result.choices[0]) ||
            (result.data && result.data.choices && result.data.choices[0]);

          if (choice && choice.message && choice.message.content) {
            return finish(resolve, String(choice.message.content).trim());
          }

          if (status < 200 || status >= 300) {
            const msg = (result && (result.error?.message || result.message)) || `HTTP ${status}`;
            return finish(reject, new Error(msg));
          }
          if (result && result.code !== undefined && result.code !== 0) {
            return finish(
              reject,
              new Error(`${result.message || "接口返回错误"}（code: ${result.code}）`),
            );
          }

          return finish(reject, new Error("无法识别的接口返回格式：" + body.slice(0, 160)));
        },
        onerror: () => finish(reject, new Error("网络请求失败，请检查 API 地址与网络")),
        ontimeout: () => finish(reject, new Error(`请求超时（${CONFIG.API.TIMEOUT / 1000}s）`)),
      });
    });
  },

  async getLastFriendMessageText() {
    try {
      const chatContainer = DOMCache.get(".chat-message .im-list");
      if (!chatContainer) return null;

      const friendMessages = Array.from(
        chatContainer.querySelectorAll("li.message-item.item-friend"),
      );
      if (friendMessages.length === 0) return null;

      const lastMessageEl = friendMessages[friendMessages.length - 1];
      // 真实页面正文是 <p><span class="text-content">…</span></p>；
      // 旧版的 ".text span" 也能命中，但会误伤状态/时间等 span，所以优先精确选择器。
      const textEl =
        lastMessageEl.querySelector(".text-content") || lastMessageEl.querySelector(".text span");
      return textEl?.textContent?.trim() || null;
    } catch (error) {
      ErrorHandler.handle(error, "Core.getLastFriendMessageText");
      this.log(`获取消息出错: ${error.message}`);
      return null;
    }
  },

  /** 当前会话里最后一条我方消息的文本；用于核对「网页已发出的打招呼语」 */
  async getLastSelfMessageText() {
    try {
      const chatContainer = DOMCache.get(".chat-message .im-list");
      if (!chatContainer) return null;

      const selfMessages = Array.from(
        chatContainer.querySelectorAll("li.message-item.item-myself"),
      );
      if (selfMessages.length === 0) return null;

      const lastMessageEl = selfMessages[selfMessages.length - 1];
      const textEl =
        lastMessageEl.querySelector(".text-content") || lastMessageEl.querySelector(".text span");
      return textEl?.textContent?.trim() || null;
    } catch (error) {
      ErrorHandler.handle(error, "Core.getLastSelfMessageText");
      this.log(`获取我方消息出错: ${error.message}`);
      return null;
    }
  },

  async simulateClick(element) {
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const dispatchMouseEvent = (type, options = {}) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: document.defaultView,
        clientX: x,
        clientY: y,
        ...options,
      });
      element.dispatchEvent(event);
    };

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

  async waitForElement(selectorOrFunction, timeout = 5000) {
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
      dict_load: 1.0,
      click: 0.8,
      selection: 0.8,
      default: 1.0,
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

      await this.delay(1000);

      const titleElement = document.querySelector("h3.title-wrap");

      if (titleElement) {
        titleElement.textContent = "请务必打开 打招呼语功能";
        titleElement.style.color = "red";
        titleElement.style.fontWeight = "bold";
        titleElement.style.fontSize = "18px";
      }

      const possibleSelectors = [
        "h4 .ui-switch",
        ".ui-switch",
        "span.ui-switch",
        "[class*='ui-switch']",
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
            possibleSelectors.find((s) => document.querySelector(s)),
          );
          if (newSwitchElement && newSwitchElement.classList.contains("ui-switch-checked")) {
            UI.notify("招呼语功能已启用", "success");
          } else {
            await this.simulateClick(switchElement);
            await this.delay(500);

            const finalSwitchElement = document.querySelector(
              possibleSelectors.find((s) => document.querySelector(s)),
            );
            if (finalSwitchElement && finalSwitchElement.classList.contains("ui-switch-checked")) {
              UI.notify("招呼语功能已启用", "success");
            } else {
              UI.notify("请手动启用招呼语功能", "warning");
            }
          }
        } else {
          UI.notify("招呼语功能已启用", "success");
        }
      } else {
        const allSwitches = document.querySelectorAll("[class*='switch']");
        allSwitches.forEach((el, index) => {
          this.log(`开关 ${index + 1}: ${el.className}, 文本: ${el.textContent?.trim()}`);
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
    this.log("所有岗位沟通完成，恭喜您即将找到理想工作！");
    state.currentIndex = 0;
  },

  log(message) {
    const logEntry = `[${new Date().toLocaleTimeString()}] ${message}`;
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
  },
};
