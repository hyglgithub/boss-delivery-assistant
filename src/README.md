# src/ — 源码结构说明

**读这一页只需要 1 分钟，但能避免踩到本目录最大的坑。**

## 这是什么

`boss-quick-apply.user.js` 原本是单个 6500 行的文件，整体包在一个 IIFE 里。
现在它是真正的 **ES module**，按职责拆成若干文件，由 esbuild 打包成单文件 userscript。

```
main.js  →  按序 import 全部模块  →  最后调用 start()
```

`main.js` 是唯一入口，`build.js` 用 esbuild 打包，产物是根目录的 `boss-quick-apply.user.js`。

## 四条硬规则

### 1. 启动必须由 main.js 的 `start()` 触发，不能在模块顶层调用

模块图里**有两个环**，`08-core.js` 是主环中心：

```
03-infra ⇄ 04-hr-interaction ⇄ 05-ui ⇄ 07-settings-dialog
         ⇄ 08-core ⇄ 09-process

13-greetings ⇄ 15-settings-deferred
```

在模块顶层直接 `init()` 会在依赖尚未初始化时执行 —— 这正是重构过程中
真实踩到的坑，表现为 `StatePersistence is undefined`，**整个脚本静默失效**。

`main.js` 不在任何环里，所以它体内的 `start()` 一定发生在其全部依赖求值完成之后。
需要新增启动动作就加到 `12-entry.js` 的 `start()` 里。

> `12-entry.js` 也不在环里（v2.2.0 删掉 `splitKeywords` 后，
> `07-settings-dialog → 12-entry` 和 `09-process → 12-entry` 两条边一起消失）。
> **别再把通用小工具塞进 `12-entry.js`**，那会把入口重新拖回环里 ——
> 放到 `01-config.js` 这类零依赖模块里。

用 `node tools/dep-graph.js`（或 `npm run deps`）打印真实的 ES module 依赖图与环：

```bash
npm run deps
```

它按 `import ... from "./x.js"` **和**纯副作用 `import "./x.js"` 两种写法建图
（`main.js` 全是后者），再用 Tarjan 求强连通分量。当前结果就是上面的
6 模块主环 + `13↔15` 小环。

### 2. import 顺序有意义，但环内的求值顺序别依赖

`main.js` 的 import 顺序与原单文件的行序一致。但这只保证"顶层副作用尽量按原顺序发生" ——
**环内模块的求值顺序由打包器决定**，不要写依赖环内求值顺序的代码。

### 3. 模板字符串里的空白是内容，不是排版

`05-ui.js` / `07-settings-dialog.js` / `11-guide.js` 里有大段 CSS/HTML 模板。
"只有空格"的行、以及紧贴收尾反引号前的空白，**都是字符串值的一部分**。
改它们等于改运行时的样式。

### 4. 别在模块顶层做有副作用的初始化

除了 `06-settings.js`（加载配置）、`11-guide.js`（注入样式）这两处历史遗留，
新代码不要加模块级副作用 —— 环会让求值时机变得不可预测。

## 文件一览

| 文件                      | 内容                                                                                                                          | 跨模块依赖                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `_header.js`              | userscript banner + 版本说明（构建时前置）                                                                                    | —                             |
| `main.js`                 | 入口：按序 import + 调 `start()`                                                                                              | 全部                          |
| `01-config.js`            | `@typedef` + `CONFIG` + `PAGE`（页面识别）                                                                                    | 无                            |
| `02-state.js`             | `getStoredJSON` + `state` + `elements`                                                                                        | 无                            |
| `03-infra.js`             | `ErrorHandler` / `APIInterceptor` / `DOMCache` / `StorageManager` / `StatePersistence`                                        | config, state, settings, core |
| `04-hr-interaction.js`    | `HRInteractionManager`（打招呼、发简历）                                                                                      | config, state, infra, core    |
| `05-ui.js`                | `UI` 大对象（面板构建）                                                                                                       | 6 个模块                      |
| `06-settings.js`          | 默认值 + `SettingsStore`（含老配置迁移）+ `settings` + `saveSettings` + 提示词常量与 `renderPrompt()`                         | state                         |
| `07-settings-dialog.js`   | 设置弹窗与通用组件工厂                                                                                                        | 6 个模块                      |
| `08-core.js`              | `Core`：AI 判定 + 投递主流程 + 聊天页两条路径（顶部监听 / chatStore 全量遍历）+ AI 请求（最大单体）                           | 9 个模块                      |
| `09-process.js`           | `toggleProcess` / `toggleChatProcess`                                                                                         | 2 个模块                      |
| `10-storage.js`           | `STORAGE`（localStorage 键名）                                                                                                | 无                            |
| `11-guide.js`             | 引导流程 + 样式注入。v2.2.1 起**不再自动弹出**；`guide` 对象目前没有任何模块 import，会被打包器整块摇掉 —— 想用它得真的引进来 | 无                            |
| `12-entry.js`             | `init` / 面板守护 / 路由监听 / `start()`                                                                                      | 6 个模块（但不在环里）        |
| `13-greetings.js`         | 招呼语列表增删改                                                                                                              | state, settings, deferred     |
| `15-settings-deferred.js` | 延迟保存                                                                                                                      | state, settings, greetings    |

