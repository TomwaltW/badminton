/**
 * 飞行单测：方案 §2.4 的复核数、时间缩放恒等式（计划 T1 线：α 0.4–1.5 落点偏移 ≤5 mm）、
 * 子步插值相对不插值的收益、flightLaunch 的缩放、stepRk4 原地更新且不越界。
 *
 * 测试代码可以用 Math.cos/Math.sin 设初速度（测试不是模拟核心）。
 */
import { describe, expect, test } from 'bun:test';
import { dsqrt, type SqrtFn } from '../src/math';
import {
  FL_G,
  FL_K,
  FL_KINEMATIC,
  FL_PX,
  FL_PY,
  FL_PZ,
  FL_STRIDE,
  FL_VX,
  FL_VY,
  FL_VZ,
  G_STD,
  K_STD,
  SIM_HZ,
  SUBSTEPS_PER_TICK,
  SUBSTEP_DT,
  U_PER_SUBSTEP,
  U_PER_TICK,
  VT_STD,
  copyKinematics,
  dragFromTerminal,
  flightLaunch,
  stepRk4,
  stepSubstep,
} from '../src/flight';
import { CROSS_DOWN, NO_CROSS, crossSubstep } from '../src/events';

const ALPHAS = [0.4, 0.6, 0.8, 1.0, 1.2, 1.3, 1.5];

interface Landing {
  /** 插值落点 x（m）。 */
  x: number;
  /** 插值落点 z（m）。 */
  z: number;
  /** 插值滞空（s，游戏时间）。 */
  t: number;
  /** 不插值：第一个 y ≤ 0 的子步终点的 x。 */
  rawX: number;
  /** 不插值的滞空（子步数 × 1/60）。 */
  rawT: number;
  /** 子步数。 */
  substeps: number;
}

/**
 * 从 (px, py, pz) 以真实初速度 (vx, vy, vz) 发射、时间缩放 α，逐子步积分到落地。
 * 落地用 events.crossSubstep 插值（axis = y，c = 0，向下）。
 */
function fly(px: number, py: number, pz: number, vx: number, vy: number, vz: number, alpha: number, sqrt: SqrtFn = dsqrt): Landing {
  const s = new Float64Array(FL_STRIDE);
  const prev = new Float64Array(FL_KINEMATIC);
  const out = new Float64Array(FL_KINEMATIC);
  flightLaunch(s, 0, px, py, pz, vx, vy, vz, alpha, G_STD, K_STD);
  for (let n = 1; n <= 100000; n++) {
    stepSubstep(s, 0, prev, 0, sqrt);
    const f = crossSubstep(prev, 0, s, 0, FL_PY, 0, CROSS_DOWN, out, 0);
    if (f !== NO_CROSS) {
      return { x: out[FL_PX], z: out[FL_PZ], t: (n - 1 + f) * SUBSTEP_DT, rawX: s[FL_PX], rawT: n * SUBSTEP_DT, substeps: n };
    }
  }
  throw new Error('100000 个子步内没有落地');
}

/** 方案 §2.4 的高远球：v0 = 60 m/s、仰角 38°、出手 (0, 2.8, 0)。 */
function clear(alpha: number): Landing {
  const th = (38 * Math.PI) / 180;
  return fly(0, 2.8, 0, 60 * Math.cos(th), 60 * Math.sin(th), 0, alpha);
}

/** 平抽/扣杀类：v0 = 60 m/s、俯角 10°、出手 2.8 m（落地时水平速度大，不插值误差显著）。 */
function smash(alpha: number): Landing {
  const th = (-10 * Math.PI) / 180;
  return fly(0, 2.8, 0, 60 * Math.cos(th), 60 * Math.sin(th), 0, alpha);
}

