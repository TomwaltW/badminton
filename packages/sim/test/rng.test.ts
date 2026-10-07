/**
 * 随机数单测：xorshift32（13/17/5）与独立的 BigInt 参考实现逐个一致；rngNextUnit ∈ [0,1)；
 * 种子派生 3 路流（AI-A、AI-B、散布）互不相同、非零、确定；派生到 0 时落到回退状态；Rng 类与槽函数一致。
 */
import { describe, expect, test } from 'bun:test';
import {
  RNG_AI_A,
  RNG_AI_B,
  RNG_FALLBACK_STATE,
  RNG_SCATTER,
  RNG_STREAMS,
  Rng,
  deriveRngStreams,
  mixSeed32,
  rngNextRange,
  rngNextU32,
  rngNextUnit,
} from '../src/rng';

const M32 = 0xffffffffn;

/** 参考 xorshift32：u32 BigInt 状态 → 下一个状态（= 输出）。 */
function refXorshift(x: bigint): bigint {
  x ^= (x << 13n) & M32;
  x ^= x >> 17n;
  x ^= (x << 5n) & M32;
  return x;
}

/** 参考 xorshift32 的逆：给定输出求上一个状态（用于构造 u32 = 0xffffffff 的边界）。 */
function refXorshiftInverse(y: bigint): bigint {
  // 逆 x ^= x << 5
  let x = y;
  for (let i = 0; i < 7; i++) x = y ^ ((x << 5n) & M32);
  // 逆 x ^= x >> 17
  const y2 = x;
  for (let i = 0; i < 2; i++) x = y2 ^ (x >> 17n);
  // 逆 x ^= x << 13
  const y3 = x;
  for (let i = 0; i < 3; i++) x = y3 ^ ((x << 13n) & M32);
  return x;
}

/** 参考 lowbias32（u32 BigInt）。 */
function refMix(x: bigint): bigint {
  x ^= x >> 16n;
  x = (x * 0x7feb352dn) & M32;
  x ^= x >> 15n;
  x = (x * 0x846ca68bn) & M32;
  x ^= x >> 16n;
  return x;
}

/** 参考派生：第 i 路 = lowbias32(seed + 0x9e3779b9·(i+1) mod 2^32)，为 0 则用回退状态。返回 u32。 */
function refDerive(seed: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const s = Number(refMix((BigInt(seed >>> 0) + 0x9e3779b9n * BigInt(i + 1)) & M32));
    out.push(s === 0 ? RNG_FALLBACK_STATE : s);
  }
  return out;
}

describe('xorshift32', () => {
  test('流下标与常数', () => {
    expect([RNG_AI_A, RNG_AI_B, RNG_SCATTER, RNG_STREAMS]).toEqual([0, 1, 2, 3]);
    expect(RNG_FALLBACK_STATE).toBe(0x2545f491);
  });

  test('与 BigInt 参考实现前 1000 个一致（多个初始状态，含高位为 1 的负 int32）', () => {
    for (const init of [0x2545f491, 1, 12345, 0x80000000, 0xffffffff, 0xdeadbeef, 0x7fffffff]) {
      const s = new Int32Array(1);
      s[0] = init | 0;
      let ref = BigInt(init >>> 0);
      for (let i = 0; i < 1000; i++) {
        ref = refXorshift(ref);
        const u = rngNextU32(s, 0);
        expect(u).toBe(Number(ref));
        // 返回 u32，状态存为同一位模式的 int32
        expect(u).toBeGreaterThanOrEqual(0);
        expect(s[0]).toBe(u | 0);
        expect(u).not.toBe(0);
      }
    }
  });

  test('槽函数只推进下标 i 的那一路', () => {
    const s = new Int32Array([11, 22, 33, 44]);
    rngNextU32(s, 2);
    expect(s[0]).toBe(11);
    expect(s[1]).toBe(22);
    expect(s[2]).not.toBe(33);
    expect(s[3]).toBe(44);
  });

  test('逆变换自检：refXorshiftInverse 是 refXorshift 的逆', () => {
    for (const y of [1n, 0xffffffffn, 0x12345678n, 0x80000000n]) expect(refXorshift(refXorshiftInverse(y))).toBe(y);
  });

  test('rngNextUnit ∈ [0,1)，= u32 / 2^32 精确', () => {
    const s = new Int32Array([0x2545f491]);
    const t = new Int32Array([0x2545f491]);
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < 100000; i++) {
      const v = rngNextUnit(s, 0);
      expect(v).toBe(rngNextU32(t, 0) / 4294967296);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThan(1);
  });

  test('边界：下一个输出为 0xffffffff 时 rngNextUnit = (2^32−1)/2^32 < 1', () => {
    const s = new Int32Array(1);
    s[0] = Number(refXorshiftInverse(0xffffffffn)) | 0;
    const v = rngNextUnit(s, 0);
    expect(v).toBe(4294967295 / 4294967296);
    expect(v).toBeLessThan(1);
  });

  test('rngNextRange ∈ [lo, hi)，= lo + u·(hi − lo)', () => {
    const s = new Int32Array([0x2545f491]);
    const t = new Int32Array([0x2545f491]);
    for (let i = 0; i < 20000; i++) {
      const v = rngNextRange(s, 0, 20, 80);
      expect(v).toBe(20 + rngNextUnit(t, 0) * 60);
      expect(v).toBeGreaterThanOrEqual(20);
      expect(v).toBeLessThan(80);
    }
    const e = new Int32Array(1);
    e[0] = Number(refXorshiftInverse(0xffffffffn)) | 0;
    expect(rngNextRange(e, 0, -0.4, 0.8)).toBeLessThan(0.8);
  });
});

