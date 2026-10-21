#!/usr/bin/env node
/**
 * AST 等价校验：比较两份 JS 是否语义等价。
 *
 * 用途：重构（拆模块、改格式）后证明"没改坏"。比字符串比对可靠 ——
 * 忽略空白、注释位置、括号风格，只看程序结构。
 *
 * 归一化处理：
 *   - 忽略 start/end/loc/range/raw（位置与源码文本表示）
 *   - 同运算符的 && || ?? 链展平（结合律）：prettier 会重新加括号，
 *     形状变了但语义不变
 *
 * 用法: node tools/ast-equivalent.js <a.js> <b.js>
 * 退出码: 0 = 等价, 1 = 不等价
 */
const fs = require("fs");
const path = require("path");

let acorn;
try {
  acorn = require("acorn");
} catch {
  console.error("需要 acorn，请先运行: npm install");
  process.exit(2);
}

const SKIP = new Set(["start", "end", "loc", "range", "raw"]);
const ASSOC = new Set(["&&", "||", "??"]);

function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (!node || typeof node !== "object") return node;

  const out = {};
  for (const k of Object.keys(node)) {
    if (SKIP.has(k)) continue;
    out[k] = normalize(node[k]);
  }

  if (out.type === "LogicalExpression" && ASSOC.has(out.operator)) {
    const op = out.operator;
    const flatten = (n) => {
      if (!n || typeof n !== "object") return [n];
      if (n.type === "LogicalExpression" && n.operator === op) {
        return [...flatten(n.left), ...flatten(n.right)];
      }
      if (n.type === "LogicalChain" && n.operator === op) {
        return n.parts.flatMap(flatten);
      }
      return [n];
    };
    return { type: "LogicalChain", operator: op, parts: flatten(out) };
  }

  return out;
}

function parse(file) {
  const src = fs.readFileSync(file, "utf8");
  return normalize(acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" }));
}

/** 抽取所有字符串/模板串内容 —— 防止 CSS/HTML/提示语被悄悄改写 */
function literals(file) {
  const out = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (node.type === "TemplateElement") out.push(node.value.cooked);
    else if (node.type === "Literal" && typeof node.value === "string") out.push(node.value);
    for (const k of Object.keys(node)) walk(node[k]);
  })(parse(file));
  return out;
}

const [fileA, fileB] = process.argv.slice(2);
if (!fileA || !fileB) {
  console.error("用法: node tools/ast-equivalent.js <a.js> <b.js>");
  process.exit(2);
}

const nameA = path.basename(fileA);
const nameB = path.basename(fileB);

const astA = JSON.stringify(parse(fileA));
const astB = JSON.stringify(parse(fileB));
const litA = literals(fileA);
const litB = literals(fileB);
const litSame = JSON.stringify(litA) === JSON.stringify(litB);

/** 多集计数 */
function tally(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

// 打包场景下 B 会引入自己的字面量（如 "use strict"、esbuild 的 "name"），
// 所以总数不等是正常的。真正危险的是"A 里有而 B 里没有"——那意味着
// 有字符串被改写或被丢弃（CSS、提示语、API 地址等）。
const tallyA = tally(litA);
const tallyB = tally(litB);

/** 打包器会把相邻字符串字面量做常量折叠（"a" + "b" → "ab"）。
 *  这种"消失"是无害的：原串仍完整出现在合并后的字面量里。 */
function looksFoldedInto(lit) {
  if (typeof lit !== "string" || lit === "") return false;
  return litB.some((b) => typeof b === "string" && b.includes(lit));
}

const missing = [];
const folded = [];
for (const [lit, need] of tallyA) {
  const have = tallyB.get(lit) || 0;
  if (have >= need) continue;
  const entry = { lit, need, have };
  // "use strict" 指令在 ESM 里是隐含的，打包器通常会省略
  if (lit === "use strict") folded.push(entry);
  else if (looksFoldedInto(lit)) folded.push(entry);
  else missing.push(entry);
}

if (folded.length) {
  console.log(`  （${folded.length} 条差异可由常量折叠/严格模式隐含解释，非丢失）`);
}

console.log(
  `字面量/模板串: ${nameA}=${litA.length} ${nameB}=${litB.length} — ${
    litSame
      ? "完全一致 ✅"
      : missing.length
        ? `有 ${missing.length} 条丢失 ❌`
        : "无丢失 ✅（对方另有新增）"
  }`,
);
for (const { lit, need, have } of missing.slice(0, 10)) {
  console.log(`  丢失(${have}/${need}):`, JSON.stringify(lit).slice(0, 300));
}
if (missing.length > 10) console.log(`  …另有 ${missing.length - 10} 条`);

// --literals-only：只做字面量子集校验，跳过 AST 比对（打包产物结构必然不同）
if (process.argv.includes("--literals-only")) {
  process.exit(missing.length ? 1 : 0);
}

if (astA === astB && litSame) {
  console.log("AST 语义等价 ✅");
  process.exit(0);
}

let i = 0;
while (i < astA.length && i < astB.length && astA[i] === astB[i]) i++;
console.log("AST 不等价 ❌");
console.log(`长度 A=${astA.length} B=${astB.length} 首个差异位置=${i}`);
console.log("A:", astA.slice(Math.max(0, i - 250), i + 250));
console.log("B:", astB.slice(Math.max(0, i - 250), i + 250));
process.exit(1);
