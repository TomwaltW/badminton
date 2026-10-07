// 夹具：没有在末尾显式赋值到 GameGlobal / globalThis 的入口（相当于指望 --global-name 的顶层 var）。
// build.test.ts 验证 bundleSim 拒绝这种产物。

export const api = { dsqrt: (x) => x };