## 已知的隐形不变量（改动前务必知道）

1. **`state.settings === settings` 是同一个对象**（见 `06-settings.js`）。
   `saveSettings()` 靠 `Object.assign(state.settings, settings)` 做同步；
   若让二者指向不同对象，通过 `state.settings.*` 写入的地方会写到孤儿对象上。
2. **`settings` 上有两个 `Object.defineProperty` 兼容层**（`settings.ai`、
   `settings.actionDelays`）。`04-hr-interaction.js` 依赖 `actionDelays`，
   用对象展开或 JSON 克隆重建 `settings` 会丢掉这两层。
3. **`document.head.appendChild(style)`（`11-guide.js`）在模块顶层执行**，
   早于任何 UI 存在；`guide` 的样式依赖它。
4. **猴补丁只打一次**：`XMLHttpRequest.prototype`（`03-infra.js`）、
   `history.pushState/replaceState`（`12-entry.js`）。重复求值会叠加包装。
5. **打包器会 tree-shake 未被 import 的导出**。`03-infra.js` 里的
   `ManagedSet` / `EventManager` / `DOMUtils` 就因为没有引用而在产物中消失
   （已确认为死代码并从源码删除）。写了新工具类记得真的用上。
6. **右侧详情区有渲染延迟，会"串岗"**。点击职位卡片后，新岗位的详情不是立刻渲染的，
   这段时间里详情区还是上一个岗位的内容。
   踩过的坑：AI 拿着上一个岗位的「岗位要求」判定当前岗位；详情区按钮还显示「继续沟通」，
   于是新岗位被误判成"已沟通过"直接跳过（表现为从第 2 个岗位起全部跳过）。
   因此：
   - 读详情前必须 `await Core.waitForJobDetail(title, prevSignature, since)`，
     它返回切换来源（`"api"` / `"dom"` / `null`）
   - **只有 `"dom"` 才允许采信 DOM 里的内容**；返回 `null` 说明详情区没切过来，
     此时宁可不投也不能拿上一个岗位的内容去判定
   - 「已沟通过」只认卡片自带的按钮（`isCardAlreadyGreeted`），别读详情区的
   - 取标题/要求一律走 `Core.findDetailRoot()`，直接 `document.querySelector(".job-name")`
     会命中左侧列表的第一张卡片

7. **详情区的 class 名一律不可信**（v2.2.1 的线上事故）。v2.2.0 用
   `.job-detail-box` / `.job-sec-text` 这组写死的 class 找详情区，上线后全部落空，
   每个岗位都抓不到「岗位要求」，AI 只能回"信息不足"，48 个岗位一个没投出去。
   现在按优先级取：
   1. `APIInterceptor.lastJobDetail` —— 猴补丁从 `detail.json` 响应里抠出来的，最全且不受改版影响
   2. DOM：`findDetailByClass()`（已知 class，且容器里必须真的有描述文本）
      → `findDetailByAnchor()`（找「职位描述」小标题的父容器）
      → `findDetailByViewport()`（视口右半屏取点往上找容器）
      新增任何"读详情区"的代码请走 `Core.findDetailRoot()` / `Core.readDetail()`，
      不要新写 `document.querySelector(".job-detail-xxx")`。

   写这类兜底逻辑时注意：**我们自己的面板是 fixed 贴在右边的**，
   `document.elementFromPoint` 会取到它；取到左侧卡片或页面空白再一路往上爬，
   还会爬到 `.page` / `body` 上（真实踩过：AI 收到的是左侧列表的文字）。
   所以 `findDetailByViewport` 里三个校验一个都不能删 —— 复用 `isOwnElement()` /
   `isJobCardArea()`，别重写。

