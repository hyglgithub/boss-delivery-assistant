# BOSS 直聘 `web/geek/chat` 自动化探测报告

- 环境：Windows + Playwright CLI + Chrome，已登录 `.pw/main` profile，有头模式
- 页面：`https://www.zhipin.com/web/geek/chat?ka=header-message`
- 本报告已脱敏：不含 cookie、`zp_token`、`securityId`、WS 口令、真实姓名/公司/消息内容

---

## 1. 结论速查

1. 直接用 Playwright/CDP 打开会触发站点自毁（页面自己跳走/关闭）；需要先注入 guard 脚本，
   见第 2 节。
2. 切换会话 **URL 不变**，不能靠 URL 判断当前会话。
3. 会话列表 DOM **没有稳定 id、没有岗位名**；稳定数据在 `window.chatStore.friendInfos`。
4. **历史消息可以不点开会话直接拉**（`historyMsg`），不会走点击逻辑。
5. **岗位名不点开也能拿**：`getBossData` 的 `zpData.job.jobName`。
6. **没有**“一次返回全部会话”的 REST 接口；列表来自 MQTT over WebSocket 同步。
7. 未读角标：`.figure .notice-badge`（数字）/ `.figure .dot`（系统/群），由 `unreadCount` 驱动。
8. 会话切换约 200ms；`.chat-message` 整体替换，observer 必须重挂。
9. 消息历史翻页：滚到顶部触发 `page=2`，`.im-list` 节点不换，旧消息原地插入。
10. 会话列表是全量渲染（本次 17 条），滚动到底无懒加载。

---

## 2. 如何用 Playwright 操作页面（绕过 devtools 自毁）

### 2.1 站点做了什么限制

`main.js` 内置 devtools-detector。只要检测到 DevTools/CDP（与 `navigator.webdriver` 无关），
就回调 `onDevToolOpen`，执行：

```js
window.opener = null;
window.open("", "_self");      // 页面变成 about:blank
window.close();
window.history.back();
setTimeout(() => {
  document.body.innerHTML = ""; // 清空页面
  location.href = "";           // 重载/跳走
  // 再创建一个 <style>，给 html/body/#app 加
  // blur(20px) !important / display:none !important / visibility:hidden / opacity:0
}, 100);
```

另外 `security/121/geek/index.js` 会探测本地调试端口（`ws://127.0.0.1:9222`、`10086` 等）。

### 2.2 方案 A：Playwright 自己启动（推荐，已验证）

```bash
cd C:/Users/31548

# 1) 有头启动，复用已登录 profile
playwright-cli -s=main open --profile="C:/Users/31548/.pw/main" --headed

# 2) 关键：导航之前装 guard（init script，对之后的每个文档生效）
playwright-cli -s=main run-code --filename="C:/Users/31548/.pw/zhipin-guard.js"

# 3) 再导航
playwright-cli -s=main goto https://www.zhipin.com/
```

一键脚本：`C:/Users/31548/.pw/open-zhipin.bat`
（已存在会话时不会重复开浏览器，但仍会重装 guard 并 goto。）

要点：

- **顺序不能反**：guard 必须在 `goto`/`reload` 之前安装。
- 已经在目标页时，装完 guard 需要 `reload` 或重新 `goto` 才会生效。
- 关掉浏览器后 guard 不保留，下次启动重新执行第 2 步。

### 2.3 方案 B：attach 到普通 Chrome（已验证）

```bash
# 用非 9222 端口，避免和站点探测端口冲突
"C:/Program Files/Google/Chrome/Application/chrome.exe" \
  --remote-debugging-port=9333 \
  --user-data-dir="C:/Users/31548/.pw/main" \
  --no-first-run --no-default-browser-check

playwright-cli -s=main attach --cdp=http://127.0.0.1:9333
playwright-cli -s=main run-code --filename="C:/Users/31548/.pw/zhipin-guard.js"
playwright-cli -s=main goto https://www.zhipin.com/
```

