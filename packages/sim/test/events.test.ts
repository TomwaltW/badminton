/**
 * 子步事件插值单测：crossSubstep 的方向判据、插值比例 f ∈ (0,1]、阈值分量精确等于 c、
 * 其余 5 个分量线性插值、未穿越不写 out、端点语义、偏移量；eventTimeU 的取整。
 */
import { describe, expect, test } from 'bun:test';
import { CROSS_ANY, CROSS_DOWN, CROSS_UP, NO_CROSS, crossSubstep, eventTimeU } from '../src/events';
import { FL_KINEMATIC, FL_PX, FL_PY, FL_PZ, FL_VX, FL_VY, FL_VZ, U_PER_SUBSTEP } from '../src/flight';
import { Rng } from '../src/rng';

/** 由 6 个运动学分量组成的数组（可加前后填充）。 */
function kin(values: number[], pad = 0, fill = 0): Float64Array {
  const a = new Float64Array(pad + FL_KINEMATIC + 3).fill(fill);
  for (let i = 0; i < FL_KINEMATIC; i++) a[pad + i] = values[i]!;
  return a;
}

const SENTINEL = -12345.678;

describe('常数', () => {
  test('方向与未穿越返回值', () => {
    expect(CROSS_DOWN).toBe(-1);
    expect(CROSS_UP).toBe(1);
    expect(CROSS_ANY).toBe(0);
    expect(NO_CROSS).toBe(-1);
    expect(FL_KINEMATIC).toBe(6);
  });
});

describe('crossSubstep：方向', () => {
  const down = { prev: [1, 1, 0.2, 4, -2, 0.5], cur: [2, -1, 0.4, 3, -6, 0.1] }; // y: 1 → −1
  const up = { prev: [1, -1, 0.2, 4, 6, 0.5], cur: [2, 1, 0.4, 3, 2, 0.1] }; // y: −1 → 1

  test('向下穿越：CROSS_DOWN 与 CROSS_ANY 报告，CROSS_UP 不报告', () => {
    const out = new Float64Array(FL_KINEMATIC);
    expect(crossSubstep(kin(down.prev), 0, kin(down.cur), 0, FL_PY, 0, CROSS_DOWN, out, 0)).toBe(0.5);
    expect(crossSubstep(kin(down.prev), 0, kin(down.cur), 0, FL_PY, 0, CROSS_ANY, out, 0)).toBe(0.5);
    expect(crossSubstep(kin(down.prev), 0, kin(down.cur), 0, FL_PY, 0, CROSS_UP, out, 0)).toBe(NO_CROSS);
  });

  test('向上穿越：CROSS_UP 与 CROSS_ANY 报告，CROSS_DOWN 不报告', () => {
    const out = new Float64Array(FL_KINEMATIC);
    expect(crossSubstep(kin(up.prev), 0, kin(up.cur), 0, FL_PY, 0, CROSS_UP, out, 0)).toBe(0.5);
    expect(crossSubstep(kin(up.prev), 0, kin(up.cur), 0, FL_PY, 0, CROSS_ANY, out, 0)).toBe(0.5);
    expect(crossSubstep(kin(up.prev), 0, kin(up.cur), 0, FL_PY, 0, CROSS_DOWN, out, 0)).toBe(NO_CROSS);
  });

  test('插值结果：f = 0.5 时其余分量取中点，阈值分量 = c', () => {
    const out = new Float64Array(FL_KINEMATIC);
    crossSubstep(kin(down.prev), 0, kin(down.cur), 0, FL_PY, 0, CROSS_DOWN, out, 0);
    expect(Array.from(out)).toEqual([1.5, 0, 0.30000000000000004, 3.5, -4, 0.3]);
  });

  test('过网平面：axis = x、CROSS_ANY，两个方向都报告，读插值点的 y 即过网高度', () => {
    const out = new Float64Array(FL_KINEMATIC);
    const p = kin([6, 2.0, 0, 30, -3, 0]);
    const c = kin([7, 1.5, 0, 29, -3.2, 0]);
    const f = crossSubstep(p, 0, c, 0, FL_PX, 6.7, CROSS_ANY, out, 0);
    expect(f).toBeCloseTo(0.7, 12);
    expect(out[FL_PX]).toBe(6.7);
    expect(out[FL_PY]).toBeCloseTo(2.0 - 0.5 * 0.7, 12);
    // 反向过网（从对方场地打回来）
    const f2 = crossSubstep(c, 0, p, 0, FL_PX, 6.7, CROSS_ANY, out, 0);
    expect(f2).toBeCloseTo(0.3, 12);
    expect(out[FL_PX]).toBe(6.7);
  });

  test('到达击球高度：axis = y、c = 击球高度、CROSS_DOWN；上升段不报告', () => {
    const out = new Float64Array(FL_KINEMATIC);
    expect(crossSubstep(kin([0, 0.8, 0, 1, 2, 0]), 0, kin([0, 1.2, 0, 1, 1, 0]), 0, FL_PY, 1, CROSS_DOWN, out, 0)).toBe(NO_CROSS);
    const f = crossSubstep(kin([0, 1.2, 0, 1, -1, 0]), 0, kin([0, 0.8, 0, 1, -2, 0]), 0, FL_PY, 1, CROSS_DOWN, out, 0);
    expect(f).toBeCloseTo(0.5, 12);
    expect(out[FL_PY]).toBe(1);
  });
});

