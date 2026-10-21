# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

BOSS 直聘「BOSS投递助手」Tampermonkey 用户脚本（v2.4.0，作者 wok）。
`src/` 是真正的 ES module，由 esbuild 打包成根目录的 **`boss-quick-apply.user.js`**。
构建产物**必须提交**，路径不能改。

项目图标是根目录 `icon.png`，以 base64 内嵌在 `05-ui.js`，用于面板标题和悬浮球。

**动手前先读 [`src/README.md`](src/README.md)**，里面记录了模块化的硬规则和隐形不变量。

## 常用命令

```bash
npm install
npm run build          # src/ → boss-quick-apply.user.js
npm run check          # 构建 + node --check（语法检查）
npm test               # 冒烟 + 投递流程 + 设置/提示词 + 聊天打招呼 + 自动轮询（5 个套件）
npm run test:flow      # 只跑投递流程
npm run test:settings  # 只跑设置与提示词编辑器
npm run test:chat      # 只跑聊天页（打招呼/卡片 + 自动轮询）
node test/apply-flow.test.js none   # 只跑某个场景：api|weird|anchor|plain|none
npm run deps           # 打印 ES module 依赖图与环（--json 可机器读）
npm run format         # Prettier 写入（src、test、tools、build.js）
npm run format:check
npm run verify -- 旧版本.js 新版本.js   # 行为比对
```

没有 ESLint，只有 Prettier。Markdown 不在格式化范围内。

**测试读的是构建产物，不是 `src/`**：改完源码必须先 `npm run build` 再跑测试。
测试是 Playwright 驱动的真实 Chromium，没有测试框架；每个文件是独立 node 脚本，
自己 `check()` 计数，靠退出码表示成败。

## 架构：两套页面

`01-config.js` 的 `PAGE` 按 URL 分流，`05-ui.js` 渲染两套面板：

| 页面                        | 入口                                                            | 干什么                                                                |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| 职位列表 `/web/geek/job(s)` | `toggleProcess()` → `Core.startProcessing()`                    | 滚动收集卡片 → 逐个抓详情 → 交给 AI 判定 → 通过才点「立即沟通」       |
| 聊天 `/web/geek/chat`       | `toggleChatProcess()` → `Core.startProcessing()`（另一个分支）  | 「仅新消息」只看顶部一条；「自动轮询」从列表顶到底全量遍历一遍，到尾部停止 |

两者靠 `state.isRunning` 各自独立运行，**代码层面没有跨窗口通信**
（无 `storage` 事件、无 `BroadcastChannel`）。唯一联系是 BOSS 服务器把新会话推到聊天列表顶部。

聊天页两条路径：

- **仅新消息**：身份 `hrKey = 名字-公司`，只看会话列表顶部一条；
- **自动轮询**：读取 `window.chatStore.friendInfos`，按 `chatStore.friends` 顺序
  （缺失时按 `lastTS` 倒序）做一次快照，**从第一条到底部逐条打开、处理，每条只走一次，
  到尾部自动停止**。不筛选「新会话 / 未读 / 新消息」，也不随机滚动。
  **打开会话即标已读**；只有「最后一条我方消息 == 打招呼列表第 1 行」的会话才会收到
  列表第 2 行及以后的后续消息（首次沟通没有开关；不一致的不发也不记账）。

三本账（`sentGreetingsHRs` / `sentResumeHRs` / `sentImageResumeHRs`）新写入
`uid:<uid>`，读取兼容旧的「名字-公司」。Set 只在页面加载时从 localStorage 读一次。
聊天页的数据源不是列表 DOM：没有稳定 id；`window.chatStore` 在 Tampermonkey 沙箱里
要经 `unsafeWindow`（退化到 `document.defaultView`）读取。

### 聊天页当前的四种消息动作

1. 打招呼列表第 2 行及以后（首行必须匹配）
2. 附件简历
3. 图片简历
4. 交换卡片按开关点「同意」（默认关闭）

