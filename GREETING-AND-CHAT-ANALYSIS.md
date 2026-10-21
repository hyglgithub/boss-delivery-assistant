# 打招呼链路与聊天页分析报告

> 📌 **当前聊天页的完整执行逻辑、可获取的数据、以及「真轮询」改造可行性，
> 见 [`CHAT-ASSISTANT-LOGIC.md`](CHAT-ASSISTANT-LOGIC.md)（2026-10-20）。**
> 本文保留为历史分析与缺陷清单，部分状态在后续版本中已有变化。
>
> 分析日期：2026-09-21　|　基线：`refactor/split-src-modules` @ `6d58402`
> 分析方式：**通读源码**（`src/*.js`）+ 追溯 git 历史 + 检查测试 fixture。
>
> ⚠️ **本文是静态代码分析，没有在真实 BOSS 页面上实机验证。** 凡涉及"真实页面长什么样"的
> 结论，都标注了推断依据（历史代码 / README / 引导文案 / 第三方测试 fixture），
> 复现时请以实机为准。
>
> 📌 **后续变更**：**第一节（打招呼三级回落）已经按方案 1 处理完毕**，
> 详见第五节 5.1 开头的落地说明。因此第一节描述的那段代码
> （`trySendGreetingText`）**现已不存在**，该节按"当时的现场"阅读，不要再照着行号去找。
> 第二、三节（聊天页）与第四节第 7–14 条**均未改动**。
>
> 📌 **2026-10-20 补充**：AI 判定契约已去掉 `greeting` 字段（system 只要求
> `{"match","reason"}`），下面第一节表格里的「一级」来源已不存在；加载老模板时
> 也会删掉默认规则里「写一条打招呼消息」那句话。聊天页的「自我介绍」列表已改名为
> **「打招呼列表」**：第 1 行是网页自动发出的招呼语，只有最后一条我方消息与它一致时，
> 脚本才发送第 2 行及以后的内容。
>
> 📌 **同日后续**：聊天页的 **AI 自动回复**、**「沟通岗位包含」关键词过滤**、
> **测试模式**已全部移除。文中涉及这三项的路径与代码位置均为历史记录，不再对应
> 当前源码；当前执行逻辑以 [`CHAT-ASSISTANT-LOGIC.md`](CHAT-ASSISTANT-LOGIC.md) 为准。

## 结论摘要

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 三级回落为什么只剩 BOSS 默认招呼语 | 前两级汇聚到同一个函数 `trySendGreetingText()`，而它在职位列表页找不到可写入的输入框，静默降级。**已处理：整段发送逻辑已删除，见 5.1** |
| 2 | 聊天页是干什么的 | 投递的"后半程"：对 HR 会话自动发自我介绍、自动发简历、可选 AI 自动回复 |
| 3 | 聊天页怎么判断该不该发 | 只查 `hrKey` 在不在三个 Set 里，**不做内容判断**；消息内容仅在判断是否含"简历"时被读取 |
| 4 | 两个窗口真的能联动吗 | 代码层面**零通信**，唯一通道是 BOSS 服务器把新会话推到聊天列表顶部 |

---

# 一、问题 1：招呼语的三级回落为什么形同虚设

## 1.1 三级回落的设计

`src/08-core.js:1376-1382`（`judgeJob`）与 `src/08-core.js:846`（传参）：

| 级别 | 来源 | 代码位置 |
| --- | --- | --- |
| 一级 | AI 在同一次调用里返回的 `greeting` 字段 | `parseAiVerdict()`，`08-core.js:1350` |
| 二级 | 设置里的「自我介绍」列表，用 `\n` 拼成一条 | `08-core.js:1377-1382` |
| 三级 | BOSS 自带的默认招呼语 | 不由本脚本发送（见 1.3） |

二级只在**一级为空**时才计算（`if (verdict.match && !verdict.greeting)`），所以两者不会同时生效 ——
但它们是**同一个入口的两次填值**，一级断了二级也一起断。

## 1.2 根因：入口函数在列表页找不到输入框

`08-core.js:955-973`：

```js
async trySendGreetingText(greeting, label) {
  if (!greeting || !greeting.trim()) return false;
  const findInput = () =>
    document.querySelector(
      "#chat-input, .chat-input, .greet-boss-dialog textarea, .dialog-container textarea, " +
        ".input-area textarea, .chat-input-box textarea",
    );
  let input = findInput();
  if (!input) input = await this.waitForElement(findInput, CONFIG.OPERATION_INTERVAL);

  if (!input) {
    this.log(`${label} 已发起沟通（BOSS 会使用「打招呼语设置」里的默认招呼语；…）`);
    return false;                                   // ← 前两级在这里被丢弃
  }
  …
}
```