注意：

- **只 attach 不够**：CDP 一连接，检测器就会触发，仍然需要 guard。
- 不要用 9222；站点会主动探测这个端口。
- 旧的无头 Chrome 如果还占着 9222，建议关掉，减少一个识别信号。

### 2.4 guard 脚本（`zhipin-guard.js`）

只让“自毁动作”失效，不改检测逻辑：

```js
async page => {
  await page.context().addInitScript(() => {
    try { window.close = function () {}; } catch (e) {}

    try {
      var realOpen = window.open;
      window.open = function (url, target) {
        if ((url === '' || url == null) && (target === '_self' || target == null)) return window;
        return realOpen.apply(window, arguments);
      };
    } catch (e) {}

    try { history.back = function () {}; history.go = function () {}; } catch (e) {}

    try {
      var d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true,
        get: d.get,
        set: function (v) {
          if (v === '' && (this === document.body || this === document.documentElement)) return;
          return d.set.call(this, v);
        }
      });
    } catch (e) {}

    try {
      if (window.navigation) {
        navigation.addEventListener('navigate', function (e) {
          try {
            if (e.destination && e.destination.url === location.href && !e.userInitiated) e.preventDefault();
          } catch (_) {}
        });
      }
    } catch (e) {}
  });
}
```

### 2.5 使用注意

- 这属于对抗站点自动化检测，可能违反其用户协议；账号有风控风险。
- 控制频率，不要批量并发；不要自动过滑块验证。
- guard 拦的是“动作”，站点改检测逻辑时可能需要重新适配。
- 站点仍可能在服务端记录 devtools/自动化事件，guard 不代表账号绝对安全。

---

## 3. 页面概览

- SPA；切换会话 URL 不变：`/web/geek/chat?ka=header-message`
- 无 Shadow DOM；页面有 3 个 iframe（`about:blank`/空 src），聊天 UI 在主文档
- 关键容器：
  - 会话列表：`div.user-list-content`
  - 聊天区：`div.chat-message > ul.im-list`
- 关键全局对象：
  - `window.chatStore`：会话数据（`friends` / `friendInfos`）
  - `window.ChatWebsocket`：WS 单例（settings / wsPool / reConnection）
  - `window.isChatPage === true`

---

## 4. 会话列表 DOM

容器：`div.user-list-content`（`data-v-00ec7992`）

```html
<div class="user-list-content" data-v-00ec7992>
  <ul role="thead"></ul>                      <!-- 空 -->
  <ul role="group" style="padding: 0px;">
    <li role="listitem" class="">             <!-- li 自身无 class/id -->
      <div class="friend-content-warp" data-v-3d67f5a8>
        <div class="friend-content [selected]" data-v-3d67f5a8 d-c="62001">
          <!-- d-c="62001" 是常量，所有会话相同，不能当 id -->
          <div class="figure" data-v-4ef04e05 data-v-3d67f5a8>
            <!-- 未读：<span class="notice-badge">N</span> 或 <span class="dot"></span> -->
            <img class="image-circle" src="AVATAR">
          </div>
          <div class="text" data-v-3d67f5a8>
            <div data-v-3d67f5a8>
              <span class="time">14:34</span>
              <!-- 两个 <!----> 占位，未读/置顶标记会渲染在这里 -->
            </div>
            <div class="title-box" data-v-3d67f5a8>
              <span class="name-box">
                <span class="name-text">NAME</span>
                <span>COMPANY</span>
                <i class="vline"></i>
                <span>HR_TITLE</span>
              </span>
            </div>
            <div class="gray last-msg" data-v-3d67f5a8>
              <!-- 自己发的最后一条：
                   <i class="message-status status-delivery"> [送达] </i> -->
              <span class="last-msg-text">LAST_MSG_PREVIEW</span>
              <div class="user-operation">
                <img class="icon-operate list-operate">
                <img class="icon-operate list-operate-hover">
              </div>
            </div>
          </div>
        </div>
      </div>
    </li>
  </ul>
  <div role="tfoot">
    <div class="boss-list-footer"><div class="finished">没有更多了</div></div>
  </div>
</div>
```

