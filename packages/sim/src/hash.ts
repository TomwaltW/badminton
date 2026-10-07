/**
 * 校验和：FNV-1a。
 *
 * - 状态哈希按 32 位字做 FNV-1a（与 docs/spike/det-smoke.js 的 mix 相同）：
 *   每个 i32 混入 1 个字；每个 f64 依次混入低 32 位、高 32 位（小端；iOS、Android、x64 均满足）。
 * - NaN 一律按规范 NaN（0x7ff80000_00000000）的位混入，避免不同引擎 NaN 载荷不同造成假分歧；
 *   −0 按原位混入（IEEE 符号规则本身是确定的）。快照写入前的 −0 归一由快照层负责。
 * - 文件字节（sim.version、contentHash）用标准的逐字节 FNV-1a：fnvBytes。
 *
 * 函数返回 int32 形式的中间值，便于连续混入；对外报告时用 `>>> 0` 转成 u32。
 */

/** FNV-1a 32 位偏移基数（int32 形式）。 */
export const FNV_OFFSET = 0x811c9dc5 | 0;
/** FNV-1a 32 位素数。 */
export const FNV_PRIME = 0x01000193;

const NAN_HI = 0x7ff80000;

const scratchF64 = new Float64Array(1);
const scratchU32 = new Uint32Array(scratchF64.buffer);

/** 混入一个 32 位字。 */
export function fnvMixI32(h: number, x: number): number {
  return Math.imul(h ^ x, FNV_PRIME);
}

/** 混入一个双精度数的 64 位（先低后高）。 */
export function fnvMixF64(h: number, x: number): number {
  let lo: number;
  let hi: number;
  if (x !== x) {
    lo = 0;
    hi = NAN_HI;
  } else {
    scratchF64[0] = x;
    lo = scratchU32[0];
    hi = scratchU32[1];
  }
  h = Math.imul(h ^ lo, FNV_PRIME);
  return Math.imul(h ^ hi, FNV_PRIME);
}

/** 依次混入 a[from .. to) 的每个 32 位整数。 */
export function fnvHashI32(h: number, a: Int32Array, from: number, to: number): number {
  for (let i = from; i < to; i++) h = Math.imul(h ^ a[i], FNV_PRIME);
  return h;
}

/** 依次混入 a[from .. to) 的每个双精度数。 */
export function fnvHashF64(h: number, a: Float64Array, from: number, to: number): number {
  for (let i = from; i < to; i++) h = fnvMixF64(h, a[i]);
  return h;
}

/** 完整状态哈希：先 i32 全部，再 f64 全部；从 h 继续混入（新状态传 FNV_OFFSET）。 */
export function fnvHashState(h: number, i32: Int32Array, f64: Float64Array): number {
  h = fnvHashI32(h, i32, 0, i32.length);
  return fnvHashF64(h, f64, 0, f64.length);
}

/** 标准逐字节 FNV-1a（u32 结果），用于文件字节、规范化 JSON 等。 */
export function fnvBytes(bytes: Uint8Array, h: number = FNV_OFFSET): number {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], FNV_PRIME);
  return h >>> 0;
}

/** int32 中间值 → u32。 */
export function toU32(h: number): number {
  return h >>> 0;
}

/** u32 → 8 位小写十六进制（补零）。 */
export function hex8(u: number): string {
  const s = (u >>> 0).toString(16);
  return '00000000'.slice(s.length) + s;
}