`#chat-input` / `.btn-send` 是**聊天页**的选择器（`04-hr-interaction.js:121,132` 在用，那里 `#chat-input`
是 contenteditable 的 div）。而投递流程全程停在职位列表页 —— `08-core.js:911` 的注释就写着
「停留在此页，继续处理下一个岗位」。列表页没有 IM 输入框，所以 `waitForElement` 等满
`OPERATION_INTERVAL`（`01-config.js:42`，1200ms）后返回 null，落进上面那个分支。

**用户看到的「只能用 BOSS 默认招呼语」，对应的是这条日志。** 复现时先看面板日志有没有这一行。

## 1.3 `.greet-boss-dialog textarea` 从一开始就不成立

「打招呼弹窗」是 BOSS 原生弹窗，**不含输入框**。依据：

- 追到该 class 最早出现处（v1.8 `fbb2e42`），当时只有一句
  `document.querySelectorAll(".default-btn.cancel-btn")` 找「留在此页」按钮 —— 那是点击「立即沟通」
  **之后**的「去沟通 / 留在此页」确认框，内容是通知，不是编辑框。
- `greet-boss-dialog` / `dialog-container` / `dialog-wrap` 这几个 class 名在仓库任何文档、
  任何历史提交里都**没有真实来源**，是猜的。

## 1.4 更根本的：BOSS 的招呼语在点击那一刻就已发出

- `README.md:70-71` 排障表：「找不到「立即沟通」按钮 → 确认已在 BOSS 设置页开启「打招呼语」」
- `08-core.js:1687` `handleGreetSettingsPage()` 会专门跑到 `/web/geek/notify-set?type=greetSet`
  帮用户**打开 BOSS 自己的打招呼语开关**
- `11-guide.js:18`：「3. 判定通过才点"立即沟通"（需开启"自动打招呼"）」

即：`立即沟通` 这个动作本身由 BOSS 服务端投递它自己配置的招呼语，**顺序上先于本脚本的任何代码**。
等 `waitApplyResult()` 从「按钮文案变化」返回（`08-core.js:925`）时，那条默认招呼语已经在会话里了。
所以即便后面真找到输入框发出去，用户看到的也是「默认招呼语 + 我们的」两条，而不是替代。

## 1.5 为什么一直没被发现

**测试盲区**：`test/apply-flow.test.js` 的 fixture 里**没有聊天输入框、也没有任何弹窗**
（全文只有 `:218` 的 `greeting` 字面量）。点击后它做的是 `btn.textContent = "继续沟通"`（`:109-113`），
测试断言的是「按钮文案变了」（`:307`）。

也就是说 **`trySendGreetingText()` 的成功分支零覆盖，每次测试跑的都是那个失败分支，而且静默通过。**
该文件开头的注释自己就在警告这件事（"fixture 里写着和源码一模一样的 class 名 → 测试全绿、线上全挂"），
只是这次盲区往上挪了一层。

**失败不影响计数**：`applyToJob` 靠 `waitApplyResult` 的 `button-changed` 就返回 true，
面板照记「已投递」+1。除了一行日志，没有任何地方体现"自定义招呼语没发出去"。

## 1.6 附带缺陷：真要发送，写法也是错的

`08-core.js:981-989` 对 contenteditable 走 `input.textContent = msg` + 派发 `input` 事件；
而同一仓库里已验证可用的写法在 `04-hr-interaction.js:127-129`：先 `textContent = ""`，
再 `document.execCommand("insertText", false, text)`。前者在受控组件上大概率不触发状态更新，会发出空消息。

另外 `08-core.js:992` 的 `document.querySelector(".btn-send")` 是**全局查**，没有限定在当前弹窗内。

---

# 二、问题 2：聊天页到底有什么用

## 2.1 页面分叉

`05-ui.js:47` 按页面类型分叉面板；`05-ui.js:289` 聊天页标题为「BOSS智能聊天」；
`05-ui.js:359-413` 换成 `_createChatControls()`；日志框 id 变 `boss-chat-log`（`05-ui.js:479`）。

功能入口只有一个分支 —— `08-core.js:181-193`：

