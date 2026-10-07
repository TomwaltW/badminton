/**
 * 移植一致性：只用 packages/sim/src 的函数（stepRk4、rngNextUnit / Rng、fnvMixF64、dsqrt、K_STD、G_STD）
 * 逐步复现 docs/spike/det-smoke.js 的 run(sq)，得到与 2026-10-07 Mac 实测表（det-smoke-结果.md）
 * 逐位相同的哈希与步数。这证明移植后的 RK4、随机数、哈希与原脚本逐位一致。
 *
 * 复现要点（与原脚本逐项对应）：
 * - 随机数 rs = 0x2545f491，每拍依次取 sp、el、az、alpha；
 * - L = sq(1 + el² + az²)，初速度 (sp·α/L, sp·α·el/L, sp·α·az/L)——乘除顺序与原脚本相同，
 *   所以直接写状态数组，不用 flightLaunch（后者是 (sp/L)·α，末位可能不同）；
 * - g = G·α·α，k = K_STD（= G/(VT·VT)），步长 1/60；
 * - 循环条件 p[1] > 0 且全局步数 < 5e6；全局每 30 步混入 p、v 六个量；每拍结束混入 p[0]、p[2]；
 * - 输出 (h >>> 0).toString(16)（不补零）。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { dsqrt, type SqrtFn } from '../src/math';
import { Rng, rngNextUnit } from '../src/rng';
import { FNV_OFFSET, fnvMixF64 } from '../src/hash';
import { FL_G, FL_K, FL_PX, FL_PY, FL_PZ, FL_STRIDE, FL_VX, FL_VY, FL_VZ, G_STD, K_STD, VT_STD, stepRk4 } from '../src/flight';

/** Mac 实测表（docs/spike/det-smoke-结果.md）：各引擎一致的值。 */
const SPIKE_DSQRT_HASH = '3e34ca';
const SPIKE_MATHSQRT_HASH = 'e0082e4a';
const SPIKE_STEPS = 194704;
const SPIKE_MISMATCHES = 49938;

/** det-smoke.js 的 run(sq) 的逐步复现。返回 [哈希（不补零的十六进制）, 步数]。 */
function runSpikePort(sq: SqrtFn): [string, number] {
  const rs = new Int32Array(1);
  rs[0] = 0x2545f491;
  const s = new Float64Array(FL_STRIDE);
  let h = FNV_OFFSET;
  let steps = 0;
  for (let n = 0; n < 2000; n++) {
    const sp = 20 + rngNextUnit(rs, 0) * 60;
    const el = -0.4 + rngNextUnit(rs, 0) * 1.2;
    const az = -0.3 + rngNextUnit(rs, 0) * 0.6;
    const alpha = 0.4 + rngNextUnit(rs, 0) * 1.1;
    const L = sq(1 + el * el + az * az);
    s[FL_PX] = 1;
    s[FL_PY] = 2.8;
    s[FL_PZ] = 0;
    s[FL_VX] = (sp * alpha) / L;
    s[FL_VY] = (sp * alpha * el) / L;
    s[FL_VZ] = (sp * alpha * az) / L;
    s[FL_G] = G_STD * alpha * alpha;
    s[FL_K] = K_STD;
    while (s[FL_PY] > 0 && steps < 5e6) {
      stepRk4(s, 0, 1 / 60, sq);
      steps++;
      if (steps % 30 === 0) {
        h = fnvMixF64(h, s[FL_PX]);
        h = fnvMixF64(h, s[FL_PY]);
        h = fnvMixF64(h, s[FL_PZ]);
        h = fnvMixF64(h, s[FL_VX]);
        h = fnvMixF64(h, s[FL_VY]);
        h = fnvMixF64(h, s[FL_VZ]);
      }
    }
    h = fnvMixF64(h, s[FL_PX]);
    h = fnvMixF64(h, s[FL_PZ]);
  }
  return [(h >>> 0).toString(16), steps];
}

describe('det-smoke.js 移植逐位复现', () => {
  test('常数与原脚本相同：G = 9.81，VT = 6.5，K = G/(VT·VT)', () => {
    expect(G_STD).toBe(9.81);
    expect(VT_STD).toBe(6.5);
    expect(K_STD).toBe(9.81 / (6.5 * 6.5));
  });

  test(`dsqrt 路径：${SPIKE_DSQRT_HASH}，${SPIKE_STEPS} 步`, () => {
    const [hash, steps] = runSpikePort(dsqrt);
    expect(steps).toBe(SPIKE_STEPS);
    expect(hash).toBe(SPIKE_DSQRT_HASH);
  });

  test(`Math.sqrt 路径：${SPIKE_MATHSQRT_HASH}，${SPIKE_STEPS} 步`, () => {
    const [hash, steps] = runSpikePort(Math.sqrt);
    expect(steps).toBe(SPIKE_STEPS);
    expect(hash).toBe(SPIKE_MATHSQRT_HASH);
  });

  test(`rs = 12345 时 sqrt-vs-dsqrt mismatches = ${SPIKE_MISMATCHES}/200000（Rng 类）`, () => {
    const r = new Rng(12345);
    let diff = 0;
    for (let i = 0; i < 200000; i++) {
      const x = r.next() * 1e4;
      if (Math.sqrt(x) !== dsqrt(x)) diff++;
    }
    expect(diff).toBe(SPIKE_MISMATCHES);
  });

  test('原脚本本身在当前 bun 下也输出同样的值（核对上面的期望值来自实测表而非移植）', () => {
    const script = join(import.meta.dir, '..', '..', '..', 'docs', 'spike', 'det-smoke.js');
    const r = Bun.spawnSync([process.execPath, script], { timeout: 60000, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.toString().trim().split('\n');
    expect(lines).toContain(`dsqrt ${SPIKE_DSQRT_HASH} ${SPIKE_STEPS}`);
    expect(lines).toContain(`Math.sqrt ${SPIKE_MATHSQRT_HASH} ${SPIKE_STEPS}`);
    expect(lines).toContain(`sqrt-vs-dsqrt mismatches ${SPIKE_MISMATCHES}/200000`);
  });
});
