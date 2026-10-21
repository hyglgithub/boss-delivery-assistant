#!/usr/bin/env node
/**
 * ES module 依赖图：src/ 各模块之间谁 import 谁，以及哪些模块互相构成环。
 *
 * 用途：判断"能不能在模块顶层做某事" —— 环内的求值顺序由打包器决定，不可依赖。
 * 见 src/README.md「四条硬规则」。
 *
 * 同时识别两种 import：
 *   import { x } from "./a.js";   → a 是依赖
 *   import "./a.js";              → 仅执行副作用，同样是依赖（main.js 里大量使用）
 *
 * 用法:
 *   node tools/dep-graph.js          人类可读的边 + 环
 *   node tools/dep-graph.js --json   机器可读
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC_DIR = path.join(ROOT, "src");

const IMPORT_RE = /import\s+(?:[^"'`]*?\bfrom\s*)?["']\.\/([^"']+)["']/g;

function readGraph() {
  const files = fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort();

  const graph = new Map();
  for (const file of files) {
    const source = fs.readFileSync(path.join(SRC_DIR, file), "utf8");
    const deps = new Set();
    for (const m of source.matchAll(IMPORT_RE)) deps.add(m[1]);
    graph.set(file, [...deps].sort());
  }
  return graph;
}

/** Tarjan：返回所有强连通分量（size > 1 的就是环） */
function stronglyConnected(graph) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const result = [];

  function visit(v) {
    indices.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.get(v) || []) {
      if (!graph.has(w)) continue; // 指向 src/ 之外（本项目没有）
      if (!indices.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), indices.get(w)));
      }
    }

    if (low.get(v) === indices.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      result.push(component.sort());
    }
  }

  for (const v of graph.keys()) {
    if (!indices.has(v)) visit(v);
  }
  return result;
}

function main() {
  const graph = readGraph();
  const components = stronglyConnected(graph);
  const cycles = components.filter((c) => c.length > 1);

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          edges: Object.fromEntries(graph),
          cycles,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("ES module 依赖图（src/*.js）\n");
  for (const [file, deps] of graph) {
    console.log(file.padEnd(28), "→", deps.join(", ") || "（无依赖）");
  }

  console.log("\n=== 循环依赖 ===");
  if (!cycles.length) {
    console.log("  （无）");
    return;
  }
  cycles.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.length} 个模块：${c.join(", ")}`);
  });
}

main();
