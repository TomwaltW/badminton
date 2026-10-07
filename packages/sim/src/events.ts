/**
 * 子步内事件插值（计划 1.1、2.2"事件插值"）。
 *
 * 落地、过网平面高度、到达击球高度这三类事件一律在 1/60 s 子步内做线性插值，
 * 由同一个函数 crossSubstep 提供；模拟与以后的 tablegen 共用它。审查实测：不插值时
 * 落点误差可达 21 cm，插值后"表与 α 无关"的结论在 α 0.4–1.5 下成立（落点偏移 < 1 mm）。
 *
 * 三类事件 = 同一判据的三组参数：
 *   落地         axis = FL_PY，c = 0，        dir = CROSS_DOWN
 *   过网平面     axis = FL_PX，c = 网的 x，    dir = CROSS_ANY（读插值点的 y 即过网高度）
 *   到达击球高度 axis = FL_PY，c = 击球高度，  dir = CROSS_DOWN
 *
 * 事件时刻 t* 只在这里取整一次到 u（1u = 1/30000 s）：eventTimeU。
 */

import { FL_KINEMATIC, U_PER_SUBSTEP } from './flight';

/** 穿越方向：向下（坐标减小）、向上（坐标增大）、任意。 */
export const CROSS_DOWN = -1;
export const CROSS_UP = 1;
export const CROSS_ANY = 0;

/** 未穿越时 crossSubstep 的返回值。 */
export const NO_CROSS = -1;

/**
 * 判断子步 [prev → cur] 内坐标 axis 是否按 dir 方向穿越阈值 c；
 * 穿越则返回比例 f ∈ (0, 1]，并把插值后的位置与速度（6 个槽，FL_* 布局）写入 out[oo ..]，
 * 其中 out[oo + axis] 精确等于 c；未穿越返回 NO_CROSS，不写 out。
 *
 * 判据：向下 a0 > c ≥ a1；向上 a0 < c ≤ a1。起点恰在阈值上不算穿越（上一子步已报告过）。
 */
export function crossSubstep(
  prev: Float64Array,
  po: number,
  cur: Float64Array,
  co: number,
  axis: number,
  c: number,
  dir: number,
  out: Float64Array,
  oo: number,
): number {
  const a0 = prev[po + axis];
  const a1 = cur[co + axis];
  const down = dir <= 0 && a0 > c && a1 <= c;
  const up = dir >= 0 && a0 < c && a1 >= c;
  if (!down && !up) return NO_CROSS;
  const f = (c - a0) / (a1 - a0);
  for (let i = 0; i < FL_KINEMATIC; i++) {
    const b = prev[po + i];
    out[oo + i] = b + (cur[co + i] - b) * f;
  }
  out[oo + axis] = c;
  return f;
}

/** 事件时刻（u）：子步起点 + f·500u，四舍五入一次。f ∈ [0,1]。 */
export function eventTimeU(substepStartU: number, f: number): number {
  return substepStartU + Math.round(f * U_PER_SUBSTEP);
}