describe('mixSeed32 与 deriveRngStreams', () => {
  test('mixSeed32 与 BigInt 参考 lowbias32 一致，返回 int32', () => {
    const r = new Rng(99);
    const xs = [0, 1, -1, 0x7fffffff, -0x80000000, 0x9e3779b9 | 0];
    for (let i = 0; i < 2000; i++) xs.push(r.nextU32() | 0);
    for (const x of xs) {
      const m = mixSeed32(x);
      expect(m).toBe(m | 0);
      expect(m >>> 0).toBe(Number(refMix(BigInt(x >>> 0))));
    }
    expect(mixSeed32(0)).toBe(0);
  });

  test('3 路互不相同、非零、确定，并与参考派生一致', () => {
    const r = new Rng(5);
    const seeds = [0, 1, -1, 0x2545f491, 0x7fffffff, -0x80000000];
    for (let i = 0; i < 500; i++) seeds.push(r.nextU32() | 0);
    for (const seed of seeds) {
      const a = new Int32Array(RNG_STREAMS);
      const b = new Int32Array(RNG_STREAMS);
      deriveRngStreams(seed, a, 0);
      deriveRngStreams(seed, b, 0);
      expect(Array.from(a)).toEqual(Array.from(b));
      expect(a[RNG_AI_A]).not.toBe(0);
      expect(a[RNG_AI_B]).not.toBe(0);
      expect(a[RNG_SCATTER]).not.toBe(0);
      expect(a[RNG_AI_A]).not.toBe(a[RNG_AI_B]);
      expect(a[RNG_AI_A]).not.toBe(a[RNG_SCATTER]);
      expect(a[RNG_AI_B]).not.toBe(a[RNG_SCATTER]);
      expect(Array.from(a, (x) => x >>> 0)).toEqual(refDerive(seed));
    }
  });

  test('不同种子得到不同的流', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 1000; seed++) {
      const a = new Int32Array(RNG_STREAMS);
      deriveRngStreams(seed, a, 0);
      seen.add(Array.from(a).join(','));
    }
    expect(seen.size).toBe(1000);
  });

  test('偏移 off 生效，只写 3 个槽', () => {
    const out = new Int32Array(9).fill(-7);
    deriveRngStreams(42, out, 4);
    const ref = new Int32Array(RNG_STREAMS);
    deriveRngStreams(42, ref, 0);
    expect(Array.from(out)).toEqual([-7, -7, -7, -7, ref[0]!, ref[1]!, ref[2]!, -7, -7]);
  });

  test('派生值为 0 时落到 RNG_FALLBACK_STATE（seed = −0x9e3779b9·(i+1) 使第 i 路 mixSeed32(0) = 0）', () => {
    // 第 0 路：seed + φ = 0
    const seed0 = -0x9e3779b9 | 0;
    expect((seed0 + Math.imul(0x9e3779b9, 1)) | 0).toBe(0);
    const out = new Int32Array(RNG_STREAMS);
    deriveRngStreams(seed0, out, 0);
    expect(out[RNG_AI_A]).toBe(RNG_FALLBACK_STATE);
    expect(out[RNG_AI_B]).not.toBe(0);
    expect(out[RNG_SCATTER]).not.toBe(0);
    // 第 1、2 路同理
    for (let i = 1; i < RNG_STREAMS; i++) {
      const seed = -Math.imul(0x9e3779b9, i + 1) | 0;
      const o = new Int32Array(RNG_STREAMS);
      deriveRngStreams(seed, o, 0);
      expect(o[i]).toBe(RNG_FALLBACK_STATE);
      for (let j = 0; j < RNG_STREAMS; j++) expect(o[j]).not.toBe(0);
    }
    // 回退后 3 路仍互不相同（回退常数没有恰好撞上另外两路之一）
    for (let i = 0; i < RNG_STREAMS; i++) {
      const o = new Int32Array(RNG_STREAMS);
      deriveRngStreams(-Math.imul(0x9e3779b9, i + 1) | 0, o, 0);
      expect(new Set(o).size).toBe(RNG_STREAMS);
    }
  });
});

describe('Rng 类', () => {
  test('与槽函数一致', () => {
    const r = new Rng(0x2545f491);
    const s = new Int32Array([0x2545f491]);
    for (let i = 0; i < 1000; i++) {
      if (i % 2 === 0) expect(r.nextU32()).toBe(rngNextU32(s, 0));
      else expect(r.next()).toBe(rngNextUnit(s, 0));
      expect(r.state[0]).toBe(s[0]!);
    }
  });

  test('seed 为 0（或 |0 后为 0）时用回退状态', () => {
    for (const seed of [0, -0, 4294967296]) {
      const r = new Rng(seed);
      expect(r.state[0]).toBe(RNG_FALLBACK_STATE);
      expect(r.nextU32()).not.toBe(0);
    }
    const a = new Rng(0);
    const b = new Rng(RNG_FALLBACK_STATE);
    for (let i = 0; i < 100; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  test('seed 按 |0 截成 int32', () => {
    const a = new Rng(0x1_0000_0005);
    const b = new Rng(5);
    for (let i = 0; i < 100; i++) expect(a.nextU32()).toBe(b.nextU32());
    const c = new Rng(0xffffffff);
    expect(c.state[0]).toBe(-1);
  });
});
