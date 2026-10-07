/**
 * 随机数：xorshift32（13/17/5），纯整数运算。
 *
 * 一场对局由一个种子派生 3 路独立流：AI-A、AI-B、散布（计划 2.5"随机数"）。
 * 状态放在调用方提供的 Int32Array 槽里（快照 I32 头里正好是这 3 个槽），
 * 热路径函数只读写该槽，不分配。
 */

/** 3 路流在状态数组里的相对下标。 */
export const RNG_AI_A = 0;
export const RNG_AI_B = 1;
export const RNG_SCATTER = 2;
export const RNG_STREAMS = 3;

/** xorshift32 的状态不能为 0（0 是不动点）；派生结果为 0 时改用这个常数（取自方案 §3.3 的默认种子）。 */
export const RNG_FALLBACK_STATE = 0x2545f491;

const TWO_POW_32 = 4294967296;
const GOLDEN_32 = 0x9e3779b9;

/** 32 位整数混洗（lowbias32），只用异或、移位与 Math.imul。返回 int32。 */
export function mixSeed32(x: number): number {
  x |= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x | 0;
}

/**
 * 由对局种子派生 3 路流的初始状态，写进 out[off .. off+2]（顺序为 AI-A、AI-B、散布）。
 * 第 i 路 = mixSeed32(seed + φ·(i+1))，加法按 32 位回绕。
 */
export function deriveRngStreams(seed: number, out: Int32Array, off: number): void {
  for (let i = 0; i < RNG_STREAMS; i++) {
    let s = mixSeed32((seed + Math.imul(GOLDEN_32, i + 1)) | 0);
    if (s === 0) s = RNG_FALLBACK_STATE;
    out[off + i] = s;
  }
}

/** 推进 s[i] 一步并返回新的 u32（0 .. 2^32−1）。 */
export function rngNextU32(s: Int32Array, i: number): number {
  let x = s[i];
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  s[i] = x;
  return x >>> 0;
}

/** 推进一步并返回 [0,1) 的双精度数：u32 / 2^32（精确，无舍入）。 */
export function rngNextUnit(s: Int32Array, i: number): number {
  return rngNextU32(s, i) / TWO_POW_32;
}

/** 推进一步并返回 [lo, hi) 内的数：lo + u·(hi − lo)。 */
export function rngNextRange(s: Int32Array, i: number, lo: number, hi: number): number {
  return lo + rngNextUnit(s, i) * (hi - lo);
}

/** 便于测试与工具使用的单流包装；模拟热路径直接用上面的槽函数。 */
export class Rng {
  readonly state: Int32Array;

  constructor(seed: number) {
    this.state = new Int32Array(1);
    this.state[0] = seed | 0 || RNG_FALLBACK_STATE;
  }

  nextU32(): number {
    return rngNextU32(this.state, 0);
  }

  next(): number {
    return rngNextUnit(this.state, 0);
  }
}
