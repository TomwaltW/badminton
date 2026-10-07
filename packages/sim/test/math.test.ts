/**
 * dsqrt 单测：完全平方数精确、与 Math.sqrt 相差 ≤1 ulp、非正数与 NaN 返回 0、
 * Infinity 不挂死、次正规数输入能结束（方案 §3.3、计划 1.1）。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { dsqrt } from '../src/math';
import { Rng } from '../src/rng';

const dv = new DataView(new ArrayBuffer(8));

/** 双精度数的位模式（有符号 64 位整数）。正数的位模式随数值单调递增，差即 ulp 距离。 */
function bitsOf(x: number): bigint {
  dv.setFloat64(0, x);
  return dv.getBigInt64(0);
}

/** 两个正有限数之间相差几个 ulp。 */
function ulpDiff(a: number, b: number): number {
  const d = bitsOf(a) - bitsOf(b);
  return Number(d < 0n ? -d : d);
}

/** 由高、低两个 32 位字拼出双精度数。 */
function fromWords(hi: number, lo: number): number {
  dv.setUint32(0, hi >>> 0);
  dv.setUint32(4, lo >>> 0);
  return dv.getFloat64(0);
}

/**
 * 2 的整数次幂，逐次乘/除以 2 得到（每一步都精确，包括进入次正规数区间）。
 * 不用 Math.pow：负指数时 JSC 走系统 libm，Mac 与 Linux 不保证逐位相同。
 */
function pow2(e: number): number {
  let x = 1;
  for (let i = 0; i < e; i++) x *= 2;
  for (let i = 0; i > e; i--) x *= 0.5;
  return x;
}

describe('dsqrt：完全平方数', () => {
  test('常见完全平方数逐位精确', () => {
    expect(dsqrt(4)).toBe(2);
    expect(dsqrt(9)).toBe(3);
    expect(dsqrt(0.25)).toBe(0.5);
    expect(dsqrt(1)).toBe(1);
    expect(dsqrt(16)).toBe(4);
    expect(dsqrt(0.0625)).toBe(0.25);
    expect(dsqrt(2.25)).toBe(1.5);
    expect(dsqrt(144)).toBe(12);
  });

  test('2^-1074 量级（次正规数）的完全平方数精确', () => {
    // Number.MIN_VALUE = 2^-1074 = (2^-537)²
    expect(Number.MIN_VALUE).toBe(pow2(-1074));
    expect(dsqrt(Number.MIN_VALUE)).toBe(pow2(-537));
    // 9·2^-1074 = (3·2^-537)²，仍是次正规数
    expect(dsqrt(9 * pow2(-1074))).toBe(3 * pow2(-537));
    expect(dsqrt(pow2(-1060))).toBe(pow2(-530));
  });

  test('1e300 量级的完全平方数精确', () => {
    const y = 1.5 * pow2(498); // ≈ 1.23e150，y² ≈ 1.5e300，y 只有 2 位有效位，y² 精确可表示
    expect(y * y).toBeGreaterThan(1e300);
    expect(dsqrt(y * y)).toBe(y);
    expect(dsqrt(pow2(996))).toBe(pow2(498));
    expect(dsqrt(1e150 * 1e150)).toBe(Math.sqrt(1e150 * 1e150));
  });

  test('1 .. 2^16 的整数平方逐位精确', () => {
    let bad = 0;
    for (let i = 1; i <= 65536; i++) if (dsqrt(i * i) !== i) bad++;
    expect(bad).toBe(0);
  });
});

