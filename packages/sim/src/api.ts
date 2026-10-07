/**
 * 模拟核心对外 API（v0）：dist/sim.js 末尾把它挂到全局 BadmintonSim 上。
 *
 * 本单只有内核（math / rng / hash / flight / events / kernel）；createSim、step、快照等
 * 按 packages/contracts 的契约在 SIM 轨逐步加入。字段只增不删，改名视为契约变更。
 */

import { dsqrt } from './math';
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
} from './rng';
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
} from './hash';
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
} from './flight';
import { CROSS_ANY, CROSS_DOWN, CROSS_UP, NO_CROSS, crossSubstep, eventTimeU } from './events';
import {
  CP_SHOT_END,
  CP_STRIDE,
  CP_TICK,
  KERNEL_CHECK_EVERY,
  KERNEL_CORPUS_VERSION,
  KERNEL_DEFAULT_SEED,
  KERNEL_DEFAULT_SHOTS,
  runKernel,
  runKernelWith,
  shotGenSpike,
} from './kernel';

/** API 形状版本：字段增删或语义变化时加 1。 */
export const SIM_API_VERSION = 0;

export const api = {
  apiVersion: SIM_API_VERSION,
  dsqrt,
  rng: {
    RNG_AI_A,
    RNG_AI_B,
    RNG_SCATTER,
    RNG_STREAMS,
    RNG_FALLBACK_STATE,
    Rng,
    mixSeed32,
    deriveRngStreams,
    rngNextU32,
    rngNextUnit,
    rngNextRange,
  },
  hash: {
    FNV_OFFSET,
    FNV_PRIME,
    fnvMixI32,
    fnvMixF64,
    fnvHashI32,
    fnvHashF64,
    fnvHashState,
    fnvBytes,
    toU32,
    hex8,
  },
  flight: {
    FL_PX,
    FL_PY,
    FL_PZ,
    FL_VX,
    FL_VY,
    FL_VZ,
    FL_G,
    FL_K,
    FL_STRIDE,
    FL_KINEMATIC,
    G_STD,
    VT_STD,
    K_STD,
    SIM_HZ,
    U_PER_TICK,
    SUBSTEPS_PER_TICK,
    U_PER_SUBSTEP,
    SUBSTEP_DT,
    dragFromTerminal,
    flightLaunch,
    copyKinematics,
    stepRk4,
    stepSubstep,
  },
  events: {
    CROSS_DOWN,
    CROSS_UP,
    CROSS_ANY,
    NO_CROSS,
    crossSubstep,
    eventTimeU,
  },
  kernel: {
    CORPUS_VERSION: KERNEL_CORPUS_VERSION,
    DEFAULT_SHOTS: KERNEL_DEFAULT_SHOTS,
    DEFAULT_SEED: KERNEL_DEFAULT_SEED,
    CHECK_EVERY: KERNEL_CHECK_EVERY,
    CP_TICK,
    CP_SHOT_END,
    CP_STRIDE,
    run: runKernel,
    runWith: runKernelWith,
    shotGenSpike,
  },
};

export type BadmintonSimApi = typeof api;
