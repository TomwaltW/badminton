/**
 * 哈希单测：fnvBytes 的 FNV-1a 标准向量；fnvMixF64 的 NaN 规范化、±0 区分、低/高字顺序与
 * docs/spike/det-smoke.js 的 mix 相同；fnvHashState = 先 i32 后 f64；hex8 补零。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FNV_OFFSET,
  FNV_PRIME,
  fnvBytes,
  fnvHashF64,
  fnvHashI32,
  fnvHashState,
  fnvMixF64,
  fnvMixI32,
  hex8,
  toU32,
} from '../src/hash';
import { Rng } from '../src/rng';
import { fnv1aBytes } from '../../../tools/sim/fnv';

const enc = new TextEncoder();
const dv = new DataView(new ArrayBuffer(8));

function f64FromWords(hi: number, lo: number): number {
  dv.setUint32(0, hi >>> 0);
  dv.setUint32(4, lo >>> 0);
  return dv.getFloat64(0);
}

/** docs/spike/det-smoke.js 的 mix，原样搬过来（只把全局 h 改成参数与返回值）。 */
const spikeF64 = new Float64Array(1);
const spikeU32 = new Uint32Array(spikeF64.buffer);
function spikeMix(h: number, x: number): number {
  spikeF64[0] = x;
  h ^= spikeU32[0]!;
  h = Math.imul(h, 0x01000193);
  h ^= spikeU32[1]!;
  h = Math.imul(h, 0x01000193);
  return h;
}

describe('常数', () => {
  test('FNV-1a 32 位偏移基数与素数', () => {
    expect(FNV_OFFSET).toBe(0x811c9dc5 | 0);
    expect(toU32(FNV_OFFSET)).toBe(0x811c9dc5);
    expect(FNV_PRIME).toBe(16777619);
  });
});

describe('fnvBytes：逐字节 FNV-1a', () => {
  test('标准向量', () => {
    expect(fnvBytes(enc.encode(''))).toBe(0x811c9dc5);
    expect(fnvBytes(enc.encode('a'))).toBe(0xe40c292c);
    expect(fnvBytes(enc.encode('foobar'))).toBe(0xbf9cf968);
  });

  test('返回 u32；从中间值继续混入等于拼接后一次混入', () => {
    const a = enc.encode('foo');
    const b = enc.encode('bar');
    const h = fnvBytes(a);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(fnvBytes(b, h)).toBe(0xbf9cf968);
  });

  test('与工具侧 tools/sim/fnv.ts 的 fnv1aBytes 一致（sim.version 用后者）', () => {
    const r = new Rng(3);
    for (let n = 0; n < 200; n++) {
      const bytes = new Uint8Array(n * 7);
      for (let i = 0; i < bytes.length; i++) bytes[i] = r.nextU32() & 0xff;
      expect(fnvBytes(bytes)).toBe(fnv1aBytes(bytes));
    }
  });
});