describe('crossSubstep：随机性质', () => {
  test('f ∈ (0,1]、out[oo+axis] === c 精确、其余 5 个分量 = prev + (cur − prev)·f；方向不符或未穿越不写 out', () => {
    const r = new Rng(0xbadf00d);
    const out = new Float64Array(2 + FL_KINEMATIC);
    const DIRS = [CROSS_DOWN, CROSS_ANY, CROSS_UP];
    let crossed = 0;
    let wrongDir = 0;
    for (let n = 0; n < 20000; n++) {
      const prev = new Float64Array(FL_KINEMATIC);
      const cur = new Float64Array(FL_KINEMATIC);
      for (let i = 0; i < FL_KINEMATIC; i++) {
        prev[i] = r.next() * 20 - 10;
        cur[i] = r.next() * 20 - 10;
      }
      const axis = n % 3 === 0 ? FL_PX : n % 3 === 1 ? FL_PY : FL_PZ;
      const c = r.next() * 20 - 10;
      // 方向随机取三种之一（包括与实际运动方向相反的），判据独立写出
      const dir = DIRS[r.nextU32() % 3]!;
      out.fill(SENTINEL);
      const f = crossSubstep(prev, 0, cur, 0, axis, c, dir, out, 2);
      const a0 = prev[axis]!;
      const a1 = cur[axis]!;
      const downCross = a0 > c && a1 <= c;
      const upCross = a0 < c && a1 >= c;
      const shouldCross = (dir !== CROSS_UP && downCross) || (dir !== CROSS_DOWN && upCross);
      if (!shouldCross) {
        if (downCross || upCross) wrongDir++;
        expect(f).toBe(NO_CROSS);
        for (let i = 0; i < out.length; i++) expect(out[i]).toBe(SENTINEL);
        continue;
      }
      crossed++;
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(1);
      expect(out[0]).toBe(SENTINEL);
      expect(out[1]).toBe(SENTINEL);
      expect(out[2 + axis]).toBe(c);
      for (let i = 0; i < FL_KINEMATIC; i++) {
        if (i === axis) continue;
        expect(out[2 + i]).toBe(prev[i]! + (cur[i]! - prev[i]!) * f);
        expect(out[2 + i]).toBeCloseTo(prev[i]! * (1 - f) + cur[i]! * f, 10);
      }
    }
    // 期望约 2/3·(1/3)·20000 ≈ 4400 次穿越、约 2200 次方向不符
    expect(crossed).toBeGreaterThan(3000);
    expect(wrongDir).toBeGreaterThan(1000);
  });
});

