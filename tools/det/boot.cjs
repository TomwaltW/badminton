/* global require, process */
/**
 * 确定性门禁的 node / bun 加载器：用法 <node|bun> boot.cjs <sim.js> <driver.js> [driver 参数…]
 *
 * 与 jsc 命令行（jsc <sim.js> <driver.js> -- <参数>）保持同一种加载方式：
 * 两个文件都当经典脚本、在同一个全局作用域里依次执行。这里用 vm.runInThisContext（在当前全局上下文里
 * 按经典脚本编译执行，顶层 var / function 成为全局，与 jsc 一致）；已实测 bun 1.4 支持，不需要退回间接 eval。
 * 不用 require(sim.js)：那是模块加载，顶层作用域与 jsc / 微信不同。
 *
 * 交给 driver 的东西放在全局上：
 *   __detArgs      driver 参数（字符串数组），相当于 jsc 的全局 arguments
 *   __detJitProbe  bun 下的 require('bun:jsc').numberOfDFGCompiles（JIT 关闭时返回哨兵 1000000）；node 下不设
 */
'use strict';

const vm = require('node:vm');
const fs = require('node:fs');

const files = process.argv.slice(2, 4);
if (files.length < 2) {
  process.stderr.write('用法：<node|bun> boot.cjs <sim.js> <driver.js> [driver 参数…]\n');
  process.exit(2);
}

globalThis.__detArgs = process.argv.slice(4);
if (process.versions && process.versions.bun) {
  globalThis.__detJitProbe = require('bun:jsc').numberOfDFGCompiles;
}

for (const file of files) {
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}