要点：

- 点击目标：整个 `.friend-content`（`element.click()` 有效）。
- 当前会话：`.friend-content.selected`（class 原地切换，li 节点复用）。
- 自己的最后一条：`.last-msg .message-status.status-delivery`，文本 `[送达]`。
- 多行问候语在 `.last-msg-text` 中保留 `\n`。
- DOM **没有** `data-id`/`data-uid`/`href`；`li` 自身 class 为空。
- 列表 DOM **没有岗位名**，只有 HR 名、公司、HR 职位。
- 新会话（“立即沟通”产生）：结构相同，last-msg 带 `status-delivery` + 自己的问候，
  按 `lastTS` 降序排在最顶。
- 未读角标模板（来自 `chat.js`）：
  - `unreadCount > 0`：`.figure > span.notice-badge`（数字，上限 999）
  - `uid === 0` 或群：`.figure > span.dot`
- 特殊行（源码推断，未出现）：`li.topwx.wx.selected` + `.notice-badge`（微信引导行）。
- 全量渲染：本次 17 条全部在 DOM，footer“没有更多了”；滚动到底无懒加载、无虚拟列表。

---

## 5. 会话切换

实测时间线（`element.click()`，100ms 轮询）：

| 时间 | 变化 |
|---|---|
| ~100ms | `.friend-content.selected` 切到目标；`.position-name` 仍为空 |
| ~200ms | `.position-name` 出现岗位名；`.im-list` 已有消息 |

- URL 始终不变。
- `div.chat-message` **整体替换**（节点 `===` 为 false），`ul.im-list` 一同换新。
- 未发现 loading / skeleton class。
- 切换请求顺序：`getBossData` → `historyMsg` → `POST geekEnter`。
- 可靠完成信号（建议同时满足）：
  1. `.friend-content.selected .name-text` == 目标名
  2. `.chat-message` 节点引用已变为新节点
  3. `.position-name` 非空
  4. `.im-list li[data-mid]` 至少一条
- 未读角标消失时机未实测。

---

## 6. 消息区 DOM

滚动容器是 `div.chat-message` 本身（`scrollHeight > clientHeight`）。

```html
<div class="chat-message" data-v-a2f29c4e>
  <ul class="im-list" data-v-a2f29c4e>

    <!-- 自己（文本） -->
    <li class="message-item item-myself" data-mid="MSG_ID" data-v-a2f29c4e>
      <div class="item-time"><span class="time"> 14:34</span></div>
      <div class="message-content">
        <div class="text">
          <i class="message-status status-delivery"> 送达 </i>
          <p><span class="text-content">TEXT</span></p>
        </div>
      </div>
    </li>

    <!-- HR（文本） -->
    <li class="message-item item-friend" data-mid="MSG_ID" data-v-a2f29c4e>
      <div class="message-content">
        <div class="figure" data-v-c31836e4>
          <img class="image-circle" src="AVATAR">
        </div>
        <div class="text">
          <p><span class="text-content">TEXT</span></p>
        </div>
        <!-- 自动回复：<div class="chat-helper">AI生成回复</div> -->
      </div>
    </li>

    <!-- 系统 -->
    <li class="message-item item-system" data-mid="MSG_ID" data-v-a2f29c4e>
      <div class="item-time"><span class="time"> 14:29</span></div>
      <div class="message-content">
        <div class="text">
          <p><span class="text-content">你撤回了一条消息</span></p>
        </div>
      </div>
    </li>

    <!-- 竞争者分析卡片（friend） -->
    <li class="message-item item-friend" data-mid="MSG_ID">
      <div class="message-content">
        <div class="articles-center" data-v-75186e06>
          <div class="message-card-wrap blue" data-v-5704d76a>
            <div class="message-card-top-wrap">
              <div class="message-card-top-icon-content">
                <img class="message-card-top-icon" src="...">
              </div>
              <div class="message-card-top-content">
                <h3 class="message-card-top-title">你与该职位竞争者PK情况</h3>
                <p class="message-card-top-sub-title">...</p>
                <p class="description">...</p>
              </div>
            </div>
            <div class="message-card-buttons">
              <span class="card-btn one-btn">查看详细分析</span>
            </div>
          </div>
        </div>
      </div>
    </li>

    <!-- 交换微信卡片（friend） -->
    <li class="message-item item-friend" data-mid="MSG_ID">
      <div class="message-content">
        <div class="figure" data-v-c31836e4><img class="image-circle" src="AVATAR"></div>
        <div data-v-e548b958>
          <div class="message-dialog-both message-card-wrap green" data-v-5704d76a>
            <div class="message-card-top-wrap">
              <span class="dialog-icon weixin" data-v-e548b958></span>
              <div class="message-card-top-content">
                <h3 class="message-card-top-title message-card-top-text">
                  我想要和您交换微信，您是否同意
                </h3>
                <div class="message-multi">
                  <p class="gray">为保障您的安全建议在平台内沟通……</p>
                </div>
              </div>
            </div>
            <div class="message-card-buttons">
              <span class="card-btn">拒绝</span>
              <span class="card-btn">同意</span>
            </div>
          </div>
        </div>
      </div>
    </li>

  </ul>
</div>
```

