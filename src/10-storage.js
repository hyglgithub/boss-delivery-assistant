/**
 * localStorage 里用到的键。
 *
 * 这里曾经还住着一封「致投递用户的一封信」—— v2.2.1 起整封删除：
 * 打开页面先弹一个全屏遮罩，用户每次升级都要手动关一次，反馈很明确。
 * 引导浮层（11-guide.js）也不再自动弹出，需要时手动调 guide.showGuideToUser()。
 */
export const STORAGE = {
  GUIDE: "shouldShowGuide",
  VISITED_GREET_SET: "hasVisitedGreetSet",
};