`HRInteractionManager.handleHRInteraction()` 的决策树：

```
没打过招呼 → 首次沟通：首行匹配后发后续消息，再按开关发简历
两本简历账未齐 → HR 已回复才跟进：先卡片，再按「简历」关键词发简历
两本简历账都齐 → 无动作
```

**AI 自动回复、沟通岗位关键词过滤、测试模式、AI 角色定位、导出 AI 日志、
设置标签页都已移除，不要加回来。** 列表页也不发送自定义招呼语：
点「立即沟通」的瞬间 BOSS 已经用它自己的招呼语发过第一条，脚本拦不住；
招呼语后续消息只在聊天页按上面的规则生效。

## 模块图与启动

模块图里有两个环，`tools/dep-graph.js` 当前输出：

- 6 模块主环：`03-infra ⇄ 04-hr-interaction ⇄ 05-ui ⇄ 07-settings-dialog ⇄ 08-core ⇄ 09-process`
- 2 模块小环：`13-greetings ⇄ 15-settings-deferred`
- `main.js` 和 `12-entry.js` 不在任何环里。

- **启动只能由 `main.js` 的 `start()` 触发**，绝不能在模块顶层调用 `init()`。
  曾经真实踩过：`StatePersistence is undefined`，整个脚本静默失效。
- 环内模块的求值顺序由打包器决定，不要写依赖它的代码。
- 不要在模块顶层加副作用。仅有的历史例外：`06-settings.js` 加载配置、
  `11-guide.js` 注入样式。
- `main.js` 用**纯副作用 import** 按原片段顺序引入所有模块，顺序即契约。

## 隐形不变量

- **`state.settings === settings` 是同一个对象**。`saveSettings()` 靠 `Object.assign`
  同步；二者指向不同对象时，通过 `state.settings.*` 写的值会落到孤儿对象上。
- `settings` 上有 `settings.ai`、`settings.actionDelays` 两个 `Object.defineProperty`
  兼容层；对象展开或 JSON 克隆重建 `settings` 会丢掉它们。
- 猴补丁只打一次：`XMLHttpRequest.prototype`（`03-infra.js`）、
  `history.pushState/replaceState`（`12-entry.js`）。重复求值会叠加包装。
- 打包器会 tree-shake 未被 import 的导出（`11-guide.js` 的 `guide` 对象目前就是这样
  被摇掉的 —— 想用必须真的 `import` 它）。
- 模板字符串里的空白是内容，不是排版。`05-ui.js` / `07-settings-dialog.js` /
  `11-guide.js` 里的大段 CSS/HTML 不要随手重排。
- `03-infra.js` 的 `StatePersistence` 只有 `loadState()`（恢复图片简历/招呼语和存储上限），
  没有 `saveState()`；配置一律显式走 `saveSettings()`。

## 抓取详情区

v2.2.0 因为写死 `.job-detail-box` 这组 class，线上全部落空、48 个岗位一个没投出去。
现在的三级兜底：`detail.json` 接口（`APIInterceptor`）→ 语义锚点（「职位描述」小标题）
→ 视口右半屏。

- 详情区有渲染延迟，会"串岗"：**只有 `waitForJobDetail()` 返回 `"dom"` 时才允许采信 DOM**，
  `null` 说明还没切过来，宁可跳过也不能拿上一个岗位的内容判定。
- 「已沟通过」只认卡片自带的按钮（`isCardAlreadyGreeted`），别读详情区。
- 视口兜底里 `isOwnElement()` / `isJobCardArea()` 三个校验一个都不能删 ——
  我们自己的面板 fixed 贴在右边，`elementFromPoint` 会取到它。

## AI 判定

- `system` = 常量 `AI_JUDGE_SYSTEM_ROLE`（`06-settings.js`），固定 JSON 契约
  `{"match","reason"}`，**用户改不了**。改坏它 = `parseAiVerdict()` 一律返回
  `match:false` = 一个岗位都投不出去，而且日志里没有任何报错。