```js
if (PAGE.isChat()) {
  this.clearAiLog();
  this.log("开始监听招聘者消息…");
  while (state.isRunning) {
    await this.handleChatPage();
    await this.delay(CONFIG.BASIC_INTERVAL);   // 1000ms
  }
  return;
}
```

> **聊天页是投递的后半程。** 投递页只能点「立即沟通」让 BOSS 发它自己的招呼语；
> 而 `greetingsList`（自我介绍）唯一真正生效的地方就是这里（`04-hr-interaction.js:225`）。

## 2.2 「沟通岗位包含」

`settings.communicationIncludeKeywords`（`05-ui.js:378-382`）。

**不是筛职位列表，是筛聊天列表里的会话。** 逻辑在 `08-core.js:1078-1100`：先点开会话、等 2400ms、
用 `getPositionName()`（`08-core.js:1389`，读 `.position-name` / `.job-name`）拿到会话对应的岗位名，
按中英文逗号拆关键词，命中任一才继续。留空 = 全都处理。

两个坑：

- **致命回退**：`getPositionName()` 找不到就返回 `""`，而 `:1090` 是 `"".includes(keyword)` → 恒 false。
  **只要框里有字、聊天页又读不到 `.position-name`，就会 100% 跳过所有会话**，
  日志只有一句「跳过岗位，不含关键词[...]」，看起来像"没消息"。
- 判断之前就已经点开会话（`:1079`），这条会话已被标记已读 —— 哪怕接下来判定要跳过。

## 2.3 「沟通模式」

`settings.communicationMode`（`05-ui.js:384-391`），值 `new-only`（默认） / `auto`。

区别只在 `08-core.js:1095` 和 `:1109` 两处 `if (settings.communicationMode === "auto")`：

- `new-only`：处理完不动。
- `auto`：调 `scrollUserList()`（`:1117-1148`），在 `.user-list-content` 上随机滚 3-5 次、每次停 1-3 秒。

它存在的理由是 `getLatestChatLi()`（`:1242`）：

```js
document.querySelector('ul[role="group"] li[role="listitem"][class]:has(.friend-content-warp)')
```

这是**文档顺序里的第一条**，即列表最上面那条。`auto` 靠随机滚动让虚拟列表换一批渲染节点，
把"第一条"换成别的会话 —— **本质是靠虚拟列表 DOM 复用碰运气地群发，不是可靠的分页遍历**。

## 2.4 「开始智能聊天」的完整逻辑

按钮 → `toggleChatProcess()`（`09-process.js:45`）→ `state.isRunning = true` → `Core.startProcessing()`
→ 上面那个 1 秒一轮的轮询循环。**是轮询，不是纯事件驱动。**

每轮 `handleChatPage()`（`08-core.js:1055`）：

1. 取最上面那条会话，用 `.name-text` + `.name-box span:nth-child(2)` 拼出 `hrKey = "名字-公司"`（`:1059-1063`）。
2. `this.currentMonitoredHR === hrKey && this.messageObserver` → **直接 return**（`:1066`）。
   最上面还是同一个 HR 时，整轮什么都不做。
3. 换了人 → 重置状态、断开旧 observer → 关键词筛选（`auto` 时滚动）。
4. 这条 li 上没有 `last-clicked` 类 → 点 `.figure` 打开会话、等 1200ms、
   调 `handleHRInteraction(hrKey)`、打上 `last-clicked`（`:1102-1112`）。
5. 给 `.chat-message .im-list` 挂 `MutationObserver`（`:1155-1179`）。

## 2.5 「什么算新消息」—— 有两条完全不同的触发路径

**路径 A：会话换了就算新**（`08-core.js:1102`）

判据是 DOM 节点上的 `last-clicked` 类。会话切走再切回来，类还在就只发一次；BOSS 重渲染换了节点
会重新触发，但 `sentGreetingsHRs` 持久化在 localStorage 里挡着重复发。

**路径 B：真的来了条对方消息**（`08-core.js:1159-1172`）

```js
hasNewFriendMessage = Array.from(mutation.addedNodes)
  .some((node) => node.classList?.contains("item-friend"));
```

**往 `.chat-message .im-list` 里新增了一个 class 含 `item-friend` 的节点**（对方发来的，自己发的不算）。
只监听 `childList`，**不监听属性/文本变化**。

