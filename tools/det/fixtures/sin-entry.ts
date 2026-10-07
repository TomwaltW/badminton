/**
 * det 自测夹具：一个"用了 Math.sin 的模拟"，`bun run det --kernel --fixture sin` 必须判红。
 *
 * API 与真实 sim 完全相同，只把 kernel.run 换成另一个发射参数生成器：由仰角、侧向角（弧度）
 * 用 Math.sin / Math.cos 算方向向量（真实内核把 (1, 仰角斜率, 侧向斜率) 用 sqrt 归一，不用三角函数）。
 * 其余照旧：飞行仍走 RK4，sqrt 选项（dsqrt / Math.sqrt）照常生效，检查点与哈希规则不变。
 *
 * 实测（2026-10-07，linux x64，node 22 对 bun 1.4）：小角度上 Math.sin / Math.cos 在 V8 与 JSC 之间
 * 约 1%–3% 的输入差 1 ulp，每拍 4 次调用，前几十拍内就会出现分歧，两条 sqrt 路径都会判红。
 *
 * 由 det.ts 用 buildSim({ entry: 本文件, outDir: 临时目录, dts: false }) 打包；本文件不进任何发布产物。
 * 入口末尾与 packages/sim/src/index.ts 一样，把 API 显式挂到 GameGlobal / globalThis（build.ts 会校验这一句）。
 */
import { api, type BadmintonSimApi } from '../../../packages/sim/src/api';
import type { SqrtFn } from '../../../packages/sim/src/math';
import { RNG_SCATTER, rngNextUnit } from '../../../packages/sim/src/rng';
import {
  SG_ALPHA,
  SG_PX,
  SG_PY,
  SG_PZ,
  SG_VX,
  SG_VY,
  SG_VZ,
  runKernelWith,
  type KernelOptions,
  type KernelResult,
} from '../../../packages/sim/src/kernel';

/** 微信小游戏的全局对象；其他环境不存在，用 typeof 判断。 */
declare const GameGlobal: { BadmintonSim?: unknown } | undefined;

/**
 * 发射参数生成器（三角函数版）：初速 20–80 m/s、仰角 −0.4–0.7 rad、侧向角 −0.3–0.3 rad、α 0.4–1.5，
 * 出手点 (1, 2.8, 0)；方向 = (cos 仰角·cos 侧向角, sin 仰角, cos 仰角·sin 侧向角)。
 */
export function shotGenSin(rng: Int32Array, ro: number, _sqrt: SqrtFn, out: Float64Array, oo: number): void {
  const r = ro + RNG_SCATTER;
  const sp = 20 + rngNextUnit(rng, r) * 60;
  const el = -0.4 + rngNextUnit(rng, r) * 1.1;
  const az = -0.3 + rngNextUnit(rng, r) * 0.6;
  const alpha = 0.4 + rngNextUnit(rng, r) * 1.1;
  const ce = Math.cos(el);
  out[oo + SG_PX] = 1;
  out[oo + SG_PY] = 2.8;
  out[oo + SG_PZ] = 0;
  out[oo + SG_VX] = sp * ce * Math.cos(az);
  out[oo + SG_VY] = sp * Math.sin(el);
  out[oo + SG_VZ] = sp * ce * Math.sin(az);
  out[oo + SG_ALPHA] = alpha;
}

function runSin(opts?: KernelOptions): KernelResult {
  return runKernelWith(shotGenSin, opts);
}

const fixtureApi: BadmintonSimApi = { ...api, kernel: { ...api.kernel, run: runSin } };

(typeof GameGlobal !== 'undefined' ? GameGlobal : (globalThis as { BadmintonSim?: unknown })).BadmintonSim = fixtureApi;
