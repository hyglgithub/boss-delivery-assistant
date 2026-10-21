#!/usr/bin/env node
/**
 * 构建脚本：src/ → boss-quick-apply.user.js
 *
 * src/ 现在是真正的 ES module（显式 import/export），由 esbuild 打包成单文件
 * userscript。esbuild 的 iife 格式负责提供原本手写的那层 IIFE 闭包。
 *
 * 几个刻意的选项：
 *   format=iife     打包成单文件，且自带闭包，不会泄漏到 window
 *   target=esnext   不做降级转换，产出结构最贴近源码，便于比对
 *   keepNames       保留函数/类名，方便在浏览器里调试
 *   minify=false    分发的是可读产物，不做压缩
 *
 * userscript banner 在打包后手工前置：必须位于文件第一行，Tampermonkey 才认。
 */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const SRC_DIR = path.join(__dirname, "src");
const ENTRY = path.join(SRC_DIR, "main.js");
const HEADER = path.join(SRC_DIR, "_header.js");
const OUT_FILE = path.join(__dirname, "boss-quick-apply.user.js");

function build() {
  if (!fs.existsSync(ENTRY)) {
    console.error(`找不到入口 ${ENTRY}`);
    process.exit(1);
  }

  const result = esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    target: "esnext",
    keepNames: true,
    minify: false,
    write: false,
    logLevel: "warning",
  });

  const code = result.outputFiles[0].text;
  const header = fs.readFileSync(HEADER, "utf8");
  const out = header + code;

  // banner 必须在文件首，否则 Tampermonkey 不认
  if (!out.startsWith("// ==UserScript==")) {
    console.error("构建结果未以 userscript banner 开头，拒绝写出");
    process.exit(1);
  }

  fs.writeFileSync(OUT_FILE, out);
  console.log(
    `已构建 ${path.basename(OUT_FILE)} — ${(out.length / 1024).toFixed(1)} KB，${out.split("\n").length - 1} 行`,
  );
}

build();