describe('fnvMixI32 / fnvMixF64', () => {
  test('fnvMixI32 = imul(h ^ x, PRIME)，返回 int32', () => {
    const h = fnvMixI32(FNV_OFFSET, 0x12345678);
    expect(h).toBe(Math.imul(FNV_OFFSET ^ 0x12345678, 16777619));
    expect(h).toBe(h | 0);
  });

  test('fnvMixF64 先混低 32 位、再混高 32 位（小端），与 det-smoke.js 的 mix 逐个相同', () => {
    const r = new Rng(0x5eed);
    const xs = [0, 1, -1, 2.8, 1 / 60, 9.81, Number.MAX_VALUE, Number.MIN_VALUE, Infinity, -Infinity, -0];
    for (let i = 0; i < 5000; i++) xs.push(f64FromWords(r.nextU32(), r.nextU32()));
    let h = FNV_OFFSET;
    let hs = 0x811c9dc5; // 原脚本的初值（正数形式）
    for (const x of xs) {
      if (x !== x) continue; // NaN 的处理有意不同，见下一条
      h = fnvMixF64(h, x);
      hs = spikeMix(hs, x);
      expect(h).toBe(hs);
    }
    // 显式的字顺序：1.0 的位 = 0x3ff00000_00000000，低字 0、高字 0x3ff00000
    expect(fnvMixF64(FNV_OFFSET, 1)).toBe(fnvMixI32(fnvMixI32(FNV_OFFSET, 0), 0x3ff00000));
    expect(fnvMixF64(FNV_OFFSET, 1)).not.toBe(fnvMixI32(fnvMixI32(FNV_OFFSET, 0x3ff00000), 0));
  });

  // 注意：bun（JSC）把从 DataView / 类型数组读出的 NaN 一律净化成 0x7ff80000_00000000，
  // 所以本进程里这条只验证"NaN 按规范位混入"，碰不到 fnvMixF64 的载荷分支；
  // 载荷分支由下面的 V8 子进程用例覆盖（V8 保留 NaN 载荷，微信 Android 端即 V8）。
  test('不同 NaN 载荷给同一结果（按规范 NaN 0x7ff80000_00000000 混入）', () => {
    const nans = [
      NaN,
      f64FromWords(0x7ff80000, 0), // 规范安静 NaN
      f64FromWords(0xfff80000, 0), // 负号安静 NaN
      f64FromWords(0x7ff00000, 1), // 信号 NaN
      f64FromWords(0x7fffffff, 0xffffffff),
      f64FromWords(0xfff00000, 0x00000001),
      0 / 0,
      Infinity - Infinity,
    ];
    const canon = fnvMixI32(fnvMixI32(FNV_OFFSET, 0), 0x7ff80000);
    for (const x of nans) {
      expect(Number.isNaN(x)).toBe(true);
      expect(fnvMixF64(FNV_OFFSET, x)).toBe(canon);
    }
    // NaN 与 Infinity（0x7ff00000_00000000）不同
    expect(fnvMixF64(FNV_OFFSET, Infinity)).not.toBe(canon);
  });

  test.skipIf(!Bun.which('node'))(
    'V8（node 子进程）：NaN 载荷确实保留到 fnvMixF64，且结果都等于规范 NaN（PATH 里找不到 node 时跳过）',
    () => {
      // 把 src/hash.ts 转成 JS 交给 node 执行；不依赖打包产物（hash.ts 没有值导入，单文件转译即可）
      const src = readFileSync(join(import.meta.dir, '..', 'src', 'hash.ts'), 'utf8');
      const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(src);
      const probe = `
const dv = new DataView(new ArrayBuffer(8));
const w = (hi, lo) => { dv.setUint32(0, hi >>> 0); dv.setUint32(4, lo >>> 0); return dv.getFloat64(0); };
const f = new Float64Array(1), u = new Uint32Array(f.buffer);
const xs = [w(0x7ff80000, 0), w(0xfff80000, 0), w(0x7ff00000, 1), w(0x7fffffff, 0xffffffff), w(0xfff00000, 1), 0 / 0, Infinity - Infinity];
const bits = xs.map((x) => { f[0] = x; return u[1] + ':' + u[0]; });
console.log(JSON.stringify({ bits, h: xs.map((x) => fnvMixF64(FNV_OFFSET, x)) }));
`;
      const r = Bun.spawnSync([Bun.which('node')!, '--input-type=module', '-e', js + probe], {
        timeout: 20000,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (r.exitCode !== 0) throw new Error(`node 退出码 ${r.exitCode}：${r.stderr.toString()}`);
      const got = JSON.parse(r.stdout.toString()) as { bits: string[]; h: number[] };
      // 前提：V8 里这些 NaN 的位模式确实不同（否则本用例与上一条一样碰不到载荷分支）
      expect(new Set(got.bits).size).toBeGreaterThanOrEqual(3);
      const canon = fnvMixI32(fnvMixI32(FNV_OFFSET, 0), 0x7ff80000);
      expect(got.h).toEqual(got.h.map(() => canon));
    },
    30000,
  );

  test('+0 与 −0 结果不同', () => {
    expect(fnvMixF64(FNV_OFFSET, 0)).not.toBe(fnvMixF64(FNV_OFFSET, -0));
    expect(fnvMixF64(FNV_OFFSET, -0)).toBe(fnvMixI32(fnvMixI32(FNV_OFFSET, 0), 0x80000000 | 0));
  });
});

describe('fnvHashI32 / fnvHashF64 / fnvHashState', () => {
  const i32 = Int32Array.from([5, -1, 0x7fffffff, -0x80000000, 0]);
  const f64 = Float64Array.from([1.5, -0, NaN, 2.8, 1e-300, -7]);

  test('区间 [from, to) 逐个混入；空区间返回原值', () => {
    let h = FNV_OFFSET;
    for (let i = 1; i < 4; i++) h = fnvMixI32(h, i32[i]!);
    expect(fnvHashI32(FNV_OFFSET, i32, 1, 4)).toBe(h);
    let g = FNV_OFFSET;
    for (let i = 2; i < 5; i++) g = fnvMixF64(g, f64[i]!);
    expect(fnvHashF64(FNV_OFFSET, f64, 2, 5)).toBe(g);
    expect(fnvHashI32(123, i32, 3, 3)).toBe(123);
    expect(fnvHashF64(123, f64, 0, 0)).toBe(123);
  });

  test('fnvHashState = 先全部 i32、后全部 f64', () => {
    let h = FNV_OFFSET;
    for (let i = 0; i < i32.length; i++) h = fnvMixI32(h, i32[i]!);
    for (let i = 0; i < f64.length; i++) h = fnvMixF64(h, f64[i]!);
    expect(fnvHashState(FNV_OFFSET, i32, f64)).toBe(h);

    let wrongOrder = FNV_OFFSET;
    for (let i = 0; i < f64.length; i++) wrongOrder = fnvMixF64(wrongOrder, f64[i]!);
    for (let i = 0; i < i32.length; i++) wrongOrder = fnvMixI32(wrongOrder, i32[i]!);
    expect(fnvHashState(FNV_OFFSET, i32, f64)).not.toBe(wrongOrder);
  });

  test('fnvHashState 从 h 继续混入', () => {
    const a = fnvHashState(FNV_OFFSET, i32, f64);
    const b = fnvHashState(a, i32, f64);
    expect(b).toBe(fnvHashF64(fnvHashI32(a, i32, 0, i32.length), f64, 0, f64.length));
    expect(b).not.toBe(a);
  });

  test('任一位变化都改变哈希', () => {
    const base = fnvHashState(FNV_OFFSET, i32, f64);
    const f2 = Float64Array.from(f64);
    f2[3] = 2.8000000000000003; // 2.8 的下一个双精度数
    expect(fnvHashState(FNV_OFFSET, i32, f2)).not.toBe(base);
    const i2 = Int32Array.from(i32);
    i2[4] = 1;
    expect(fnvHashState(FNV_OFFSET, i2, f64)).not.toBe(base);
  });
});

describe('toU32 / hex8', () => {
  test('toU32', () => {
    expect(toU32(-1)).toBe(4294967295);
    expect(toU32(0)).toBe(0);
    expect(toU32(0x7fffffff)).toBe(0x7fffffff);
    expect(toU32(-0x80000000)).toBe(0x80000000);
  });

  test('hex8 补零到 8 位、小写，接受 int32 或 u32', () => {
    expect(hex8(0)).toBe('00000000');
    expect(hex8(0x3e34ca)).toBe('003e34ca');
    expect(hex8(0xabc)).toBe('00000abc');
    expect(hex8(0xe0082e4a)).toBe('e0082e4a');
    expect(hex8(-1)).toBe('ffffffff');
    expect(hex8(FNV_OFFSET)).toBe('811c9dc5');
    expect(hex8(0x811c9dc5)).toBe('811c9dc5');
  });
});