命中后 `handleNewMessage()`（`:1181-1229`）：等 1200ms → 取最后一条对方消息 → `cleanMessage()`
去标签去空白 → 与 `lastProcessedMessage` 相同则丢弃（防重渲染重复触发）→ 按内容分流：
含"简历"且开了自动发简历就走发简历，否则 `autoReply` 开着就走 `handleHRInteraction`。

> `08-core.js:1199` 的日志 `已同意交换，对方: xxx` **文案是错的** —— 这里只是收到了一条 HR 消息，
> 与"同意交换"无关。

## 2.6 「两个浏览器窗口」到底行不行

**能，这就是原设计。** 两个窗口是同一份脚本、不同 URL，`PAGE.isChat()` 让它们各自渲染不同面板、
走不同分支；`state.isRunning` 也是各页面独立的变量，互不干扰。

但有几个限制（部分在第三节展开）：

- **聊天页只认最上面那条**。`new-only` 模式下，刚打过招呼的 HR 若没排在列表最顶就不会被处理。
  **没有"待处理队列"这种东西**，三个 Set 只是去重集合，不会补漏。
- **附件简历基本发不出去**，见 3.5 第 3 条。
- **AI 自动回复默认关闭**，且上限写死 10 条/天，见 3.5 第 5 条。
- **群发节奏激进**：`sendGreetings` 每条之间只隔 `actionDelays.click`（默认 130ms，`:238`）。

---

# 三、问题 3：窗口联动与「该不该发」的判定

## 3.1 核心结论

**聊天页不做任何内容判断。** 它对着一堆消息，只查三本账：`hrKey` 在不在三个 Set 里。
消息内容全文**只在一个地方**参与决策 —— 判断有没有出现"简历"两个字。

## 3.2 它靠什么认人

`08-core.js:1059-1063`：

```js
const nameEl = latestChatLi.querySelector(".name-text");
const companyEl = latestChatLi.querySelector(".name-box span:nth-child(2)");
const name = (nameEl?.textContent || "未知").trim();
const company = (companyEl?.textContent || "").trim();
const hrKey = `${name}-${company}`.toLowerCase();
```

`hrKey` 就是全部身份信息。**不是 HR 的 uid，不是 BOSS 的加密 id，是"昵称 + 公司名"拼的字符串**，
公司名还是按 `span:nth-child(2)` 的位置取的。

## 3.3 三本账

| 账本 | 键 | 谁写 | 上限（`01-config.js:56-61`） |
| --- | --- | --- | --- |
| `sentGreetingsHRs` | `hrKey` | **只有聊天页**（`04-hr-interaction.js:37`） | 500 |
| `sentResumeHRs` | `hrKey` | **只有聊天页**（`:52`、`:107`） | 300 |
| `sentImageResumeHRs` | `hrKey` | **只有聊天页**（`:67`） | 300 |
| `processedHRs` | **jobId** | **只有投递页**（`08-core.js:854`） | 500 |

> 最后一行的关键差异：**投递记的是 jobId，聊天页记的是 hrKey，两套体系零交集。**
> 投递投了 50 个岗位，聊天页一个都不知道；聊天页发过谁，投递也一个都不知道。

## 3.4 决策表

`04-hr-interaction.js:11-30` 是全部逻辑：

```js
if (!sentGreetingsHRs.has(hrKey))                     → _handleFirstInteraction
if (!sentResumeHRs.has(hrKey) || !sentImageResumeHRs.has(hrKey))
    if (hasResponded)                                 → _handleFollowUpResponse
                                                      → aiReply()
```

| 条件 | 动作 |
| --- | --- |
| `hrKey` 不在 `sentGreetingsHRs` | 逐条发 `greetingsList`（自我介绍）→ 再按开关发简历 → 把 `hrKey` 记进 `sentGreetingsHRs` |
| 发过自我介绍，但简历没发全 | **且** `hasHRResponded()` 为真才走 `_handleFollowUpResponse` |
| 三样都发过 | `aiReply()`（要求 `autoReply` 开着） |

`hasHRResponded()`（`04-hr-interaction.js:157-163`）：**当前打开的会话里存在
`li.message-item.item-friend` 节点**。不看是不是新的、不看是不是针对你这条、不看时间。

防重机制同样与内容无关：

- `last-clicked`（`08-core.js:1104`）：挂在 li 节点上，防止同一会话被反复点开重复走流程。
- `lastProcessedMessage`（`08-core.js:1196`）：`cleanMessage` 后的文本相同就丢弃。