describe('crossSubstep：端点与未穿越', () => {
  test('未穿越返回 NO_CROSS 且不写 out', () => {
    const out = new Float64Array(FL_KINEMATIC).fill(SENTINEL);
    // 两端都在阈值上方
    expect(crossSubstep(kin([0, 3, 0, 1, -1, 0]), 0, kin([0, 2, 0, 1, -2, 0]), 0, FL_PY, 0, CROSS_DOWN, out, 0)).toBe(NO_CROSS);
    // 两端都在阈值下方
    expect(crossSubstep(kin([0, -3, 0, 1, -1, 0]), 0, kin([0, -2, 0, 1, -2, 0]), 0, FL_PY, 0, CROSS_ANY, out, 0)).toBe(NO_CROSS);
    // 水平移动（a0 = a1 ≠ c），不能除以 0
    expect(crossSubstep(kin([0, 1, 0, 1, 0, 0]), 0, kin([1, 1, 0, 1, 0, 0]), 0, FL_PY, 0, CROSS_ANY, out, 0)).toBe(NO_CROSS);
    // 两端都恰在阈值上
    expect(crossSubstep(kin([0, 0, 0, 1, 0, 0]), 0, kin([1, 0, 0, 1, 0, 0]), 0, FL_PY, 0, CROSS_ANY, out, 0)).toBe(NO_CROSS);
    // NaN 不算穿越
    expect(crossSubstep(kin([0, NaN, 0, 1, 0, 0]), 0, kin([1, -1, 0, 1, 0, 0]), 0, FL_PY, 0, CROSS_ANY, out, 0)).toBe(NO_CROSS);
    expect(crossSubstep(kin([0, 1, 0, 1, 0, 0]), 0, kin([1, NaN, 0, 1, 0, 0]), 0, FL_PY, 0, CROSS_ANY, out, 0)).toBe(NO_CROSS);
    for (let i = 0; i < FL_KINEMATIC; i++) expect(out[i]).toBe(SENTINEL);
  });

  test('起点恰在阈值上不算穿越（上一子步已报告过）', () => {
    const out = new Float64Array(FL_KINEMATIC).fill(SENTINEL);
    expect(crossSubstep(kin([0, 0, 0, 1, -1, 0]), 0, kin([1, -0.5, 0, 1, -2, 0]), 0, FL_PY, 0, CROSS_DOWN, out, 0)).toBe(NO_CROSS);
    expect(crossSubstep(kin([0, 0, 0, 1, 1, 0]), 0, kin([1, 0.5, 0, 1, 2, 0]), 0, FL_PY, 0, CROSS_UP, out, 0)).toBe(NO_CROSS);
    expect(crossSubstep(kin([0, 0, 0, 1, 1, 0]), 0, kin([1, 0.5, 0, 1, 2, 0]), 0, FL_PY, 0, CROSS_ANY, out, 0)).toBe(NO_CROSS);
    for (let i = 0; i < FL_KINEMATIC; i++) expect(out[i]).toBe(SENTINEL);
  });

  test('终点恰在阈值上算穿越且 f = 1，插值点 ≈ 终点', () => {
    const out = new Float64Array(FL_KINEMATIC);
    const cur = [0.7, 0, 0.3, 2.9, -4.1, 0.2];
    expect(crossSubstep(kin([0.1, 0.4, 0.1, 3.1, -3.9, 0.3]), 0, kin(cur), 0, FL_PY, 0, CROSS_DOWN, out, 0)).toBe(1);
    expect(out[FL_PY]).toBe(0);
    for (let i = 0; i < FL_KINEMATIC; i++) expect(out[i]).toBeCloseTo(cur[i]!, 14);
    expect(crossSubstep(kin([0, -0.4, 0, 1, 3, 0]), 0, kin([0, 1, 0, 1, 2, 0]), 0, FL_PY, 1, CROSS_UP, out, 0)).toBe(1);
    expect(out[FL_PY]).toBe(1);
  });

  test('连续两个子步：终点在阈值上只在前一个子步报告一次', () => {
    const out = new Float64Array(FL_KINEMATIC);
    const a = kin([0, 0.5, 0, 1, -1, 0]);
    const b = kin([1, 0, 0, 1, -1, 0]);
    const c = kin([2, -0.5, 0, 1, -1, 0]);
    expect(crossSubstep(a, 0, b, 0, FL_PY, 0, CROSS_DOWN, out, 0)).toBe(1);
    expect(crossSubstep(b, 0, c, 0, FL_PY, 0, CROSS_DOWN, out, 0)).toBe(NO_CROSS);
  });
});

