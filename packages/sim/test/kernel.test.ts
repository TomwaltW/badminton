/**
 * 内核语料单测：确定性、检查点结构、参数敏感性、自定义生成器、tick/子步计数关系。
 * 不写死哈希值（源码一改就变；跨引擎一致性由 det 门禁互比）。
 */
import { describe, expect, test } from 'bun:test';
import { dsqrt, type SqrtFn } from '../src/math';
import { RNG_AI_A, RNG_AI_B, RNG_SCATTER, RNG_STREAMS, deriveRngStreams, rngNextU32, rngNextUnit } from '../src/rng';
import { FNV_OFFSET } from '../src/hash';
import { FL_PY, FL_STRIDE, G_STD, K_STD, SUBSTEP_DT, flightLaunch, stepRk4 } from '../src/flight';
import {
  CP_SHOT_END,
  CP_STRIDE,
  CP_TICK,
  KERNEL_CHECK_EVERY,
  KERNEL_CORPUS_VERSION,
  KERNEL_DEFAULT_SEED,
  KERNEL_DEFAULT_SHOTS,
  KERNEL_MAX_TICKS_PER_SHOT,
  SG_ALPHA,
  SG_LEN,
  SG_PX,
  SG_PY,
  SG_PZ,
  SG_VX,
  SG_VY,
  SG_VZ,
  runKernel,
  runKernelWith,
  shotGenSpike,
  type KernelResult,
  type ShotGen,
} from '../src/kernel';

const SMALL = 200;

/** 检查点结构的全部不变式。 */
function checkStructure(r: KernelResult): void {
  const cp = r.checkpoints;
  expect(cp.length % CP_STRIDE).toBe(0);
  let lastShot = 0;
  let lastTick = 0;
  let tickCps = 0;
  let endCps = 0;
  for (let i = 0; i < cp.length; i += CP_STRIDE) {
    const kind = cp[i]!;
    const shot = cp[i + 1]!;
    const tick = cp[i + 2]!;
    const hash = cp[i + 3]!;
    expect(kind === CP_TICK || kind === CP_SHOT_END).toBe(true);
    expect(shot).toBeGreaterThanOrEqual(lastShot);
    expect(tick).toBeGreaterThanOrEqual(lastTick);
    expect(shot).toBeLessThan(r.shots);
    expect(tick).toBeLessThanOrEqual(r.steps);
    expect(Number.isInteger(hash) && hash >= 0 && hash <= 0xffffffff).toBe(true);
    if (kind === CP_TICK) {
      tickCps++;
      expect(tick % KERNEL_CHECK_EVERY).toBe(0);
      // 每个 30 的倍数恰好出现一次（全局 tick 连续递增）
      expect(tick).toBe(tickCps * KERNEL_CHECK_EVERY);
    } else {
      // 第 k 个拍尾检查点属于第 k 拍
      expect(shot).toBe(endCps);
      endCps++;
    }
    lastShot = shot;
    lastTick = tick;
  }
  expect(endCps).toBe(r.shots);
  expect(tickCps).toBe(Math.floor(r.steps / KERNEL_CHECK_EVERY));
  if (r.shots > 0) {
    const last = cp.length - CP_STRIDE;
    expect(cp[last]).toBe(CP_SHOT_END);
    expect(cp[last + 1]).toBe(r.shots - 1);
    expect(cp[last + 2]).toBe(r.steps);
    expect(cp[last + 3]).toBe(r.hash);
  }
}

/** 双精度数的下一个可表示值（正数）。 */
function nextUp(x: number): number {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  dv.setBigUint64(0, dv.getBigUint64(0) + 1n);
  return dv.getFloat64(0);
}

/** 固定发射参数的生成器（方案 §2.4 的高远球，α 可选）；不消耗随机数。vxTweak 可把 vx 换成别的值。 */
function fixedGen(alpha: number, vxTweak?: (vx: number) => number): ShotGen {
  const th = (38 * Math.PI) / 180;
  const vx = vxTweak ? vxTweak(60 * Math.cos(th)) : 60 * Math.cos(th);
  const vy = 60 * Math.sin(th);
  return (_rng, _ro, _sqrt, out, oo) => {
    out[oo + SG_PX] = 0;
    out[oo + SG_PY] = 2.8;
    out[oo + SG_PZ] = 0;
    out[oo + SG_VX] = vx;
    out[oo + SG_VY] = vy;
    out[oo + SG_VZ] = 0;
    out[oo + SG_ALPHA] = alpha;
  };
}