describe('常数', () => {
  test('时间单位与子步', () => {
    expect(SUBSTEP_DT).toBe(1 / 60);
    expect(SIM_HZ * SUBSTEPS_PER_TICK).toBe(60);
    expect(U_PER_SUBSTEP * SUBSTEPS_PER_TICK).toBe(U_PER_TICK);
    expect(SIM_HZ * U_PER_TICK).toBe(30000);
    expect(FL_STRIDE).toBe(8);
    expect(FL_KINEMATIC).toBe(6);
    expect([FL_PX, FL_PY, FL_PZ, FL_VX, FL_VY, FL_VZ, FL_G, FL_K]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test('dragFromTerminal(G, v_t) = K_STD ≈ 0.232', () => {
    expect(dragFromTerminal(G_STD, VT_STD)).toBe(K_STD);
    expect(K_STD).toBeCloseTo(0.2322, 4);
  });
});

describe('方案 §2.4 复核数（v0 = 60、38°、出手 2.8 m，v_t = 6.5，子步 1/60 s，落地插值）', () => {
  test('α = 1：射程 ≈ 11.910 m（±5 mm），滞空 ≈ 2.398 s（±0.01 s）', () => {
    const r = clear(1);
    expect(Math.abs(r.x - 11.91)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(r.t - 2.398)).toBeLessThanOrEqual(0.01);
    expect(r.z).toBe(0);
  });

  test('α = 1.3：射程 ≈ 11.910 m，滞空 ≈ 1.845 s', () => {
    const r = clear(1.3);
    expect(Math.abs(r.x - 11.91)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(r.t - 1.845)).toBeLessThanOrEqual(0.01);
  });

  test('Math.sqrt 路径与 dsqrt 路径落点相差 < 1 µm（两条路径只差末位）', () => {
    const th = (38 * Math.PI) / 180;
    const a = fly(0, 2.8, 0, 60 * Math.cos(th), 60 * Math.sin(th), 0, 1, dsqrt);
    const b = fly(0, 2.8, 0, 60 * Math.cos(th), 60 * Math.sin(th), 0, 1, Math.sqrt);
    expect(Math.abs(a.x - b.x)).toBeLessThan(1e-6);
  });
});

describe('时间缩放恒等式：g′ = α²g、v′ = αv、k 不变 ⇒ 射程不变、滞空 T/α', () => {
  const base = clear(1);

  test(`α ∈ {${ALPHAS.join(', ')}}：插值落点与 α = 1 相差 ≤ 1 mm（计划 T1 线为 5 mm）`, () => {
    let maxOff = 0;
    for (const a of ALPHAS) {
      const off = Math.abs(clear(a).x - base.x);
      if (off > maxOff) maxOff = off;
    }
    // 实测最大约 0.84 mm（α = 1.5）
    expect(maxOff).toBeLessThanOrEqual(0.001);
  });

  test('滞空 ≈ T/α（差 ≤ 0.2 ms）', () => {
    for (const a of ALPHAS) {
      const r = clear(a);
      expect(Math.abs(r.t - base.t / a)).toBeLessThanOrEqual(2e-4);
    }
  });

  test('扣杀类轨迹同样满足 ≤ 5 mm（T1 线）', () => {
    const b = smash(1);
    for (const a of ALPHAS) expect(Math.abs(smash(a).x - b.x)).toBeLessThanOrEqual(0.005);
  });
});

describe('子步插值相对不插值（取第一个 y ≤ 0 的子步终点）', () => {
  /** 在一组 α 上，插值版与不插值版各自相对 α = 1 的最大落点偏移。 */
  function maxOffsets(shot: (a: number) => Landing, alphas: number[]): { interp: number; raw: number } {
    const b = shot(1);
    let interp = 0;
    let raw = 0;
    for (const a of alphas) {
      const r = shot(a);
      interp = Math.max(interp, Math.abs(r.x - b.x));
      raw = Math.max(raw, Math.abs(r.rawX - b.rawX));
    }
    return { interp, raw };
  }

  const sweep: number[] = [];
  for (let i = 40; i <= 150; i++) sweep.push(i / 100);

  test('高远球、α 扫描 0.40..1.50（步长 0.01）：插值 ≤ 1 mm，不插值至少差一个数量级', () => {
    const m = maxOffsets(clear, sweep);
    // 实测：插值约 0.85 mm，不插值约 10.8 mm
    expect(m.interp).toBeLessThanOrEqual(0.001);
    expect(m.raw).toBeGreaterThanOrEqual(10 * m.interp);
  });

  test('扣杀类、7 个 α：插值 ≤ 1 mm，不插值至少差一个数量级', () => {
    const m = maxOffsets(smash, ALPHAS);
    // 实测：插值约 0.75 mm，不插值约 92 mm
    expect(m.interp).toBeLessThanOrEqual(0.001);
    expect(m.raw).toBeGreaterThanOrEqual(10 * m.interp);
    expect(m.raw).toBeGreaterThan(0.05);
  });

  test('高远球、7 个 α：只断言插值版（不插值版只差约 3 倍，见报告）', () => {
    const m = maxOffsets(clear, ALPHAS);
    // 实测：插值约 0.84 mm，不插值约 2.47 mm——这 7 个 α 恰好让落地都落在子步末端附近，
    // 不插值的误差没有放大到一个数量级；扫描与扣杀类用例证明了插值的收益。
    expect(m.interp).toBeLessThanOrEqual(0.001);
    expect(m.raw).toBeGreaterThan(m.interp);
  });
});

describe('flightLaunch', () => {
  test('写入 8 个槽：位置原样、v′ = αv、g′ = α²g、k 不变；偏移 o 生效且不越界', () => {
    const o = 5;
    const s = new Float64Array(o + FL_STRIDE + 4).fill(-777);
    const alpha = 1.3;
    flightLaunch(s, o, 1, 2, 3, 10, 20, -30, alpha, G_STD, K_STD);
    expect(s[o + FL_PX]).toBe(1);
    expect(s[o + FL_PY]).toBe(2);
    expect(s[o + FL_PZ]).toBe(3);
    expect(s[o + FL_VX]).toBe(10 * alpha);
    expect(s[o + FL_VY]).toBe(20 * alpha);
    expect(s[o + FL_VZ]).toBe(-30 * alpha);
    expect(s[o + FL_G]).toBe(G_STD * alpha * alpha);
    expect(s[o + FL_K]).toBe(K_STD);
    for (let i = 0; i < s.length; i++) if (i < o || i >= o + FL_STRIDE) expect(s[i]).toBe(-777);
  });

  test('α = 1 时 v 与 g 原样', () => {
    const s = new Float64Array(FL_STRIDE);
    flightLaunch(s, 0, 0, 0, 0, 1.1, 2.2, 3.3, 1, G_STD, K_STD);
    expect(Array.from(s.subarray(FL_VX, FL_STRIDE))).toEqual([1.1, 2.2, 3.3, G_STD, K_STD]);
  });

  test('缩放后的终端速度为 α·v_t（g′/k = α²·v_t²）', () => {
    for (const alpha of [0.5, 1, 1.5]) {
      const s = new Float64Array(FL_STRIDE);
      flightLaunch(s, 0, 0, 1000, 0, 0, 0, 0, alpha, G_STD, K_STD);
      for (let i = 0; i < 6000; i++) stepRk4(s, 0, SUBSTEP_DT, dsqrt);
      expect(s[FL_VY]).toBeCloseTo(-alpha * VT_STD, 9);
    }
  });
});

describe('stepRk4 / stepSubstep / copyKinematics', () => {
  test('原地更新：只写偏移 o 起的 6 个运动学槽，g、k 与数组其余部分不变', () => {
    const o = 11;
    const s = new Float64Array(o + FL_STRIDE + 7);
    for (let i = 0; i < s.length; i++) s[i] = 1000 + i;
    flightLaunch(s, o, 1, 2.8, 0.5, 30, 10, -2, 1.2, G_STD, K_STD);
    const before = Float64Array.from(s);
    stepRk4(s, o, SUBSTEP_DT, dsqrt);
    for (let i = 0; i < s.length; i++) {
      if (i >= o && i < o + FL_KINEMATIC) expect(s[i]).not.toBe(before[i]);
      else expect(s[i]).toBe(before[i]);
    }
  });

  test('结果只取决于 8 个槽：不同偏移逐位相同', () => {
    const a = new Float64Array(FL_STRIDE);
    const b = new Float64Array(3 + FL_STRIDE + 2);
    flightLaunch(a, 0, 1, 2.8, 0, 40, 15, 3, 0.7, G_STD, K_STD);
    flightLaunch(b, 3, 1, 2.8, 0, 40, 15, 3, 0.7, G_STD, K_STD);
    for (let i = 0; i < 50; i++) {
      stepRk4(a, 0, SUBSTEP_DT, dsqrt);
      stepRk4(b, 3, SUBSTEP_DT, dsqrt);
    }
    expect(Array.from(b.subarray(3, 3 + FL_STRIDE))).toEqual(Array.from(a));
  });

  test('k = 0（无阻力）时 RK4 对匀加速运动精确到舍入误差', () => {
    const s = new Float64Array(FL_STRIDE);
    flightLaunch(s, 0, 1, 2, 3, 5, 12, -4, 1, G_STD, 0);
    const n = 120;
    for (let i = 0; i < n; i++) stepRk4(s, 0, SUBSTEP_DT, dsqrt);
    const t = n * SUBSTEP_DT;
    expect(s[FL_PX]).toBeCloseTo(1 + 5 * t, 12);
    expect(s[FL_PY]).toBeCloseTo(2 + 12 * t - 0.5 * G_STD * t * t, 12);
    expect(s[FL_PZ]).toBeCloseTo(3 - 4 * t, 12);
    expect(s[FL_VX]).toBeCloseTo(5, 12);
    expect(s[FL_VY]).toBeCloseTo(12 - G_STD * t, 12);
    expect(s[FL_VZ]).toBeCloseTo(-4, 12);
  });

  test('阻力只减速：水平速度单调减小，|v| 在上升段单调减小', () => {
    const s = new Float64Array(FL_STRIDE);
    flightLaunch(s, 0, 0, 2.8, 0, 50, 30, 0, 1, G_STD, K_STD);
    let vx = s[FL_VX];
    let speed = dsqrt(s[FL_VX] * s[FL_VX] + s[FL_VY] * s[FL_VY]);
    while (s[FL_VY] > 0) {
      stepRk4(s, 0, SUBSTEP_DT, dsqrt);
      expect(s[FL_VX]).toBeLessThan(vx);
      const sp = dsqrt(s[FL_VX] * s[FL_VX] + s[FL_VY] * s[FL_VY]);
      expect(sp).toBeLessThan(speed);
      vx = s[FL_VX];
      speed = sp;
    }
  });

  test('stepSubstep = 先 copyKinematics 存起点，再 stepRk4(1/60)', () => {
    const o = 2;
    const po = 4;
    const a = new Float64Array(o + FL_STRIDE);
    const b = new Float64Array(FL_STRIDE);
    const prev = new Float64Array(po + FL_KINEMATIC + 3).fill(-1);
    flightLaunch(a, o, 1, 2.8, 0, 33, 22, 1, 1.1, G_STD, K_STD);
    flightLaunch(b, 0, 1, 2.8, 0, 33, 22, 1, 1.1, G_STD, K_STD);
    const start = Array.from(a.subarray(o, o + FL_KINEMATIC));
    stepSubstep(a, o, prev, po, dsqrt);
    stepRk4(b, 0, SUBSTEP_DT, dsqrt);
    expect(Array.from(prev.subarray(po, po + FL_KINEMATIC))).toEqual(start);
    expect(Array.from(a.subarray(o, o + FL_STRIDE))).toEqual(Array.from(b));
    for (let i = 0; i < prev.length; i++) if (i < po || i >= po + FL_KINEMATIC) expect(prev[i]).toBe(-1);
  });

  test('copyKinematics 只复制 6 个槽并尊重偏移', () => {
    const src = Float64Array.from([9, 1, 2, 3, 4, 5, 6, 7, 8]);
    const dst = new Float64Array(10).fill(-1);
    copyKinematics(src, 1, dst, 3);
    expect(Array.from(dst)).toEqual([-1, -1, -1, 1, 2, 3, 4, 5, 6, -1]);
  });
});