- `user` = `renderPrompt(settings.promptTemplate, {jobTitle, jobDescription})`。
  可用变量**只有这两个**；其它 `{xxx}` 原样发给 AI，启动时提醒一次
  （`judgeJob()` 里不要重复报，否则每个岗位刷一行）。
- 任何解析失败都返回 `match:false` —— 判不出来就不投。
- 招聘者状态为空时按「不限」处理；但设置 UI 不允许把「不限」取消成空选。

## 设置与 UI

- 设置弹窗是**一个长页面，没有标签栏**，按分组依次排列：
  AI API 配置 / 投递提示词 / 投递基础设置 / 打招呼设置 / 简历发送设置 / 其他。
- 主题色：设置页白底为主，蓝色点缀 `#1a73e8`；面板统一蓝色
  （`#1a73e8` / 背景 `#eff6ff` / 边框 `#dbeafe`）。
- 所有设置页文字按钮通过 `createSettingsButton()` 生成，统一 32px 高、
  4px 圆角、14px 字号；变体：primary / secondary / neutral / danger。
- 提示词不是独立设置页，而是「投递提示词」分组里的「编辑提示词」按钮，
  点开弹窗编辑器；文本框禁止拖拽缩放。
- 招聘者状态是右侧多选，没有清除 ×；选中项蓝字并在右侧打勾。

## 测试与验证的习惯

- `test/apply-flow.test.js` 是唯一能证明"真的投得出去"的测试：假页面 + 桩掉
  `GM_xmlhttpRequest`，断言 AI 实际收到了什么。fixture 故意用随机 class 名、
  不给「职位描述」小标题，逼代码走兜底路径。
- **改抓取逻辑时不要迁就 fixture，要迁就真实页面。** fixture 缺少真实页面会有的东西
  会让失败分支成为唯一被覆盖的路径。`apply-flow.test.js` 放了假 `#chat-input` +
  `.btn-send` 并断言列表页流程不碰它们。
- **修 bug 要做负向对照**：把 bug 临时改回构建产物，确认新断言会挂，再还原重建。
- `processOneJob()` 外层有 try/catch，残留的悬空调用会被吞成一行日志、不会触发
  `pageerror` —— 别指望"无未捕获错误"那类断言兜住删除类改动。
- **自动轮询的遍历逻辑要先跑 `test/chat-auto-poll.test.js`**：它用假 `chatStore` 覆盖
  「按顺序打开全部会话」「没有自动发送功能时仍然打开但不发」「到尾部自动停止」。
- **交换卡片默认不自动同意**：`handleCardMessage` 先看 `settings.autoAcceptCard`
  （默认 `false`），关闭时只记日志；`test/chat-greeting.test.js` 覆盖首行匹配与卡片开关。
- `test/settings-prompt.test.js` 盯着提示词迁移（唯一会静默丢用户数据的地方）和
  设置弹窗结构；不要删除这些场景。

## 设置持久化

`SettingsStore`（`06-settings.js`）**读全写全**。新增设置项时必须同时改
`load()` 的读取、`SETTINGS_DEFAULTS` 和 `save()`。

**配置变更一律显式调 `saveSettings()`**。加载老配置时，`inlinePromptVars` 会把
`promptVars` / 更老的 `userResume`、`aiApplyCriteria` 合并进主提示词正文；
这是唯一会静默丢用户数据的地方：合并结果必须**先落盘再删 `promptVars` 键**，
且 v2.2.x 回落路径必须用 `PROMPT_SECTIONS_LEGACY`。

## 构建产物与提交

改动源码后**必须** `npm run build` 并提交更新后的 `boss-quick-apply.user.js`。
验证"没改坏"用行为比对（`npm run verify`），不是逐字节相同 —— 打包器会重排、重命名。
`tools/ast-equivalent.js` 只在纯格式化 / 搬家类改动时还有用。
