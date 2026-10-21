# BOSS投递助手 · 聊天页执行逻辑（v2.4.0）

> 分析日期：2026-10-21　|　分支：`refactor/split-src-modules`
> 依据：`src/` 源码 + 实机探测报告 [`zhipin-chat-probe.md`](zhipin-chat-probe.md)。
>
> 历史缺陷与来龙去脉见 [`GREETING-AND-CHAT-ANALYSIS.md`](GREETING-AND-CHAT-ANALYSIS.md)。

## 一句话总结

**「仅新消息」仍然只看会话列表最上面一条；「自动轮询」是一次单向全量遍历：
从列表第一条开始，逐个打开、处理，到最后一条结束并自动停止，不再做候选筛选。**

---

## 一、启动与停止

面板按钮「开始聊天」→ `toggleChatProcess()`（`src/09-process.js:45`）：

```
开始：
  state.isRunning = true
  Core.startProcessing()

停止：
  state.isRunning = false
  Core.resetChatScan()
  断开 Core.messageObserver
```

`Core.startProcessing()` 的聊天页分支（`src/08-core.js`）按模式分流：

```
resetChatScan()
while (state.isRunning) {
  检测模式是否被切换 → 是则重置遍历游标

  if (communicationMode === "auto") handleChatPageAuto()   // 全量遍历
  else                                handleChatPage()     // 顶部会话

  await delay(auto ? CONFIG.CHAT.POLL_INTERVAL : CONFIG.BASIC_INTERVAL)
}
```

| 模式 | 行为 |
| --- | --- |
| `new-only`（仅新消息） | 每 1 秒检查列表顶部一条 |
| `auto`（自动轮询） | 每 2.5 秒推进一次全量遍历，直到尾部自动停止 |

---

## 二、「仅新消息」路径（`handleChatPage`）

保持不变：

1. `getLatestChatLi()` 取 `ul[role=group]` 里第一个带 `.friend-content-warp` 的 `li`。
2. `hrKey = 名字-公司`（小写）。
3. 同一个 `hrKey` 且 observer 还活着 → 直接返回。
4. 该 `li` 没有 `last-clicked`：点开、等 1.2s、调用
   `HRInteractionManager.handleHRInteraction(hrKey)`。
5. 给 `.chat-message .im-list` 挂 `MutationObserver`，处理新消息。

---

## 三、「自动轮询」路径：单向全量遍历

### 3.1 数据源

读页面全局 `window.chatStore.friendInfos`（Tampermonkey 沙箱下经 `unsafeWindow`，
退化到 `document.defaultView`）。每个会话有：

```
uid, encryptBossId, securityId, name, brandName, title(HR职位),
jobName / positionName / jobTypeDesc(部分有),
lastText, lastTS, lastMsgId, lastIsSelf, unreadCount, isTop
```

拿不到 `chatStore.friendInfos` 时，自动轮询回退成「只看顶部会话」，并在日志里说明一次。

### 3.2 遍历顺序（启动时快照）

`initChatScan()`：

- 优先用 `chatStore.friends` 的顺序（与左侧会话列表一致）；
- `friends` 缺失或不全时，按 `lastTS` 倒序补上；
- 每个会话只进一次；
- **遍历开始后新出现的会话不会插队**，这一轮只走启动时的快照。

日志开头：

```
自动轮询：共 55 个会话，从头到尾打开一遍
```

### 3.3 推进节奏

- 每 2.5 秒调用一次 `handleChatPageAuto()`；
- 每次最多连续处理 `CONFIG.CHAT.MAX_SWEEP_PER_CALL`（5）个会话；
- 每打开一个会话之间停 `CONFIG.CHAT.SWEEP_DELAY`（400ms）；
- 进度日志：

```
自动轮询 [1/55]：蔡莉 / 星芽文化
自动轮询 [2/55]：张三 / 测试公司
...
```

### 3.4 单个会话做什么

```
processSweepTarget(target, scan):
  1. 从 chatStore 取最新 info
  2. findConversationLi(info) 找到 DOM 条目
     找不到 → 按遍历进度滚动会话列表，再找一次
  3. 点击 .friend-content；1.2s 没切过去再点 .figure 兜底
  4. waitForConversationSwitch() 等选中项 / 岗位名 / 消息出现
  5. DOMCache.clear()
  6. HRInteractionManager.handleHRInteraction({uid, name, company, ledgerKey})
```