8. **判定请求的两条消息各有来源，别在调用点自己拼**（`08-core.js` 的 `judgeJob()`）：

   | 消息     | 内容             | 来源                                                |
   | -------- | ---------------- | --------------------------------------------------- |
   | `system` | JSON 输出契约    | 常量 `AI_JUDGE_SYSTEM_ROLE`，**不许用户改**         |
   | `user`   | 渲染后的主提示词 | `renderPrompt(settings.promptTemplate, 运行时变量)` |

   `renderPrompt()`（`06-settings.js`）是唯一的模板渲染入口，它把 `{名字}` 换成
   **内置变量 `jobTitle` / `jobDescription`**（由调用点传进去）。v2.4.0 起
   用户可维护的素材只有这一条 `promptTemplate` —— 没有片段层了，
   所以变量表就是 `runtimeVars` 本身。

   契约段**必须**保持固定：`parseAiVerdict()` 靠它期望的
   `{"match": …, "reason": …}` 解析结果，解析失败一律 `match:false` ——
   也就是**一个岗位都投不出去，而且日志里没有任何报错**。

   另一个同样静默的坑：`renderPrompt` 遇到值为空 / 找不到的占位符时**保留 `{名字}` 原文**
   （不改写成空串），并把它收进 `missing`。`startProcessing()` 拿这个列表在启动时提醒一次；
   `judgeJob()` 里**不要重复报**，否则 50 个岗位会刷 50 行同样的警告。

   ⚠️ **老配置迁移**（`SettingsStore.load()` 里的 `inlinePromptVars`）是唯一会丢用户数据的地方，
   而且丢了不报错。两条硬约束：
   - 合并结果**必须先落盘再删 `promptVars` 键**（写在同一个 `try` 里）。顺序反了、
     或者只删不写，下次加载时 `legacyVars` 已经空了，`{resume}` 会被替换成空串 —— 简历静默消失
   - v2.2.x 那条回落路径**必须用 `PROMPT_SECTIONS_LEGACY`**（带 `{resume}`/`{require}`），
     不能用 `PROMPT_SECTIONS_DEFAULT`：后者已经没这两个占位符了，`userResume` 里的简历
     会无处可填。`test/settings-prompt.test.js` 有专门的场景盯着这两条

   `test/settings-prompt.test.js` 会真的跑一次投递，断言**实际发出的两条消息**长什么样。

9. **发送与投递动作集中在少数方法里**：`applyToJob` / `sendCustomReply` / `sendResume` /
   `sendImageResume` / `handleCardMessage`。新增发送逻辑时先复用这些出口，
   别在调用点各写一套"写输入框 + 点发送"的代码。

10. **配置变更一律走 `saveSettings()`**。`StatePersistence` 现在只有 `loadState()`，
    没有运行时的全量 `saveState()`。新增任何修改 `settings.*` 的代码，记得自己落盘。
11. **聊天页「自动轮询」是一次单向全量遍历，数据源是页面全局 `chatStore`**。
    列表 DOM 没有稳定 id（来自实机探测）；
    `window.chatStore.friendInfos` 才有 `uid` / `encryptBossId` / `lastTS` 等字段。
    Tampermonkey 沙箱下要经 `unsafeWindow`（退化到 `document.defaultView`）
    读取。启动时按 `chatStore.friends` 的顺序做一次快照，然后**从第一条到底部逐条打开，
    每条只走一次，到尾部自动停止**；遍历开始后新出现的会话不会插队。
    **点开会话即标已读**；只有「最后一条我方消息 == 打招呼列表第 1 行」的会话才会收到
    列表第 2 行及以后的后续消息（首次沟通没有开关；不一致的不发也不记账）。
    账本键新写入 `uid:<uid>`，读取时兼容旧的「名字-公司」；改这里之前先跑
    `test/chat-auto-poll.test.js`。

## 构建与验证

```bash
npm run build         # src/ → boss-quick-apply.user.js
npm run check         # 构建 + 语法检查
npm test              # 冒烟 + 投递流程 + 设置/提示词 + 聊天页打招呼 + 自动轮询
npm run test:flow     # 只跑投递流程（可加参数只跑一个场景：npm run test:flow -- none）
npm run test:chat     # 只跑聊天页（打招呼/卡片 + 自动轮询）
npm run test:settings # 只跑设置与提示词编辑器
npm run deps          # 打印 ES module 依赖图与环
npm run verify -- 旧版本.js 新版本.js   # 行为比对
```

`test/apply-flow.test.js` 是**唯一能证明"真的能投出去"的测试**：它在假页面上点「开始投递」，
桩掉 `GM_xmlhttpRequest`，然后断言 AI 到底收到了什么。它的 fixture 故意用**随机 class 名**，
连「职位描述」小标题都不给，逼代码走接口 / 语义锚点 / 视口三条兜底路径。

> 这是被线上事故教出来的：v2.2.0 之前的验证脚本里写着和源码一模一样的 class 名，
> 测试全绿而线上全挂 —— 那种测试只是把写代码时的假设又念了一遍。
> **改抓取逻辑时，别去迁就 fixture，要迁就真实页面。**

产物 `boss-quick-apply.user.js` **需要提交** —— 用户通过它安装和自动更新，路径不能变。

### 重构后怎么证明"没改坏"

模块化之后，"逐字节相同"和"AST 等价"都不再适用（打包器会重排、重命名、常量折叠）。
用行为比对：

```bash
git show HEAD:boss-quick-apply.user.js > /tmp/old.js
node tools/behavior-diff.js /tmp/old.js boss-quick-apply.user.js
```

它把两个版本分别加载进同一份页面 fixture，比对脚本产生的 DOM、
猴补丁状态、全局泄漏和未捕获错误。
