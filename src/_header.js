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