字段：

- 分类：`item-myself`（自己）/ `item-friend`（HR）/ `item-system`（系统）。
- 消息 id：每条 `li.message-item[data-mid]`（DOM 里唯一可靠 id）。
- 时间：`.item-time .time`，文本形如 ` 14:34`；没有时间戳 data-*。
- 正文：`.text-content`；多段用 `<br>`。
- 自己消息状态：`.message-status`（如 `status-delivery` = 送达）。
- 目前观察到的 DOM 变体只有 5 种：
  系统、HR 文本、HR 蓝色竞争卡片、自己文本、HR 绿色交换微信卡片。
- 未观察到图片消息、简历附件卡片。
- 交换卡片“同意”按钮：`.message-card-buttons > span.card-btn`；**未点击**（有真实副作用）。

---

## 7. 未读与新消息

- 实时捕获到：

```html
<span class="notice-badge">1</span>   <!-- .figure 内，同一节点随后原地变为 2 -->
```

- 当前 badge 被自动化快速读掉；**消失瞬间未捕获**。
- `window.chatStore.friendInfos[*].unreadCount` 是未读数来源；
  `unreadMidArr` 保存未读 mid 列表。
- 本地 `chatStore.updateFriendInfo({uniqueId, unreadCount:2})` **不会触发列表重渲染**
  （已还原），列表响应式数据源不是 `chatStore` 对象本身。
- 新消息通过 WS 推送；列表更新方式为原地新增/更新 li（未见整表重建），
  观察器记录到 `.last-msg` 内插入 `i.message-status.status-delivery` 和 `span.notice-badge`。

---

## 8. 数据层：`chatStore` / 全局对象

- `window.chatStore.friends`：数组，元素是 friend uid（本次 17 个）。
- `window.chatStore.friendInfos`：对象，key `"${uid}-0"`，value：

```
encryptBossId, uniqueId, lastTS, friendId, friendSource, uid, name, updateTime,
brandName, jobTypeDesc, locationName, positionName, jobName, title, avatar,
securityId, encryptJobId, jobId, isTop, isFiltered, relationType, sourceTitle,
goldGeekStatus, lastText, lastMsgId, unreadCount, lastMsgStatus,
filterReasonList, tipType, unreadMidArr, note, lastIsSelf, lastMsgClientId
```

`positionName` / `jobName` / `jobTypeDesc` / `locationName` 只出现在部分条目
（由标签/推荐接口补入），其余用 `getBossData` 补。

提取会话摘要（只读、不点开）：

