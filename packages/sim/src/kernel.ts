/**
 * 内核语料：docs/spike/det-smoke.js 的移植，供 `bun run det --kernel` 与 tools/wx-selftest 使用。
 *
 * 内容 = 飞行 + 随机数 + 哈希：
 * - 由种子派生 3 路随机流；每一拍从散布流取初速、仰角、侧向角、α（与原脚本同分布），
 *   AI-A、AI-B 两路各取一个数混入哈希，保证三路都被走到。
 * - 方向向量不用三角函数：把 (1, el, az) 用注入的 sqrt 归一（dsqrt 路径 / Math.sqrt 路径）。
 * - 每个 tick 2 个 1/60 s RK4 子步；子步内用 events.ts 的同一函数插值三类事件：
 *   过网平面（记录过网高度）、下降到击球高度（记录 t*，单位 u）、落地（记录落点与时刻）。
 * - 每 30 个 tick（按全局 tick 计）把完整状态（i32 + f64 全部槽）混入滚动哈希，并记一个检查点；
 *   每拍结束再混入落点、事件结果并记一个检查点。门禁据检查点定位首个分歧的语料号（拍号）与 tick。
 *
 * 与原脚本的差别（因此哈希不同于实测表里的 3e34ca，跨引擎互比不受影响）：
 * tick = 2 个子步、每 30 tick 混入（原为每 30 子步）、落地点用子步插值、随机数由种子派生 3 路。
 * 原脚本的逐位复现见 packages/sim/test 里的移植单测。
 */

import { dsqrt, type SqrtFn } from './math';
import { RNG_AI_A, RNG_AI_B, RNG_SCATTER, deriveRngStreams, rngNextU32, rngNextUnit } from './rng';
import { FNV_OFFSET, fnvHashState, fnvMixF64, fnvMixI32 } from './hash';
import {
  FL_PX,
  FL_PY,
  FL_PZ,
  FL_STRIDE,
  G_STD,
  K_STD,
  SUBSTEPS_PER_TICK,
  U_PER_SUBSTEP,
  U_PER_TICK,
  flightLaunch,
  stepSubstep,
} from './flight';
import { CROSS_ANY, CROSS_DOWN, NO_CROSS, crossSubstep, eventTimeU } from './events';

/** 语料版本：语料内容（分布、事件、混入规则）一改就加 1，门禁与 wx-selftest 一并打印。 */
export const KERNEL_CORPUS_VERSION = 1;
/** 默认拍数（同原脚本 2,000 次随机击球）。 */
export const KERNEL_DEFAULT_SHOTS = 2000;
/** 默认种子（同原脚本的 xorshift 初值）。 */
export const KERNEL_DEFAULT_SEED = 0x2545f491;
/** 每多少个 tick 混入一次完整状态。 */
export const KERNEL_CHECK_EVERY = 30;
/** 单拍 tick 上限（30 s），只防死循环；正常飞行远低于此。 */
export const KERNEL_MAX_TICKS_PER_SHOT = 900;
/** 语料里的网平面 x（发球点 x = 1，网在 13.4 / 2 处）。 */
export const KERNEL_NET_X = 6.7;
/** 语料里的击球高度（下降穿越时记录 t*）。 */
export const KERNEL_STRIKE_Y = 1.0;

/** 一拍的发射参数布局（ShotGen 的输出）。 */
export const SG_PX = 0;
export const SG_PY = 1;
export const SG_PZ = 2;
export const SG_VX = 3;
export const SG_VY = 4;
export const SG_VZ = 5;
export const SG_ALPHA = 6;
export const SG_LEN = 7;

/**
 * 发射参数生成器：从 rng[ro + RNG_*] 取随机数，把 α = 1 时的初速度与 α 写进 out[oo + SG_*]。
 * 门禁的自测夹具会换一个用了三角函数的生成器，验证 det 能判红。
 */
export type ShotGen = (rng: Int32Array, ro: number, sqrt: SqrtFn, out: Float64Array, oo: number) => void;

/** 检查点种类：每 30 tick 的完整状态混入 / 一拍结束。 */
export const CP_TICK = 0;
export const CP_SHOT_END = 1;
/** 检查点记录的步长：[种类, 拍号, 全局 tick, 哈希 u32]。 */
export const CP_STRIDE = 4;