describe('常数', () => {
  test('默认值与检查点布局', () => {
    expect(KERNEL_CORPUS_VERSION).toBeGreaterThanOrEqual(1);
    expect(KERNEL_DEFAULT_SHOTS).toBe(2000);
    expect(KERNEL_DEFAULT_SEED).toBe(0x2545f491);
    expect(KERNEL_CHECK_EVERY).toBe(30);
    expect([CP_TICK, CP_SHOT_END, CP_STRIDE]).toEqual([0, 1, 4]);
    expect(SG_LEN).toBe(7);
  });
});

describe('确定性与结构', () => {
  test(`同参数两次运行结果全同（${SMALL} 拍）`, () => {
    const a = runKernel({ shots: SMALL });
    const b = runKernel({ shots: SMALL });
    expect(b).toEqual(a);
    expect(a.corpusVersion).toBe(KERNEL_CORPUS_VERSION);
    expect(a.shots).toBe(SMALL);
  });

  test(`检查点结构（${SMALL} 拍）`, () => {
    checkStructure(runKernel({ shots: SMALL }));
  });

  test('checkpoints: false 时哈希与计数不变、检查点为空', () => {
    const a = runKernel({ shots: SMALL });
    const b = runKernel({ shots: SMALL, checkpoints: false });
    expect(b.hash).toBe(a.hash);
    expect(b.steps).toBe(a.steps);
    expect(b.substeps).toBe(a.substeps);
    expect(b.checkpoints).toEqual([]);
  });

  test('substeps ∈ [2·steps − shots, 2·steps]（落地那个 tick 可能只走 1 个子步）', () => {
    for (const shots of [1, 17, SMALL]) {
      const r = runKernel({ shots });
      expect(r.substeps).toBeLessThanOrEqual(2 * r.steps);
      expect(r.substeps).toBeGreaterThanOrEqual(2 * r.steps - shots);
    }
  });

  test('0 拍：哈希 = FNV 偏移基数，计数为 0，检查点为空', () => {
    const r = runKernel({ shots: 0 });
    expect(r.hash).toBe(FNV_OFFSET >>> 0);
    expect(r.steps).toBe(0);
    expect(r.substeps).toBe(0);
    expect(r.checkpoints).toEqual([]);
  });

  test('前缀性质：少拍的检查点序列是多拍的前缀，最终哈希 = 多拍里对应拍尾的哈希（det 据此定位首个分歧）', () => {
    const small = runKernel({ shots: 50 });
    const big = runKernel({ shots: SMALL });
    expect(big.checkpoints.slice(0, small.checkpoints.length)).toEqual(small.checkpoints);
    const lastSmall = small.checkpoints.length - CP_STRIDE;
    expect(small.checkpoints[lastSmall]).toBe(CP_SHOT_END);
    expect(small.checkpoints[lastSmall + 3]).toBe(small.hash);
  });
});

describe('参数敏感性', () => {
  const base = runKernel({ shots: SMALL });

  test('shots 改变哈希', () => {
    expect(runKernel({ shots: SMALL - 1 }).hash).not.toBe(base.hash);
    expect(runKernel({ shots: SMALL + 1 }).hash).not.toBe(base.hash);
  });

  test('seed 改变哈希；显式传默认种子不变', () => {
    expect(runKernel({ shots: SMALL, seed: KERNEL_DEFAULT_SEED + 1 }).hash).not.toBe(base.hash);
    expect(runKernel({ shots: SMALL, seed: 1 }).hash).not.toBe(base.hash);
    expect(runKernel({ shots: SMALL, seed: KERNEL_DEFAULT_SEED }).hash).toBe(base.hash);
  });

  test('sqrt：Math.sqrt 路径改变哈希；显式传 dsqrt 不变', () => {
    const m = runKernel({ shots: SMALL, sqrt: Math.sqrt });
    expect(m.hash).not.toBe(base.hash);
    checkStructure(m);
    expect(runKernel({ shots: SMALL, sqrt: dsqrt }).hash).toBe(base.hash);
  });

  test('sqrt 被真正调用（注入计数的 sqrt）', () => {
    let calls = 0;
    const counting: SqrtFn = (x) => {
      calls++;
      return dsqrt(x);
    };
    const r = runKernel({ shots: 20, sqrt: counting });
    expect(r.hash).toBe(runKernel({ shots: 20 }).hash);
    // 每个子步 4 次 + 每拍归一 1 次
    expect(calls).toBe(4 * r.substeps + r.shots);
  });
});