describe('crossSubstep：偏移量 po / co / oo', () => {
  test('三个偏移各自生效，且可共用同一个数组（同内核语料的用法）', () => {
    const prevV = [1, 1, 0.2, 4, -2, 0.5];
    const curV = [2, -1, 0.4, 3, -6, 0.1];
    const expected = [1.5, 0, 0.30000000000000004, 3.5, -4, 0.3];

    const prev = kin(prevV, 3, SENTINEL);
    const cur = kin(curV, 7, SENTINEL);
    const out = new Float64Array(20).fill(SENTINEL);
    expect(crossSubstep(prev, 3, cur, 7, FL_PY, 0, CROSS_DOWN, out, 9)).toBe(0.5);
    expect(Array.from(out.subarray(9, 9 + FL_KINEMATIC))).toEqual(expected);
    for (let i = 0; i < out.length; i++) if (i < 9 || i >= 9 + FL_KINEMATIC) expect(out[i]).toBe(SENTINEL);

    // 同一个数组：[0..8) 球（8 槽）、[8..14) 起点、[14..20) 事件输出
    const s = new Float64Array(20).fill(SENTINEL);
    for (let i = 0; i < FL_KINEMATIC; i++) {
      s[i] = curV[i]!;
      s[8 + i] = prevV[i]!;
    }
    expect(crossSubstep(s, 8, s, 0, FL_PY, 0, CROSS_DOWN, s, 14)).toBe(0.5);
    expect(Array.from(s.subarray(14, 20))).toEqual(expected);
    expect(Array.from(s.subarray(0, FL_KINEMATIC))).toEqual(curV);
    expect(Array.from(s.subarray(8, 14))).toEqual(prevV);
  });

  test('偏移让阈值分量落在正确位置（axis 相对偏移计）', () => {
    const out = new Float64Array(12).fill(SENTINEL);
    const p = kin([10, 0, 0, -5, 0, 0], 2);
    const c = kin([5, 0, 0, -5, 0, 0], 4);
    expect(crossSubstep(p, 2, c, 4, FL_PX, 6.7, CROSS_DOWN, out, 5)).toBeCloseTo(0.66, 12);
    expect(out[5 + FL_PX]).toBe(6.7);
    expect(out[5 + FL_VX]).toBe(-5);
    expect(out[5 + FL_VY]).toBe(0);
    expect(out[5 + FL_VZ]).toBe(0);
  });
});

describe('eventTimeU：子步起点 + f·500u，四舍五入一次', () => {
  test('端点与典型值', () => {
    expect(U_PER_SUBSTEP).toBe(500);
    expect(eventTimeU(1000, 0)).toBe(1000);
    expect(eventTimeU(1000, 1)).toBe(1500);
    expect(eventTimeU(0, 0.5)).toBe(250);
    expect(eventTimeU(1000, 0.001)).toBe(1001); // 0.5u → 进 1
    expect(eventTimeU(1000, 0.0009)).toBe(1000); // 0.45u → 舍
    expect(eventTimeU(1000, 0.003)).toBe(1002); // 1.5u → 2
    expect(eventTimeU(1000, 0.999)).toBe(1500); // 499.5u → 500
    expect(eventTimeU(1000, 0.998)).toBe(1499);
    expect(eventTimeU(29500, 1)).toBe(30000);
  });

  test('结果总是整数且落在 [起点, 起点 + 500]', () => {
    const r = new Rng(77);
    for (let i = 0; i < 10000; i++) {
      const start = (r.nextU32() % 1000) * U_PER_SUBSTEP;
      const f = r.next();
      const t = eventTimeU(start, f);
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(start);
      expect(t).toBeLessThanOrEqual(start + U_PER_SUBSTEP);
      expect(Math.abs(t - (start + f * U_PER_SUBSTEP))).toBeLessThanOrEqual(0.5);
    }
  });
});
