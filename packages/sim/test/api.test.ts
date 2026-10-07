/**
 * API 单测：导入 '../src/index' 后 globalThis.BadmintonSim 与 api 是同一对象；api 的键与形状。
 * 字段只增不删（api.ts 文件头），所以这里只断言"必须存在"的键，不禁止新增。
 */
import { describe, expect, test } from 'bun:test';
import '../src/index';
import { SIM_API_VERSION, api } from '../src/api';
import { dsqrt } from '../src/math';
import { Rng, deriveRngStreams, rngNextU32 } from '../src/rng';
import { fnvBytes, fnvHashState, fnvMixF64 } from '../src/hash';
import { flightLaunch, stepRk4, stepSubstep } from '../src/flight';
import { crossSubstep, eventTimeU } from '../src/events';
import {
  KERNEL_CHECK_EVERY,
  KERNEL_CORPUS_VERSION,
  KERNEL_DEFAULT_SEED,
  KERNEL_DEFAULT_SHOTS,
  runKernel,
  runKernelWith,
  shotGenSpike,
} from '../src/kernel';

const REQUIRED: Record<string, string[]> = {
  rng: [
    'RNG_AI_A',
    'RNG_AI_B',
    'RNG_SCATTER',
    'RNG_STREAMS',
    'RNG_FALLBACK_STATE',
    'Rng',
    'mixSeed32',
    'deriveRngStreams',
    'rngNextU32',
    'rngNextUnit',
    'rngNextRange',
  ],
  hash: ['FNV_OFFSET', 'FNV_PRIME', 'fnvMixI32', 'fnvMixF64', 'fnvHashI32', 'fnvHashF64', 'fnvHashState', 'fnvBytes', 'toU32', 'hex8'],
  flight: [
    'FL_PX',
    'FL_PY',
    'FL_PZ',
    'FL_VX',
    'FL_VY',
    'FL_VZ',
    'FL_G',
    'FL_K',
    'FL_STRIDE',
    'FL_KINEMATIC',
    'G_STD',
    'VT_STD',
    'K_STD',
    'SIM_HZ',
    'U_PER_TICK',
    'SUBSTEPS_PER_TICK',
    'U_PER_SUBSTEP',
    'SUBSTEP_DT',
    'dragFromTerminal',
    'flightLaunch',
    'copyKinematics',
    'stepRk4',
    'stepSubstep',
  ],
  events: ['CROSS_DOWN', 'CROSS_UP', 'CROSS_ANY', 'NO_CROSS', 'crossSubstep', 'eventTimeU'],
  kernel: ['CORPUS_VERSION', 'DEFAULT_SHOTS', 'DEFAULT_SEED', 'CHECK_EVERY', 'CP_TICK', 'CP_SHOT_END', 'CP_STRIDE', 'run', 'runWith', 'shotGenSpike'],
};

describe('全局挂载', () => {
  test("导入 '../src/index' 后 globalThis.BadmintonSim 就是 api（同一对象）", () => {
    expect(globalThis.BadmintonSim).toBe(api);
  });
});

describe('api 形状', () => {
  test('顶层键', () => {
    expect(Object.keys(api)).toEqual(expect.arrayContaining(['apiVersion', 'dsqrt', 'rng', 'hash', 'flight', 'events', 'kernel']));
    expect(api.apiVersion).toBe(SIM_API_VERSION);
    expect(api.apiVersion).toBe(0);
    expect(api.dsqrt).toBe(dsqrt);
  });

  test('各命名空间的必需键都存在且不是 undefined', () => {
    const ns = api as unknown as Record<string, Record<string, unknown>>;
    for (const name of Object.keys(REQUIRED)) {
      const obj = ns[name]!;
      expect(typeof obj).toBe('object');
      expect(Object.keys(obj)).toEqual(expect.arrayContaining(REQUIRED[name]!));
      for (const k of Object.keys(obj)) expect(obj[k]).not.toBeUndefined();
    }
  });

  test('函数与常数指向源码里的同一实现', () => {
    expect(api.rng.Rng).toBe(Rng);
    expect(api.rng.rngNextU32).toBe(rngNextU32);
    expect(api.rng.deriveRngStreams).toBe(deriveRngStreams);
    expect(api.hash.fnvMixF64).toBe(fnvMixF64);
    expect(api.hash.fnvHashState).toBe(fnvHashState);
    expect(api.hash.fnvBytes).toBe(fnvBytes);
    expect(api.flight.flightLaunch).toBe(flightLaunch);
    expect(api.flight.stepRk4).toBe(stepRk4);
    expect(api.flight.stepSubstep).toBe(stepSubstep);
    expect(api.events.crossSubstep).toBe(crossSubstep);
    expect(api.events.eventTimeU).toBe(eventTimeU);
    expect(api.kernel.run).toBe(runKernel);
    expect(api.kernel.runWith).toBe(runKernelWith);
    expect(api.kernel.shotGenSpike).toBe(shotGenSpike);
    expect(api.kernel.CORPUS_VERSION).toBe(KERNEL_CORPUS_VERSION);
    expect(api.kernel.DEFAULT_SHOTS).toBe(KERNEL_DEFAULT_SHOTS);
    expect(api.kernel.DEFAULT_SEED).toBe(KERNEL_DEFAULT_SEED);
    expect(api.kernel.CHECK_EVERY).toBe(KERNEL_CHECK_EVERY);
  });

  test('经全局对象调用内核语料与直接调用结果相同', () => {
    const r = globalThis.BadmintonSim.kernel.run({ shots: 20 });
    expect(r).toEqual(runKernel({ shots: 20 }));
    expect(typeof r.hash).toBe('number');
    expect(Array.isArray(r.checkpoints)).toBe(true);
  });
});