失败处理：

- 找不到条目 / 打开超时 → 记一行日志，**继续下一个**；
- 某个会话处理抛错 → 记一行日志，继续下一个；
- 不会因为第一个会话失败而卡住。

### 3.5 会话切换等待

`waitForConversationSwitch()`：

1. `.friend-content.selected` 的昵称 == 目标名字；
2. `.position-name` 非空，或 `.im-list` 里已有 `li[data-mid]`。

**不强制要求 `.chat-message` 被替换**：启动时顶部会话可能本来就打开，再点它不一定重渲染。
也不再用 `chatStore.friends` 的下标校验 uid（置顶/系统行会让下标错位）。

### 3.6 到尾部结束

最后一批处理完后：

```
自动轮询完成：已遍历 55/55 个会话
```

然后调用 `toggleChatProcess()` 自动停止，按钮恢复成「开始聊天」。
再点一次开始会从顶部重新遍历。

---

## 四、三本账与决策树

`HRInteractionManager.handleHRInteraction(target)`（`src/04-hr-interaction.js`）：

```
if (!hasLedger(sentGreetingsHRs, target))            → 首次沟通
else if (!hasLedger(sentResumeHRs) || !hasLedger(sentImageResumeHRs))
     if (hasHRResponded())                           → 跟进
else                                                 → 无动作
```

### 4.1 稳定键

- 新写入：`uid:<uid>`（没有 uid 时用 `boss:<encryptBossId>`）。
- 读取：同时检查稳定键和旧版 `<名字>-<公司>`。
- 旧账本不会自动改写落盘，但读取兼容。

### 4.2 首次沟通（打招呼列表）

`settings.greetingsList` 现在叫**打招呼列表**：

| 行 | 含义 | 谁发送 |
| --- | --- | --- |
| 第 1 行 | 网页（BOSS）自动发出的打招呼语 | 点「立即沟通」时 BOSS 发 |
| 第 2 行起 | 脚本要补发的消息 | 脚本发 |

判定顺序：

1. 读当前会话**最后一条我方消息**（`.message-item.item-myself` 的正文）。
2. 和列表第 1 行按 `Core.cleanMessage()` 归一化后比较（去首尾空白、压缩空白、去零宽字符）。
3. **不一致 → 什么都不发**，不写 `sentGreetingsHRs`，也不发简历。
4. **一致 → 只发第 2 行及以后**，第 1 行不再重复发送。
5. 发送成功后写 `sentGreetingsHRs`，再按开关发附件简历 / 图片简历。

> 这条判据用来确认"这次沟通是 /jobs 页点「立即沟通」发起的"：
> BOSS 已经替我们发过第一行，脚本接在后面说后续内容。
> 旧会话 / 手动打的招呼 / 网页招呼语与第 1 行不一致时，脚本不会插话。

### 4.3 跟进（HR 已回话）

- 最后一条 HR 消息带 `.message-card-wrap` → `handleCardMessage`：
  - 「自动同意交换」关闭（默认）→ 只记日志，不点；
  - 开关打开 → 点一次「同意」。
- 最后一条 HR 文本含「简历」：
  - 图片简历开关开且没发过 → 发图片简历；
  - 附件简历开关开且没发过 → 发附件简历。

> AI 自动回复已移除：两本简历账都齐之后不再有任何动作。
> 「仅新消息」收到新 HR 消息时仍会走同一个跟进逻辑，处理交换卡片和「简历」请求。

---

## 五、数据获取能力（实机结论）

### 5.1 会话列表

| 数据 | 来源 | 备注 |
| --- | --- | --- |
| 稳定 uid / encryptBossId | `chatStore.friendInfos` | DOM 里没有 |
| 未读数 | `unreadCount` / `.figure .notice-badge` | 数字角标 |
| 最后消息预览 | `lastText` / `.last-msg-text` | DOM 预览可读 |
| 最后消息 id / 是否为本人 | `lastMsgId` / `lastIsSelf` | 全量遍历里不再用于筛选 |
| 岗位名 | `jobName` / `positionName` / `getBossData` | 列表 DOM 里没有；当前代码已不使用 |
| 当前选中会话 | `.friend-content.selected` | 切换完成信号 |
| 列表滚动 | 本次 17 条全量渲染，无虚拟列表 | 55 条时需再验证 |

### 5.2 打开会话的消息

