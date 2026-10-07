/**
 * 球的飞行：二次阻力 + 重力，RK4，固定子步 1/60 s，每个模拟 tick 2 个子步（方案 §2.4、§3.3）。
 *
 * 加速度 a = −k·|v|·v − g·ŷ，k = g / v_t²；|v| 用 dsqrt（门禁可注入 Math.sqrt 作对照路径）。
 *
 * 时间缩放 α（方案 §2.4、计划 0 #4）：对真实轨迹 X(t) 取 Y(t) = X(αt)，则
 *   g′ = α²·g，v0′ = α·v0，k 不变；
 * 射程、顶点、落地角不变，滞空 T′ = T/α。flightLaunch 一次性把 α 折进 v 与 g，积分器本身不知道 α。
 *
 * 状态是 Float64Array 里从偏移 o 开始的 FL_STRIDE 个槽（布局见 FL_*），积分原地进行，零分配。
 * 坐标：x 沿球场纵向（向前），y 向上，z 侧向。
 */

import type { SqrtFn } from './math';

/** 飞行状态布局：位置、速度、缩放后的重力 g′、阻力系数 k。 */
export const FL_PX = 0;
export const FL_PY = 1;
export const FL_PZ = 2;
export const FL_VX = 3;
export const FL_VY = 4;
export const FL_VZ = 5;
export const FL_G = 6;
export const FL_K = 7;
export const FL_STRIDE = 8;
/** 运动学部分（位置 + 速度）的长度；事件插值只处理这 6 个槽。 */
export const FL_KINEMATIC = 6;

/** 标准重力 m/s²。 */
export const G_STD = 9.81;
/** 终端速度起步值 m/s（方案 §2.4；标定时只调这一项）。 */
export const VT_STD = 6.5;
/** k = g / v_t²（约 0.232 m⁻¹）。 */
export const K_STD = G_STD / (VT_STD * VT_STD);

/** 时间单位：1u = 1/30000 s（契约 api.ts 的 U_PER_TICK = 1000，SIM_HZ = 30）。 */
export const SIM_HZ = 30;
export const U_PER_TICK = 1000;
export const SUBSTEPS_PER_TICK = 2;
/** 一个子步 = 1/60 s = 500u。 */
export const U_PER_SUBSTEP = 500;
/** 子步长 1/60 s。 */
export const SUBSTEP_DT = 1 / 60;

/** 由终端速度求阻力系数 k = g / v_t²。 */
export function dragFromTerminal(g: number, vt: number): number {
  return g / (vt * vt);
}

/**
 * 发射：写入初始位置与速度，并套用时间缩放 α：v′ = α·v0，g′ = α²·g，k 不变。
 * (vx, vy, vz) 是 α = 1 时的真实初速度。
 */
export function flightLaunch(
  s: Float64Array,
  o: number,
  px: number,
  py: number,
  pz: number,
  vx: number,
  vy: number,
  vz: number,
  alpha: number,
  g: number,
  k: number,
): void {
  s[o + FL_PX] = px;
  s[o + FL_PY] = py;
  s[o + FL_PZ] = pz;
  s[o + FL_VX] = vx * alpha;
  s[o + FL_VY] = vy * alpha;
  s[o + FL_VZ] = vz * alpha;
  s[o + FL_G] = g * alpha * alpha;
  s[o + FL_K] = k;
}

/** 把运动学部分（位置 + 速度，6 个槽）从 src 复制到 dst。用于在子步前保存起点，供事件插值。 */
export function copyKinematics(src: Float64Array, so: number, dst: Float64Array, d: number): void {
  dst[d] = src[so];
  dst[d + 1] = src[so + 1];
  dst[d + 2] = src[so + 2];
  dst[d + 3] = src[so + 3];
  dst[d + 4] = src[so + 4];
  dst[d + 5] = src[so + 5];
}

/**
 * 原地推进一个 RK4 子步（步长 dt）。全部用标量局部变量，零分配。
 *
 * 运算顺序与 docs/spike/det-smoke.js 的 acc/add/rk4 逐项相同（单测据此复现实测哈希 3e34ca / e0082e4a）：
 *   a(v) = (−k·s·vx, −g − k·s·vy, −k·s·vz)，s = sqrt(vx² + vy² + vz²)
 *   v2 = v + a1·dt/2，v3 = v + a2·dt/2，v4 = v + a3·dt
 *   p′ = p + dt/6·(v + 2v2 + 2v3 + v4)，v′ = v + dt/6·(a1 + 2a2 + 2a3 + a4)
 */
export function stepRk4(s: Float64Array, o: number, dt: number, sqrt: SqrtFn): void {
  const px = s[o + FL_PX];
  const py = s[o + FL_PY];
  const pz = s[o + FL_PZ];
  const vx = s[o + FL_VX];
  const vy = s[o + FL_VY];
  const vz = s[o + FL_VZ];
  const g = s[o + FL_G];
  const k = s[o + FL_K];
  const h = dt / 2;

  let sp = sqrt(vx * vx + vy * vy + vz * vz);
  const a1x = -k * sp * vx;
  const a1y = -g - k * sp * vy;
  const a1z = -k * sp * vz;

  const v2x = vx + a1x * h;
  const v2y = vy + a1y * h;
  const v2z = vz + a1z * h;
  sp = sqrt(v2x * v2x + v2y * v2y + v2z * v2z);
  const a2x = -k * sp * v2x;
  const a2y = -g - k * sp * v2y;
  const a2z = -k * sp * v2z;

  const v3x = vx + a2x * h;
  const v3y = vy + a2y * h;
  const v3z = vz + a2z * h;
  sp = sqrt(v3x * v3x + v3y * v3y + v3z * v3z);
  const a3x = -k * sp * v3x;
  const a3y = -g - k * sp * v3y;
  const a3z = -k * sp * v3z;

  const v4x = vx + a3x * dt;
  const v4y = vy + a3y * dt;
  const v4z = vz + a3z * dt;
  sp = sqrt(v4x * v4x + v4y * v4y + v4z * v4z);
  const a4x = -k * sp * v4x;
  const a4y = -g - k * sp * v4y;
  const a4z = -k * sp * v4z;

  const d6 = dt / 6;
  s[o + FL_PX] = px + d6 * (vx + 2 * v2x + 2 * v3x + v4x);
  s[o + FL_PY] = py + d6 * (vy + 2 * v2y + 2 * v3y + v4y);
  s[o + FL_PZ] = pz + d6 * (vz + 2 * v2z + 2 * v3z + v4z);
  s[o + FL_VX] = vx + d6 * (a1x + 2 * a2x + 2 * a3x + a4x);
  s[o + FL_VY] = vy + d6 * (a1y + 2 * a2y + 2 * a3y + a4y);
  s[o + FL_VZ] = vz + d6 * (a1z + 2 * a2z + 2 * a3z + a4z);
}

/**
 * 推进一个 1/60 s 子步，并先把起点运动学存进 prev[po .. po+5]，供 events.ts 在子步内插值。
 * 模拟与 tablegen 都应走这个函数，保证"同一子步、同一插值"。
 */
export function stepSubstep(
  s: Float64Array,
  o: number,
  prev: Float64Array,
  po: number,
  sqrt: SqrtFn,
): void {
  copyKinematics(s, o, prev, po);
  stepRk4(s, o, SUBSTEP_DT, sqrt);
}