describe('dsqrt：与 Math.sqrt 相差 ≤1 ulp', () => {
  test('20 万个随机正规/次正规数（全指数范围，按位模式均匀取样）', () => {
    const r = new Rng(0x1234567);
    let n = 0;
    let maxUlp = 0;
    let oneUlp = 0;
    let oddExp = 0;
    while (n < 200000) {
      // 只清符号位，再丢掉指数 = 0x7ff（Infinity 与 NaN）：覆盖全部正有限数（含次正规数）。
      // 注意不能用掩码 0x7fefffff：它会清掉指数最低位，只剩偶数指数，dsqrt 缩放后只落在 [2,4)。
      const hi = r.nextU32() & 0x7fffffff;
      const lo = r.nextU32();
      if (hi >>> 20 === 0x7ff) continue;
      const x = fromWords(hi, lo);
      if (!(x > 0)) continue;
      n++;
      if ((hi >>> 20) & 1) oddExp++;
      const u = ulpDiff(dsqrt(x), Math.sqrt(x));
      if (u > maxUlp) maxUlp = u;
      if (u === 1) oneUlp++;
    }
    // 取样自检：奇、偶指数各约一半（缩放后 [1,2) 与 [2,4) 两段都覆盖到）
    expect(oddExp / n).toBeGreaterThan(0.45);
    expect(oddExp / n).toBeLessThan(0.55);
    expect(maxUlp).toBeLessThanOrEqual(1);
    // 原脚本的结论：约 25% 输入差 1 ulp（两条路径只能二选一）；实测 25.1%
    expect(oneUlp / n).toBeGreaterThan(0.2);
    expect(oneUlp / n).toBeLessThan(0.3);
  });

  test('2 万个随机次正规数：与 Math.sqrt 相差 ≤1 ulp', () => {
    const r = new Rng(0x5ab);
    let n = 0;
    let maxUlp = 0;
    while (n < 20000) {
      // 指数位全 0：次正规数（尾数为 0 时是 +0，跳过）
      const x = fromWords(r.nextU32() & 0x000fffff, r.nextU32());
      if (!(x > 0)) continue;
      n++;
      const u = ulpDiff(dsqrt(x), Math.sqrt(x));
      if (u > maxUlp) maxUlp = u;
    }
    expect(maxUlp).toBeLessThanOrEqual(1);
  });

  test('20 万个 [0, 1e4) 的随机数（同 det-smoke.js 的取样）', () => {
    const r = new Rng(12345);
    let maxUlp = 0;
    for (let i = 0; i < 200000; i++) {
      const x = r.next() * 1e4;
      if (!(x > 0)) continue;
      const u = ulpDiff(dsqrt(x), Math.sqrt(x));
      if (u > maxUlp) maxUlp = u;
    }
    expect(maxUlp).toBeLessThanOrEqual(1);
  });

  test('边界：Number.MAX_VALUE 与最小正规数', () => {
    expect(ulpDiff(dsqrt(Number.MAX_VALUE), Math.sqrt(Number.MAX_VALUE))).toBeLessThanOrEqual(1);
    const minNormal = pow2(-1022);
    expect(dsqrt(minNormal)).toBe(pow2(-511));
  });
});

describe('dsqrt：特殊输入', () => {
  test('非正数与 NaN 返回 +0', () => {
    for (const x of [0, -0, -1, -1e-300, -Number.MIN_VALUE, -Number.MAX_VALUE, -Infinity, NaN]) {
      expect(Object.is(dsqrt(x), 0)).toBe(true);
    }
  });

  /** 子进程（10 s 超时）里确认 dsqrt(Infinity) 会结束且返回 Infinity；通过后才允许进程内调用。 */
  let infinitySafe = false;
  function checkInfinityInSubprocess(): void {
    const mathPath = join(import.meta.dir, '..', 'src', 'math.ts');
    const code = `import { dsqrt } from ${JSON.stringify(mathPath)}; console.log(String(dsqrt(Infinity)));`;
    const r = Bun.spawnSync([process.execPath, '-e', code], { timeout: 10000, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe('Infinity');
    infinitySafe = true;
  }

  test('Infinity 返回 Infinity 且不挂死（子进程 + 超时保护）', checkInfinityInSubprocess, 20000);

  test(
    'Infinity 进程内调用（先确认子进程里会结束：同步死循环会把整个测试进程挂死，测试超时也打断不了）',
    () => {
      if (!infinitySafe) checkInfinityInSubprocess();
      expect(dsqrt(Infinity)).toBe(Infinity);
    },
    20000,
  );

  test('次正规数输入能结束且结果为正规数', () => {
    const xs = [Number.MIN_VALUE, 2 * Number.MIN_VALUE, 3 * Number.MIN_VALUE, fromWords(0x000fffff, 0xffffffff), pow2(-1050)];
    for (const x of xs) {
      expect(x).toBeLessThan(pow2(-1022));
      const y = dsqrt(x);
      expect(y).toBeGreaterThan(0);
      expect(ulpDiff(y, Math.sqrt(x))).toBeLessThanOrEqual(1);
    }
  });
});