## 3.5 内容唯一被读取的地方

`04-hr-interaction.js:87`：

```js
if (lastMessage && (lastMessage.includes("简历") || lastMessage.includes("发送简历"))) {
```

以及 `08-core.js:1194` 的 `cleanedMessage.includes("简历")`。

**"简历"这两个字是全流程唯一的语义判断。** 除此之外，发不发自我介绍跟对方说了什么、说了几条、
隔了多久，完全无关。

## 3.6 窗口之间没有联动

全仓库 grep 确认：**没有 `storage` 事件监听、没有 `BroadcastChannel`、没有 `postMessage`**。

唯一的耦合是：

> 投递窗口点「立即沟通」→ BOSS 服务端把这条会话推到聊天列表**最顶部** →
> 聊天页 `getLatestChatLi()` 捞到它。

单向、异步、无确认：投递不知道聊天页有没有接上，聊天页也不知道投递刚投了谁。

**内存态不同步**（比缺事件监听更要紧）：

- 三个 Set 是在**脚本求值时**读一次进内存的（`02-state.js:24`，模块顶层 `getStoredJSON`）。
- `StatePersistence.loadState()`（`03-infra.js:370-386`）**不重读**这三个 Set。
- SPA 路由切换时 `handleRouteChange()`（`12-entry.js:110-138`）也是重建面板、`clearDomCache()`，
  **同样不重读**。

> ★ **A 窗口写进 localStorage 的东西，B 窗口在刷新之前永远看不到。**
> 判定闸门 `currentSet.has(record)`（`03-infra.js:280`）用的是内存 Set，不是 localStorage。

**反向的坑**：`saveState()`（`03-infra.js:356-364`）会调 `SettingsStore.save(settings)` 把**所有设置键全量写回**。
两个窗口各持一份页面加载时的 `settings` 内存副本，所以 A 窗口改了设置、B 窗口随后因别的原因
（如 AI 回复计数变化，`08-core.js:1425`）触发一次 `saveState()`，就把 A 的改动冲掉了。

## 3.7 由此推导出的故障模式

**1. `hrKey` 取不到名字 → 静默串号。**
`nameEl` 为 null 时 `name = "未知"`，所有取不到名字的会话共享 `"未知-公司"` 这一个 key。
第一个发完自我介绍，其余**全部**被 `sentGreetingsHRs.has()` 挡在门外 ——
而且第一分支是直接 `return`，**没有 else 日志**，面板上一片安静。这是"聊天页看起来没反应"最典型的来源。
同理 `span:nth-child(2)` 按位置取公司名，BOSS 改动名字区结构就取错；同名同公司的两个 HR 也会互相顶掉。

**2. 发送失败会被永久记为"已发送"。**
`04-hr-interaction.js:225-246`：

```js
for (...) {
  await this.sendCustomReply(greeting.content);   // ← 返回值没接
  await Core.delay(state.settings.actionDelays.click);
}
return true;                                       // ← 只要列表非空就无条件 true
```

`sendCustomReply` 找不到 `#chat-input` 时是 `return false`（`:122-125`），但这里没接。
于是 `_handleFirstInteraction` 拿到 `true`、把 `hrKey` 写进 `sentGreetingsHRs` ——
**一次失败 = 这个 HR 永远不再尝试**，且静默。

**3. 首次沟通时的 `sendResume()` 是白跑。**
第一分支不看 `hasHRResponded` 就直接发简历，必然撞上 BOSS 的 `.unable`（`04-hr-interaction.js:288`：

```js
if (resumeBtn.classList.contains("unable")) {
  Core.log("对方未回复，您无权发送简历");
  return false;
}
```

而第二次尝试要等 HR 回复，且要求 HR 最后一条消息含"简历"（`:87`）。
**所以附件简历这条路，实质上只有"HR 主动要简历"时才会走通。**
图片简历没这个限制（`sendImageResume` 直接往 `input[type=file]` 塞 File，`:412-414`），
这也是 guide 里只推荐图片简历的原因 —— 两个开关压根不对等。

**4. `auto` 模式的"群发"是碰运气。**
没有真正的待处理队列：`new-only` 下最顶上那条不是你刚打招呼的 HR，那个 HR 就一直不被处理；
`auto` 下可能跳着捞、也可能反复捞同一条（被 Set 挡掉，代价是白跑一轮）。