describe('runWith 自定义生成器', () => {
  test('生成器生效：哈希不同于标准语料，且自身确定', () => {
    const a = runKernelWith(fixedGen(1), { shots: 30 });
    const b = runKernelWith(fixedGen(1), { shots: 30 });
    expect(b).toEqual(a);
    expect(a.hash).not.toBe(runKernel({ shots: 30 }).hash);
    expect(runKernelWith(fixedGen(1.2), { shots: 30 }).hash).not.toBe(a.hash);
    checkStructure(a);
  });

  test('固定的高远球每拍 tick 数相同：72 tick（滞空 2.398 s），落在该 tick 的第 2 个子步', () => {
    const one = runKernelWith(fixedGen(1), { shots: 1 });
    expect(one.steps).toBe(72);
    expect(one.substeps).toBe(144);
    const many = runKernelWith(fixedGen(1), { shots: 25 });
    expect(many.steps).toBe(25 * one.steps);
    expect(many.substeps).toBe(25 * one.substeps);
  });

  test('生成器拿到注入的 sqrt 与可用的随机流', () => {
    const seen: SqrtFn[] = [];
    const gen: ShotGen = (rng, ro, sqrt, out, oo) => {
      seen.push(sqrt);
      fixedGen(0.4 + rngNextUnit(rng, ro + RNG_SCATTER))(rng, ro, sqrt, out, oo);
    };
    const a = runKernelWith(gen, { shots: 5, sqrt: Math.sqrt });
    expect(seen.length).toBe(5);
    for (const s of seen) expect(s).toBe(Math.sqrt);
    // 散布流由种子派生：换种子，α 不同，哈希不同
    expect(runKernelWith(gen, { shots: 5, sqrt: Math.sqrt, seed: 7 }).hash).not.toBe(a.hash);
  });

  test('每 30 tick 混入完整状态：初速差 1 ulp，第一个 CP_TICK（tick 30）的哈希就不同', () => {
    const a = runKernelWith(fixedGen(1), { shots: 1 });
    const b = runKernelWith(fixedGen(1, nextUp), { shots: 1 });
    expect(b.steps).toBe(a.steps);
    // 两次的检查点都是 [CP_TICK@30, CP_TICK@60, CP_SHOT_END@72]
    expect([a.checkpoints[0], a.checkpoints[2]]).toEqual([CP_TICK, KERNEL_CHECK_EVERY]);
    expect([b.checkpoints[0], b.checkpoints[2]]).toEqual([CP_TICK, KERNEL_CHECK_EVERY]);
    // 拍首混入的 AI-A/AI-B 随机数相同；只有混入了飞行状态，tick 30 的哈希才会不同
    expect(b.checkpoints[3]).not.toBe(a.checkpoints[3]);
    expect(b.hash).not.toBe(a.hash);
  });

  test('tick / 子步计数与独立的逐子步积分一致；落地的子步若是 tick 的第 1 个，该 tick 不再走第 2 个', () => {
    const th = (38 * Math.PI) / 180;
    let oddSeen = false;
    for (const alpha of [0.6, 0.8, 1, 1.2, 1.3, 1.5]) {
      // 独立计数：从出手积分到第一次 y ≤ 0（与 crossSubstep 的向下判据 a0 > 0 ≥ a1 相同）
      const s = new Float64Array(FL_STRIDE);
      flightLaunch(s, 0, 0, 2.8, 0, 60 * Math.cos(th), 60 * Math.sin(th), 0, alpha, G_STD, K_STD);
      let n = 0;
      while (s[FL_PY]! > 0) {
        stepRk4(s, 0, SUBSTEP_DT, dsqrt);
        n++;
      }
      if (n % 2 === 1) oddSeen = true;
      const r = runKernelWith(fixedGen(alpha), { shots: 1 });
      expect(r.substeps).toBe(n);
      expect(r.steps).toBe(Math.ceil(n / 2));
    }
    // 至少有一个 α 落在 tick 的第 1 个子步（实测 α = 1.3：111 个子步、56 tick）
    expect(oddSeen).toBe(true);
  });

  test('AI-A、AI-B 两路每拍各推进一次（在调用生成器之前），散布流由种子派生', () => {
    const seed = 0x1234;
    const ref = new Int32Array(RNG_STREAMS);
    deriveRngStreams(seed, ref, 0);
    const seenA: number[] = [];
    const seenB: number[] = [];
    let firstScatter = 0;
    const gen: ShotGen = (rng, ro, sqrt, out, oo) => {
      if (seenA.length === 0) firstScatter = rng[ro + RNG_SCATTER]!;
      seenA.push(rng[ro + RNG_AI_A]!);
      seenB.push(rng[ro + RNG_AI_B]!);
      fixedGen(1)(rng, ro, sqrt, out, oo);
    };
    runKernelWith(gen, { shots: 4, seed });
    expect(firstScatter).toBe(ref[RNG_SCATTER]!);
    const expA: number[] = [];
    const expB: number[] = [];
    for (let k = 0; k < 4; k++) {
      rngNextU32(ref, RNG_AI_A);
      rngNextU32(ref, RNG_AI_B);
      expA.push(ref[RNG_AI_A]!);
      expB.push(ref[RNG_AI_B]!);
    }
    expect(seenA).toEqual(expA);
    expect(seenB).toEqual(expB);
  });

  test('不落地的球在 KERNEL_MAX_TICKS_PER_SHOT 处截断（α = 0：v′ = 0、g′ = 0）', () => {
    const r = runKernelWith(fixedGen(0), { shots: 2 });
    expect(KERNEL_MAX_TICKS_PER_SHOT).toBe(900);
    expect(r.steps).toBe(2 * KERNEL_MAX_TICKS_PER_SHOT);
    expect(r.substeps).toBe(2 * r.steps);
    checkStructure(r);
  });
});