```js
Object.values(window.chatStore.friendInfos).map(f => ({
  uid: f.uid,
  bossId: f.encryptBossId,
  jobId: f.jobId,
  name: f.name,
  company: f.brandName,
  hrTitle: f.title,
  jobName: f.jobName || f.positionName || null,
  preview: f.lastText,
  lastTS: f.lastTS,
  unread: f.unreadCount,
  isTop: f.isTop,
  lastIsSelf: f.lastIsSelf,
  lastMsgId: f.lastMsgId,
}));
```

拉某个会话历史（不点开）：

```js
const f = Object.values(window.chatStore.friendInfos)[0];
const url = `/wapi/zpchat/geek/historyMsg?bossId=${encodeURIComponent(f.encryptBossId)}` +
  `&maxMsgId=0&c=20&page=1&src=0&securityId=${encodeURIComponent(f.securityId)}`;
const res = await fetch(url, {
  credentials: 'include',
  headers: { 'X-Requested-With': 'XMLHttpRequest' },
});
const { zpData } = await res.json();
```

- `window.ChatWebsocket`：单例，`settings`（token/password）、`wsPool`、
  `reConnection()`、`getCurrentServer()`、`syncSendRead$` 等。
- 无 Shadow DOM；3 个 iframe（`about:blank`/空 src），聊天 UI 不在 iframe 内。

---

## 9. HTTP API

页面 XHR 带 cookie + 自定义头 `zp_token`；从页面上下文 `fetch` 不带 `zp_token`
也能成功调用 `historyMsg`（已实测）。

### 9.1 会话补水（按 friendId 批量）

```
POST /wapi/zprelation/friend/getGeekFriendList.json
Content-Type: application/x-www-form-urlencoded

friendIds=uid1,uid2,...
```

响应 `zpData.result[]`：

```
friendSource, securityId, name, avatar, isTop, sourceTitle, relationType,
lastMsg, lastMessageInfo{msgId, encryptMsgId, showText, fromId, toId, status, msgTime},
lastTime, lastTS, sourceType, jobId, jobSource, encryptJobId, itemType, waterLevel,
chatStatus, title, brandName, unreadMsgCount, tinyUrl, encryptBossId, uid, encryptUid,
filterReasonList, note, filtered, isFiltered
```

`title` 是 HR 职位，不是岗位名。

### 9.2 Boss / 岗位信息（不点开可用）

```
GET /wapi/zpchat/geek/getBossData
    ?bossId=<encryptBossId>&bossSource=0&securityId=<securityId>
```

响应：

```
zpData.data{ note, bossFreezeStatus, companyName, tinyUrl, title, encryptJobId,
             encryptBossId, bossId, securityId, name, isTop, hasInterview,
             mobileVisible, weixinVisible, ... }
zpData.job{ jobName, salaryDesc, brandName, locationName, degreeName,
            experienceName, lowSalary, highSalary, jobSource, proxyJob, proxyType }
```

`zpData.job.jobName` 即岗位名。

### 9.3 历史消息（不点开可用，已实测）

```
GET /wapi/zpchat/geek/historyMsg
    ?bossId=<encryptBossId>&maxMsgId=0&c=20&page=1&src=0&securityId=<securityId>
```

响应：

```
zpData{
  hasMore: bool,
  minMsgId: int,          // 本页最早 mid，翻页时作为 maxMsgId
  type: int,
  messages: [{
    mid, cmid, type, bizType, uncount, flag, received, offline, pushSound,
    status, time,          // epoch ms
    taskId, securityId,
    from{uid, name, company, avatar, ...},
    to{uid, name, company, avatar, ...},
    body{
      type, templateId, headTitle,
      text,        // body.type=1  文本
      jobDesc,     // body.type=8  职位卡片（DOM 不渲染）
      articles,    // body.type=16 文章/卡片
      ...
    }
  }]
}
```

### 9.4 进入会话

```
POST /wapi/zpchat/session/geekEnter
     jobSource=0&k810=0&securityId=<securityId>
```