**5. AI 自动回复默认关闭且有硬上限。**
`autoReply` 默认 `false`（`06-settings.js:77`，设置里叫「Ai回复模式」）；即使开启，
`08-core.js:1428` 写死 `const maxReplies = 10`，**设置界面里没有这个值，改不了**。
所以"智能聊天"这个名字比功能大：默认跑起来实际是「自动发自我介绍 + 自动发图片简历」。

---

# 四、缺陷清单（汇总）

> 状态列说明：**已消除** = 相关代码已删除，问题不复存在；**已缓解** = 删除了问题所在代码；
> **未处理** = 仍然存在，另行排期。第 1–6 条的处置见 5.1 节的落地说明。

| # | 缺陷 | 位置 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 列表页发不出自定义招呼语，前两级回落静默丢弃 | `08-core.js:955-973` | AI 招呼语 / 自我介绍在投递流程中完全无效 | 已消除（删掉发送逻辑） |
| 2 | `.greet-boss-dialog` 等选择器无真实来源，弹窗内无输入框 | `08-core.js:960`、`:1022` | 查找必然失败 | 已消除（同上） |
| 3 | BOSS 招呼语在点击瞬间已发出，脚本无法替代 | 设计层面 | 最多只能"补发一条" | 已接受为既成事实 |
| 4 | 成功分支零测试覆盖，失败静默通过 | `test/apply-flow.test.js` | 该 bug 长期不可见 | 已缓解（fixture 补假输入框 + 探针断言） |
| 5 | contenteditable 写入方式与仓库内已验证写法不一致 | `08-core.js:981-989` | 即便找到输入框也可能发出空消息 | 已消除（同上） |
| 6 | 发送键查询未限定作用域 | `08-core.js:992` | 可能点到别的发送键 | 已消除（同上） |
| 7 | `hrKey = 名字-公司`，取不到名字退化为 `"未知"` | `08-core.js:1059-1063` | 多 HR 串号，静默不再发送 | 未处理 |
| 8 | `sendGreetings` 不接返回值，无条件 `return true` | `04-hr-interaction.js:237-241` | 一次失败 = 永久不再尝试 | 未处理 |
| 9 | 首次沟通即发附件简历，必然撞 `.unable` | `04-hr-interaction.js:48-59`、`:288` | 附件简历形同虚设 | 未处理 |
| 10 | 关键词筛选在岗位名读不到时 100% 跳过 | `08-core.js:1090` | 配了关键词就什么都不发 | 未处理 |
| 11 | 跨窗口无 `storage` 事件，Set 只在页面加载时读一次 | `02-state.js:24`、`03-infra.js:370` | 两窗口状态不一致 | 未处理 |
| 12 | `saveState()` 全量覆盖 settings | `03-infra.js:356-364` | 一个窗口的设置改动被另一窗口冲掉 | 未处理 |
| 13 | 日志文案「已同意交换」与行为不符 | `08-core.js:1199` | 误导排查 | 未处理 |
| 14 | `maxReplies = 10` 硬编码，设置界面不可见 | `08-core.js:1428` | 用户无法调整 | 未处理 |

> ⚠️ **改动后行号已偏移**：第 1–6 条涉及的代码在 v2.4.0 中被删除，
> 表中第 7–14 条的 `08-core.js` 行号是**改动前**的。重新定位时以符号名（`hrKey`、
> `sendGreetings`、`maxReplies` 等）为准，不要直接跳行号。

---

# 五、建议的修复方向

## 5.1 打招呼（问题 1）

> ✅ **已按方案 1 落地（v2.4.0，2026-09-21）**：删除了 `trySendGreetingText()` 及其两处调用
> 与 `applyToJob()` 的 `greeting` 形参；AI 返回的 `greeting` 字段当时保持解析、仍记进 AI 日志，
> 但不再有人消费。**2026-10-20 起该字段已从判定契约和解析里删除**。**未做任何引导 UI**
> （不加启动日志、不改设置页文案、不做按钮）—— 这是当时的明确决定，不是遗漏。
>
> 落地时额外处理了一处**隐藏的时序依赖**：`closeGreetingModal()` 原本靠"等 600ms 后查一次"
> 关弹窗，而它前面恰好压着被删掉的那 1200ms 白等（`waitApplyResult()` 通常先命中"按钮文案变化"、
> 返回得比弹窗渲染还早）。改为在 `OPERATION_INTERVAL` 内轮询找按钮，最长耗时不变。
>
> 回归测试：`test/apply-flow.test.js` 的 fixture 补了假 `#chat-input` + `.btn-send` + 探针，
> 断言列表页流程不碰它们（56 → 61 项）。负向对照已做：把发送逻辑注回产物，断言立刻挂。