/** 事件标志位。 */
export const KF_NET = 1;
export const KF_STRIKE = 2;
export const KF_LANDED = 4;
export const KF_CAPPED = 8;

/** 语料状态的 i32 槽。 */
const KI_TICK = 0;
const KI_SHOT = 1;
const KI_SHOT_TICK = 2;
const KI_RNG = 3; // 3 个槽：AI-A、AI-B、散布
const KI_FLAGS = 6;
const KI_LAND_U = 7;
const KI_STRIKE_U = 8;
const KI_LEN = 9;

/** 语料状态的 f64 槽。 */
const KD_BALL = 0; // FL_STRIDE 个槽
const KD_PREV = KD_BALL + FL_STRIDE; // 6 个槽
const KD_EVT = KD_PREV + 6; // 6 个槽
const KD_NET_Y = KD_EVT + 6;
const KD_LAND_X = KD_NET_Y + 1;
const KD_LAND_Z = KD_LAND_X + 1;
const KD_SHOT = KD_LAND_Z + 1; // SG_LEN 个槽
const KD_LEN = KD_SHOT + SG_LEN;

export interface KernelOptions {
  /** 拍数，默认 2000。 */
  shots?: number;
  /** 种子，默认 0x2545f491。 */
  seed?: number;
  /** 平方根；默认 dsqrt。门禁的 Math.sqrt 路径从外部注入 Math.sqrt（模拟核心内不出现 Math.sqrt）。 */
  sqrt?: SqrtFn;
  /** 是否记录检查点（默认 true）；只影响返回值，不影响哈希。 */
  checkpoints?: boolean;
}

export interface KernelResult {
  corpusVersion: number;
  /** 最终滚动哈希（u32）。 */
  hash: number;
  /** 模拟 tick 数（1 tick = 2 个子步）。 */
  steps: number;
  /** RK4 子步数。 */
  substeps: number;
  /** 拍数。 */
  shots: number;
  /** 检查点，扁平数组，每 CP_STRIDE 个数一条：[种类, 拍号, 全局 tick, 哈希]。不记录时为空数组。 */
  checkpoints: number[];
}

/** 原脚本的发射分布：初速 20–80 m/s、仰角斜率 −0.4–0.8、侧向斜率 −0.3–0.3、α 0.4–1.5，出手点 (1, 2.8, 0)。 */
export function shotGenSpike(rng: Int32Array, ro: number, sqrt: SqrtFn, out: Float64Array, oo: number): void {
  const r = ro + RNG_SCATTER;
  const sp = 20 + rngNextUnit(rng, r) * 60;
  const el = -0.4 + rngNextUnit(rng, r) * 1.2;
  const az = -0.3 + rngNextUnit(rng, r) * 0.6;
  const alpha = 0.4 + rngNextUnit(rng, r) * 1.1;
  const len = sqrt(1 + el * el + az * az);
  out[oo + SG_PX] = 1;
  out[oo + SG_PY] = 2.8;
  out[oo + SG_PZ] = 0;
  out[oo + SG_VX] = sp / len;
  out[oo + SG_VY] = (sp * el) / len;
  out[oo + SG_VZ] = (sp * az) / len;
  out[oo + SG_ALPHA] = alpha;
}

