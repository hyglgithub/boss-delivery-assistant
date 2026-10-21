// 入口。
//
// 1) 按原片段顺序 import 所有模块，保证顶层副作用（配置加载、样式注入）
//    的求值顺序与原单文件一致。
// 2) 最后才调用 start() —— 模块图里有一个 8 模块的大环（03-infra / 04-hr-interaction /
//    05-ui / 07-settings-dialog / 08-core / 09-process / 13-greetings /
//    15-settings-deferred，见 `npm run deps`），任何"在模块顶层直接启动"的写法都会在
//    依赖尚未初始化时执行，曾表现为 StatePersistence undefined 导致脚本静默失效。
//    入口（以及 12-entry.js）自身不在任何环里，所以它体内的 start() 一定发生在
//    其全部依赖求值完成之后。
//
// 改动这里的 import 顺序前请先读 src/README.md 的「顺序即契约」。

import "./01-config.js";
import "./02-state.js";
import "./03-infra.js";
import "./04-hr-interaction.js";
import "./05-ui.js";
import "./06-settings.js";
import "./07-settings-dialog.js";
import "./08-core.js";
import "./09-process.js";
import "./10-storage.js";
import "./11-guide.js";
import { start } from "./12-entry.js";
import "./13-greetings.js";
import "./15-settings-deferred.js";

start();
