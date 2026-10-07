/* global GameGlobal */
// 夹具：形状合格（末尾显式全局赋值）但违反确定性禁令的"模拟核心"入口。
// scan.test.ts 用 buildSim 把它打成 sim.js，验证 sim:scan 在 esbuild 产物上能抓到违规。
// 注释里的 Math.sqrt(2)、Date.now() 不应被报。

const api = {
  wave: (x) => Math.sin(x),
  noise: () => Math.random(),
  root: (x) => Math.sqrt(x),
  cube: (x) => x ** 3,
  stamp: () => Date.now(),
  label: 'Math.cos(1) 与 Date 只是字符串',
};

(typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis).BadmintonSim = api;
