/**
 * 受限数学。
 *
 * 模拟核心只允许 + − × ÷、比较、整数运算与本文件的 dsqrt：超越函数（sin/exp/pow/atan2 …）
 * 在 V8 与 JSC、arm64 与 x64 之间不逐位一致；Math.sqrt 虽然各引擎自身确定，但与 dsqrt
 * 在约 25% 的输入上差 1 ulp，两者只能选一个，本项目统一用 dsqrt（计划 1.1、9.2 #4）。
 */

/** 平方根函数的形状；内核语料用它切换 dsqrt 路径与 Math.sqrt 路径（后者只由门禁从外部注入）。 */
export type SqrtFn = (x: number) => number;

/**
 * 确定性平方根，照搬方案 §3.3：先把 x 缩放到 [1,4)（乘除 2 的幂在 IEEE-754 下精确），
 * 再做固定 5 次牛顿迭代，相对误差约 2e-16。
 *
 * 与方案原文的唯一差别：x = +Infinity 时原文的缩放循环永不结束，这里直接返回 +Infinity；
 * 有限输入的结果逐位不变。非正数与 NaN 返回 0（同原文）。
 */
export function dsqrt(x: number): number {
  if (!(x > 0)) return 0;
  if (x === Infinity) return x;
  let scale = 1;
  while (x >= 4) {
    x *= 0.25;
    scale *= 2;
  }
  while (x < 1) {
    x *= 4;
    scale *= 0.5;
  }
  let y = (x + 1) * 0.5;
  y = 0.5 * (y + x / y);
  y = 0.5 * (y + x / y);
  y = 0.5 * (y + x / y);
  y = 0.5 * (y + x / y);
  y = 0.5 * (y + x / y);
  return y * scale;
}
