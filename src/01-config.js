/**
 * @typedef {Object} HRInteraction
 * @property {string} hrKey - HR唯一标识
 * @property {boolean} hasGreeted - 是否已打招呼
 * @property {boolean} hasSentResume - 是否已发送简历
 * @property {boolean} hasSentImageResume - 是否已发送图片简历
 */

/**
 * @typedef {Object} JobInfo
 * @property {string} jobId - 职位ID
 * @property {string} title - 职位标题
 * @property {string} company - 公司名称
 * @property {string} salary - 薪资范围
 * @property {string} location - 工作地点
 * @property {string} hrKey - HR标识
 */

/**
 * @typedef {Object} GreetingItem
 * @property {string} id - 问候语ID
 * @property {string} content - 问候语内容
 */

/**
 * @typedef {Object} ImageResume
 * @property {string} id - 图片简历ID
 * @property {string} name - 图片简历名称
 * @property {string} data - Base64编码的图片数据
 */

/**
 * @typedef {Object} ErrorInfo
 * @property {string} message - 错误消息
 * @property {string} stack - 错误堆栈
 * @property {string} context - 错误上下文
 * @property {string} timestamp - 时间戳
 */

export const CONFIG = {
  BASIC_INTERVAL: 1000,
  OPERATION_INTERVAL: 1200,

  DELAYS: {
    SHORT: 30,
    MEDIUM_SHORT: 200,
  },
  STORAGE_KEYS: {
    PROCESSED_HRS: "processedHRs",
    SENT_GREETINGS_HRS: "sentGreetingsHRs",
    SENT_RESUME_HRS: "sentResumeHRs",
    SENT_IMAGE_RESUME_HRS: "sentImageResumeHRs",
  },
  STORAGE_LIMITS: {
    PROCESSED_HRS: 500,
    SENT_GREETINGS_HRS: 500,
    SENT_RESUME_HRS: 300,
    SENT_IMAGE_RESUME_HRS: 300,
  },

  API: {
    TIMEOUT: 20000,
    RETRY_COUNT: 3,
    RETRY_DELAY: 1000,
  },

  // 聊天页「自动轮询」= 一次单向全量遍历：从 chatStore.friends 的第一条到底部，
  // 每条会话打开一次，到尾部自动停止（来自实机探测）。
  // 每次调用最多连续打开 MAX_SWEEP_PER_CALL 个，之间停 SWEEP_DELAY；
  // 两次调用之间停 POLL_INTERVAL，避免把 BOSS 的接口打得太密。
  CHAT: {
    POLL_INTERVAL: 2500,
    MAX_SWEEP_PER_CALL: 5,
    SWEEP_DELAY: 400,
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
    PANEL_HIDDEN_TRANSFORM: "translateY(calc(100vh + 100px))",
  },

  PERFORMANCE: {
    DOM_CACHE_MAX_AGE: 5000,
    BATCH_SIZE: 10,
    CONCURRENT_LIMIT: 3,
  },

  // 单次运行的安全上限，避免被风控
  SAFETY: {
    MAX_APPLY_PER_RUN: 50,
    MAX_SCROLL_STEPS: 30,
    APPLY_INTERVAL: 2500,
  },
};

/* =========================================================================
 * 页面识别 —— v2.1.0 修复点
 * 旧版全部使用 location.pathname.includes("/jobs") 判断，
 * 但 BOSS 搜索结果页的实际地址是 /web/geek/job（无 s），
 * 导致 Core.startProcessing 里两个分支都不命中：脚本"只是在找，不会投递"。
 * ========================================================================= */
export const PAGE = {
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
    return (
      /\/web\/geek\/jobs?(\/|$)/.test(p) ||
      /\/web\/geek\/recommend/.test(p) ||
      /\/web\/geek\/job-list/.test(p) ||
      PAGE.isJobDetail()
    );
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
  },
};