describe('shotGenSpike（原脚本的发射分布）', () => {
  test('出手点 (1, 2.8, 0)，初速 ∈ [20, 80)，α ∈ [0.4, 1.5)，只消耗散布流', () => {
    const rng = Int32Array.from([11, 22, 33]);
    const out = new Float64Array(3 + SG_LEN + 2).fill(-9);
    for (let i = 0; i < 5000; i++) {
      shotGenSpike(rng, 0, dsqrt, out, 3);
      expect(out[3 + SG_PX]).toBe(1);
      expect(out[3 + SG_PY]).toBe(2.8);
      expect(out[3 + SG_PZ]).toBe(0);
      const vx = out[3 + SG_VX]!;
      const vy = out[3 + SG_VY]!;
      const vz = out[3 + SG_VZ]!;
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      expect(sp).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(sp).toBeLessThan(80 + 1e-9);
      expect(vx).toBeGreaterThan(0);
      expect(out[3 + SG_ALPHA]).toBeGreaterThanOrEqual(0.4);
      expect(out[3 + SG_ALPHA]).toBeLessThan(1.5);
    }
    expect(rng[0]).toBe(11);
    expect(rng[1]).toBe(22);
    expect(rng[2]).not.toBe(33);
    expect(Array.from(out.subarray(0, 3))).toEqual([-9, -9, -9]);
    expect(Array.from(out.subarray(3 + SG_LEN))).toEqual([-9, -9]);
  });
});

describe(`默认语料（${KERNEL_DEFAULT_SHOTS} 拍）`, () => {
  test('默认参数 = 显式默认参数，结构完整，计数关系成立', () => {
    const a = runKernel();
    const b = runKernel({ shots: KERNEL_DEFAULT_SHOTS, seed: KERNEL_DEFAULT_SEED, sqrt: dsqrt, checkpoints: true });
    expect(b).toEqual(a);
    expect(a.shots).toBe(KERNEL_DEFAULT_SHOTS);
    checkStructure(a);
    expect(a.substeps).toBeLessThanOrEqual(2 * a.steps);
    expect(a.substeps).toBeGreaterThanOrEqual(2 * a.steps - a.shots);
    // 没有一拍被截断：每拍 tick 数远低于上限
    expect(a.steps).toBeLessThan(a.shots * KERNEL_MAX_TICKS_PER_SHOT);
  });

  test('Math.sqrt 路径步数相同、哈希不同', () => {
    const a = runKernel({ checkpoints: false });
    const m = runKernel({ checkpoints: false, sqrt: Math.sqrt });
    expect(m.hash).not.toBe(a.hash);
    // 两条路径只差末位，不足以让任何一拍的落地 tick 改变（实测相同；若将来不同，只说明语料更敏感）
    expect(m.steps).toBe(a.steps);
  });
});