- 容器：`.chat-message .im-list`；切换会话时 `.chat-message` **整体替换**。
- 分类：`item-myself`（自己）/ `item-friend`（HR）/ `item-system`（系统）。
- 正文：`.text-content`（旧代码的 `.text span` 也能命中，但会误伤其它 span）。
- 消息 id：`li.message-item[data-mid]`。
- 卡片：`.message-card-wrap` / `.card-btn`；交换微信卡片按钮是 `span.card-btn`。
- 历史翻页：滚到顶部触发 `page=2`，`.im-list` 不换，旧消息原地插入。

### 5.3 不点开会话能读到什么

- `chatStore.friendInfos`：会话摘要。
- `getBossData` / `historyMsg`：只读接口，探测时可用；当前代码已不再调用。
- **没有**「一次返回全部会话」的 REST 接口；列表由 MQTT over WebSocket 同步进
  `chatStore`，所以遍历顺序以 `chatStore` 为准。

### 5.4 仍然做不到 / 未验证

1. 发送消息仍需要点开会话操作 DOM；**打开即已读**。
2. WebSocket 是 MQTT + protobuf 二进制，未解析。
3. 未读角标消失的精确时机、图片消息 / 简历附件卡片 / 交换卡片点击后的结构变化
   未在本次探测中覆盖。
4. 超过 17 条会话时是否仍然全量渲染、超过 40 条消息的连续翻页未验证。

---

## 六、当前边界与副作用

1. **全量遍历会打开所有会话**，打开即标已读，这是 DOM 方案的固有限制。
2. **只有「最后一条我方消息 == 打招呼列表第 1 行」的会话才会收到后续消息**
   （首次沟通没有开关；不一致的不发也不记账）。
3. 遍历开始后新出现的会话不会插队；这一轮结束后再点开始才会重新生成快照。
4. 找不到会话条目 / 打开超时 / 处理报错时，记日志并继续下一个，不会卡住。
5. 会话列表如果虚拟滚动，会按遍历进度滚动一次再找；超过 55 条的极端情况未验证。
6. 自动轮询在 `chatStore` 不可用时回退到顶部会话逻辑，并提示一次。
7. 三本账的稳定键升级为 `uid:`，旧键仍兼容。

---

## 七、验证

```bash
npm run build
npm test                 # 含 chat-greeting（21）+ chat-auto-poll（16）
npm run test:chat        # 两个聊天页测试
npm run format:check
```

`test/chat-auto-poll.test.js` 用三会话 fixture + 假 `chatStore` 覆盖：

- 按顺序打开全部 3 个会话，但只有「最后一条我方消息 == 打招呼首行」
  的会话发送后续消息，不一致的不发也不记账；
- 全部会话都已打过招呼、没有自动发送功能时，仍然打开全部会话但不发消息；
- 遍历到尾部自动停止（按钮恢复「开始聊天」）。

`test/chat-greeting.test.js` 额外覆盖「首行匹配只发后续」「首行不一致一条都不发」
以及交换卡片开关。

负向对照：把构建产物的遍历顺序临时改成只保留第一个会话，遍历/发送相关断言会大面积失败；
还原重建后全绿。

---

## 八、代码位置索引

| 关注点 | 位置 |
| --- | --- |
| 聊天页主循环 / 模式分流 | `src/08-core.js` `startProcessing()` 聊天分支 |
| 仅新消息每轮逻辑 | `src/08-core.js` `handleChatPage()` |
| 自动轮询入口 | `src/08-core.js` `handleChatPageAuto()` |
| 遍历顺序 / 游标 / 结束 | `initChatScan()` / `nextSweepTargets()` / `finishChatSweep()` |
| 单个会话 | `processSweepTarget()` |
| 虚拟列表兜底滚动 | `scrollChatListToRatio()` |
| chatStore 读取 | `getPageWindow()` / `getChatStore()` |
| 会话切换等待 | `waitForConversationSwitch()` / `findConversationLi()` |
| 交互决策树 / 三本账 | `src/04-hr-interaction.js` 顶部静态方法 |
| 新消息 observer（仅新消息） | `src/08-core.js` `setupMessageObserver()` / `handleNewMessage()` |
| 启动 / 停止 | `src/09-process.js` `toggleChatProcess()` |
| 轮询间隔 / 批量 | `src/01-config.js` `CONFIG.CHAT` |
| 实机探测原始结论 | [`zhipin-chat-probe.md`](zhipin-chat-probe.md) |
