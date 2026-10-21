export const getStoredJSON = (key, defaultValue) => {
  try {
    const val = localStorage.getItem(key);
    return val ? JSON.parse(val) : defaultValue;
  } catch (e) {
    console.error(`Error parsing ${key}:`, e);
    return defaultValue;
  }
};

export const state = {
  isRunning: false,
  currentIndex: 0,

  jobList: [],

  ui: {
    isMinimized: false,
    theme: localStorage.getItem("theme") || "light",
  },

  hrInteractions: {
    processedHRs: new Set(getStoredJSON("processedHRs", [])),
    sentGreetingsHRs: new Set(getStoredJSON("sentGreetingsHRs", [])),
    sentResumeHRs: new Set(getStoredJSON("sentResumeHRs", [])),
    sentImageResumeHRs: new Set(getStoredJSON("sentImageResumeHRs", [])),
  },

  // 注意：这里只是占位，脚本加载后会被 state.settings = settings 覆盖为唯一配置对象
  settings: {},

  // 运行统计（面板底部展示）
  stats: {
    greeted: 0,
    skipped: 0,
    failed: 0,
    startTime: 0,
  },

  // 当前正在处理的职位标题，作为详情区取不到标题时的兜底
  currentJobTitle: "",

  comments: {
    currentCompanyName: "",
    commentsList: [],
    isLoading: false,
    isCommentMode: false,
  },

  securityIdCache: new Map(),
};

export const elements = {
  panel: null,
  controlBtn: null,
  log: null,
  miniIcon: null,
};