原文保留的方案选项：

1. **承认现实，放弃前两级** —— 摘掉列表页的 `trySendGreetingText`，引导用户去 BOSS 设置页配招呼语；
   AI 招呼语改为"复制到剪贴板"或写进日志供手动使用。改动最小，也最诚实。
   **← 实际采用的方案（引导部分按用户要求省略）**
2. **跨页发送** —— `立即沟通` 成功后记录 jobId，切到 `/web/geek/chat` 用现成的 `sendCustomReply()`
   发出去，再切回列表。能真正实现需求，但要重做状态机和页面切换。
3. **止血** —— 保留列表页逻辑但把日志改成明确警告；在测试 fixture 里补一个真的带输入框的弹窗，
   让成功分支有覆盖。

> 无论走哪条路，**BOSS 那条默认招呼语都拦不住** —— 它在点击瞬间就发出去了。
> 能做的只有"再补一条"，或者提前让用户把 BOSS 默认招呼语设成想要的内容。

## 5.2 聊天页的身份与待办（问题 2、3）

核心是补一份**显式的待办队列**，并把身份判据换稳：

1. 投递成功时，除 `processedHRs` 外再写一条 `pendingHRs`（jobId + 岗位名 + 公司 + 时间戳）。
2. 聊天页不再依赖"列表最上面那条是谁"，而是按 `pendingHRs` 去聊天列表里**查找**对应会话。
3. **`hrKey` 优先用 BOSS 自己的稳定 id（jobId / encryptBossId），不要再用 `名字-公司`** ——
   本文第四节里第 7、8、10 三条缺陷都源于这个字符串。
4. 发送结果真实回写：`sendGreetings` 接住 `sendCustomReply` 的返回值，成功才记入 `sentGreetingsHRs`，失败留待重试。
5. 跨窗口如需实时，加 `window.addEventListener('storage', ...)`，比轮询便宜。

---

# 附录：关键代码位置索引

> ⚠️ 行号基线为改动前的 `6d58402`。带 ~~删除线~~ 的条目**已在 v2.4.0 中移除**。
> 第 7–14 条相关符号（`hrKey`、`sendGreetings`、`maxReplies`…）的行号已因删除而前移，
> 重新定位时请按符号名搜索。

| 关注点 | 位置 |
| --- | --- |
| 三级回落传参 | ~~`08-core.js:846`~~（`greeting` 实参已删）、`08-core.js:1377-1382` |
| 发招呼语（问题 1 主犯） | ~~`08-core.js:955-1013`~~ **已删除** |
| 关弹窗 | `08-core.js:1017-1034`（v2.4.0 改成轮询，位置略有变动） |
| 投递结果判定 | `08-core.js:917-952`（`:925` 按钮变化即返回 ok） |
| 聊天页主循环 | `08-core.js:181-193` |
| 聊天页每轮逻辑 / `hrKey` | `08-core.js:1055-1115` |
| 新消息 observer | `08-core.js:1155-1179` |
| 新消息处理 | `08-core.js:1181-1229` |
| 取列表第一条 | `08-core.js:1242-1246` |
| 关键词筛选 | `08-core.js:1078-1100` |
| 轮询滚动 | `08-core.js:1117-1148` |
| AI 自动回复 | `08-core.js:1410-1460` |
| 交互决策表 | `04-hr-interaction.js:11-30` |
| 自我介绍发送 | `04-hr-interaction.js:225-246` |
| 发附件简历 | `04-hr-interaction.js:275-360`（`.unable` 在 `:288`） |
| 发图片简历 | `04-hr-interaction.js:390-450` |
| 发自定义文本 | `04-hr-interaction.js:119-152` |
| `hasHRResponded` | `04-hr-interaction.js:154-164` |
| 面板分叉 | `05-ui.js:47`、`:289`、`:359-413` |
| 启动/停止聊天 | `09-process.js:45-70` |
| 存储闸门 | `03-infra.js:278-303`（`:280` 是内存 Set） |
| 状态全量落盘 | `03-infra.js:354-368` |
| SPA 路由处理 | `12-entry.js:110-138` |
| 存储键与上限 | `01-config.js:48-61` |
| AI 输出契约 | `06-settings.js:69-73` |