/** 用指定的发射参数生成器跑语料（自测夹具用它换生成器）。 */
export function runKernelWith(gen: ShotGen, opts?: KernelOptions): KernelResult {
  const sqrt = opts && opts.sqrt ? opts.sqrt : dsqrt;
  const shots = opts && opts.shots !== undefined ? opts.shots : KERNEL_DEFAULT_SHOTS;
  const seed = opts && opts.seed !== undefined ? opts.seed : KERNEL_DEFAULT_SEED;
  const record = !(opts && opts.checkpoints === false);
  const i32 = new Int32Array(KI_LEN);
  const f64 = new Float64Array(KD_LEN);
  const cps: number[] = [];
  deriveRngStreams(seed, i32, KI_RNG);

  let h = FNV_OFFSET;
  let ticks = 0;
  let substeps = 0;

  for (let n = 0; n < shots; n++) {
    i32[KI_SHOT] = n;
    i32[KI_SHOT_TICK] = 0;
    i32[KI_FLAGS] = 0;
    i32[KI_LAND_U] = -1;
    i32[KI_STRIKE_U] = -1;
    f64[KD_NET_Y] = 0;
    f64[KD_LAND_X] = 0;
    f64[KD_LAND_Z] = 0;

    h = fnvMixI32(h, rngNextU32(i32, KI_RNG + RNG_AI_A));
    h = fnvMixI32(h, rngNextU32(i32, KI_RNG + RNG_AI_B));
    gen(i32, KI_RNG, sqrt, f64, KD_SHOT);
    flightLaunch(
      f64,
      KD_BALL,
      f64[KD_SHOT + SG_PX],
      f64[KD_SHOT + SG_PY],
      f64[KD_SHOT + SG_PZ],
      f64[KD_SHOT + SG_VX],
      f64[KD_SHOT + SG_VY],
      f64[KD_SHOT + SG_VZ],
      f64[KD_SHOT + SG_ALPHA],
      G_STD,
      K_STD,
    );

    let flags = 0;
    while ((flags & KF_LANDED) === 0 && i32[KI_SHOT_TICK] < KERNEL_MAX_TICKS_PER_SHOT) {
      const tickStartU = i32[KI_SHOT_TICK] * U_PER_TICK;
      for (let sub = 0; sub < SUBSTEPS_PER_TICK; sub++) {
        stepSubstep(f64, KD_BALL, f64, KD_PREV, sqrt);
        substeps++;
        const subStartU = tickStartU + sub * U_PER_SUBSTEP;
        let f: number;
        if ((flags & KF_NET) === 0) {
          f = crossSubstep(f64, KD_PREV, f64, KD_BALL, FL_PX, KERNEL_NET_X, CROSS_ANY, f64, KD_EVT);
          if (f !== NO_CROSS) {
            flags |= KF_NET;
            f64[KD_NET_Y] = f64[KD_EVT + FL_PY];
          }
        }
        if ((flags & KF_STRIKE) === 0) {
          f = crossSubstep(f64, KD_PREV, f64, KD_BALL, FL_PY, KERNEL_STRIKE_Y, CROSS_DOWN, f64, KD_EVT);
          if (f !== NO_CROSS) {
            flags |= KF_STRIKE;
            i32[KI_STRIKE_U] = eventTimeU(subStartU, f);
          }
        }
        f = crossSubstep(f64, KD_PREV, f64, KD_BALL, FL_PY, 0, CROSS_DOWN, f64, KD_EVT);
        if (f !== NO_CROSS) {
          flags |= KF_LANDED;
          i32[KI_LAND_U] = eventTimeU(subStartU, f);
          f64[KD_LAND_X] = f64[KD_EVT + FL_PX];
          f64[KD_LAND_Z] = f64[KD_EVT + FL_PZ];
          break;
        }
      }
      i32[KI_FLAGS] = flags;
      i32[KI_SHOT_TICK]++;
      i32[KI_TICK]++;
      ticks++;
      if (i32[KI_TICK] % KERNEL_CHECK_EVERY === 0) {
        h = fnvHashState(h, i32, f64);
        if (record) cps.push(CP_TICK, n, i32[KI_TICK], h >>> 0);
      }
    }
    if ((flags & KF_LANDED) === 0) flags |= KF_CAPPED;
    i32[KI_FLAGS] = flags;

    h = fnvMixF64(h, f64[KD_LAND_X]);
    h = fnvMixF64(h, f64[KD_LAND_Z]);
    h = fnvMixI32(h, i32[KI_LAND_U]);
    h = fnvMixF64(h, f64[KD_NET_Y]);
    h = fnvMixI32(h, i32[KI_STRIKE_U]);
    h = fnvMixI32(h, flags);
    if (record) cps.push(CP_SHOT_END, n, i32[KI_TICK], h >>> 0);
  }

  return {
    corpusVersion: KERNEL_CORPUS_VERSION,
    hash: h >>> 0,
    steps: ticks,
    substeps,
    shots,
    checkpoints: cps,
  };
}

/** 跑标准内核语料（原脚本的发射分布）。 */
export function runKernel(opts?: KernelOptions): KernelResult {
  return runKernelWith(shotGenSpike, opts);
}