响应：`{statusInfo{chatStatus}, online, onlineStyle, warnDialog, ...}`。
点击会话时在 `getBossData` / `historyMsg` 之后发送，疑似承担“已读/进入”语义。

### 9.5 其他

- `GET /wapi/zpchat/config/ws` → `["ws.zhipin.com","ws6.zhipin.com","ws2.zhipin.com"]`
- `GET /wapi/zprelation/friend/geekFilterByLabel?labelId=0&encryptSystemId=...`
  → 小批量 `friendList`（含 `jobName/positionName/brandName/bossTitle`）；
  `labelId=-1` 返回空。
- `GET /wapi/zpchat/group/gravityGroupInfoList?page=1&scene=0`（分组）
- **没有发现**不带 friendIds 的全量会话列表接口。

---

## 10. WebSocket

- URL：`wss://ws.zhipin.com/chatws`
- 协议：**MQTT 3.1 over WebSocket**（CONNECT 报文含 `MQIsdp`）
- 帧：**二进制 protobuf**，不是 JSON
- CONNECT：clientId `ws-<16 位 HEX>` + username/password（`ChatWebsocket.settings`），
  随后 CONNACK；心跳为 MQTT PINGREQ / PINGRESP
- topic：`chat`
- 连接成功后同步最近会话/消息（列表由此填充 `chatStore.friendInfos`）；
  新消息以 PUBLISH 二进制帧到达，客户端再按 friendId 调 `getGeekFriendList` 补水
- 服务器池：`ws.zhipin.com` / `ws6.zhipin.com` / `ws2.zhipin.com`

抓帧：

```js
page.on('websocket', ws => {
  ws.on('framereceived', e => console.log(e.payload)); // Buffer
  ws.on('framesent', e => console.log(e.payload));
});
```

---

## 11. 滚动与翻页（实测）

### 11.1 消息向上翻页

- 目标会话打开时 20 条历史、`hasMore=true`，DOM 19 条。
- 把 `.chat-message.scrollTop` 置 0（到达顶部）触发：

```
GET /wapi/zpchat/geek/historyMsg
    ?bossId=<encryptBossId>&maxMsgId=398698725262082&c=20&page=2&src=0&securityId=<...>
```

- 返回 3 条更早消息，`hasMore=false`，`minMsgId=398698725212928`：
  两条系统消息 + 一条 `body.type=8` 职位卡片（**不渲染**）。
- DOM 19 → 21（API 22 条）；`.im-list` 节点不变，旧消息原地插到顶部。
- 插入后滚动位置自动锚定：`scrollTop` 1292 → 117。
- 无 loading/skeleton；无“加载更多/没有更多”文字。
- 已在顶部时用滚轮不会再触发；触发条件就是“到达顶部”。

### 11.2 会话列表滚动

- 容器即 `.user-list-content`（scrollHeight 1368 > clientHeight 637）。
- 连续滚到底 8 次：条数始终 17，`scrollTop` 最大 730，footer 始终“没有更多了”。
- 当前规模下全量渲染，无懒加载/虚拟列表。

---

## 12. 剩余缺口

1. 未读角标“消失”瞬间：未捕获（自动化读得太快）。
2. 图片消息、简历附件卡片：现有会话未出现。
3. 交换微信“同意”后的结构变化：未点击（真实副作用）。
4. 置顶行（`isTop=1`）与系统通知行的真实 DOM：当前全部 `isTop=0`。
5. >17 条会话的虚拟滚动/懒加载：未测。
6. 单会话 >40 条的连续翻页：只测到第 2 页。
7. 点击会话是否立即标已读：没有可用未读样本，未验证。

---

## 13. 探测记录与安全说明

- 未发送消息、未点击“同意”。
- 点击会话会标记已读（页面正常行为）。
- 为抓 WS，调用过一次 `ChatWebsocket.reConnection()`（自动重连）。
- 临时导出的响应 JSON、截图已删除；本报告不含任何 token/个人信息。
