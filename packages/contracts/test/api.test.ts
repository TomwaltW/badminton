/**
 * api 常量一致性：时间单位（并与 packages/sim/src/flight.ts 对照）、INPUT_KIND、SIM_EVENT 编号与打包、
 * 击球表轴、统一导出；以及类型层面的检查（一个假的 CreateSim 能通过 tsc）。
 * 另外检查每个 src 文件头都写明"契约草案 v0，待 10-11 人工审定冻结。"。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  INPUT_KIND,
  INPUT_OFFSET_MAX_MS,
  INPUT_OFFSET_MIN_MS,
  JUDGE_GRADE,
  PREDICT_LEN,
  SHOT,
  SHOT_COUNT,
  SHOT_TABLE_CELLS,
  SHOT_TABLE_D_COUNT,
  SHOT_TABLE_D_MIN_M,
  SHOT_TABLE_D_STEP_M,
  SHOT_TABLE_H_COUNT,
  SHOT_TABLE_H_MIN_M,
  SHOT_TABLE_H_STEP_M,
  SIM_EVENT,
  SIM_EVENT_STRIDE,
  SIM_HZ,
  U_PER_MS,
  U_PER_SECOND,
  U_PER_TICK,
  packSimEventHead,
  simEventCode,
  simEventPlayer,
  type ContentBundle,
  type CreateSim,
  type InputEvent,
  type ShotTables,
  type Sim,
} from '../src/api';
import * as contracts from '../src/index';
import { createSnapshot, type Snapshot } from '../src/snapshot.schema';
import { defaultMatchCfg } from '../src/match-cfg';
import * as flight from '../../sim/src/flight';

const SRC = resolve(import.meta.dir, '../src');

describe('时间单位', () => {
  test('1u = 1/30000 s：U_PER_TICK × SIM_HZ = U_PER_MS × 1000 = 30000', () => {
    expect(U_PER_TICK * SIM_HZ).toBe(30000);
    expect(U_PER_MS * 1000).toBe(30000);
    expect(U_PER_SECOND).toBe(30000);
  });

  test('与 sim 内核一致：SIM_HZ、U_PER_TICK 相同，2 个子步 × 500u = 1 tick', () => {
    expect(flight.SIM_HZ).toBe(SIM_HZ);
    expect(flight.U_PER_TICK).toBe(U_PER_TICK);
    expect(flight.U_PER_SUBSTEP * 2).toBe(U_PER_TICK);
    expect(flight.U_PER_SUBSTEP * flight.SUBSTEPS_PER_TICK).toBe(U_PER_TICK);
    expect(flight.SUBSTEP_DT * flight.SUBSTEPS_PER_TICK * SIM_HZ).toBeCloseTo(1, 15);
  });

  test('offMs 范围是 i8；下限 −128', () => {
    expect(INPUT_OFFSET_MIN_MS).toBe(-128);
    expect(INPUT_OFFSET_MAX_MS).toBe(127);
  });
});

describe('输入与事件码', () => {
  test('INPUT_KIND：1..4，0 保留，都放得进 4 位', () => {
    expect(INPUT_KIND).toEqual({ DOWN: 1, RELEASE: 2, PREMOVE: 3, CANCEL: 4 });
    for (const k of Object.values(INPUT_KIND)) expect(k > 0 && k <= 0x0f).toBe(true);
  });

  test('SIM_EVENT：十个事件按计划顺序从 1 连续编号，放得进 8 位', () => {
    expect(Object.keys(SIM_EVENT)).toEqual([
      'LAUNCH',
      'CONTACT',
      'JUDGE',
      'HITSTOP',
      'BOUNCE',
      'NET',
      'OUT',
      'DEADBALL',
      'POINT',
      'GAME_END',
    ]);
    expect(Object.values(SIM_EVENT)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(SIM_EVENT_STRIDE).toBe(4);
  });

  test('事件头打包：code | player << 8，往返', () => {
    for (const code of Object.values(SIM_EVENT)) {
      for (const p of [0, 1] as const) {
        const h = packSimEventHead(code, p);
        expect(h).toBe(code | (p << 8));
        expect(simEventCode(h)).toBe(code);
        expect(simEventPlayer(h)).toBe(p);
      }
    }
  });

  test('JUDGE_GRADE 从 1 编号；SHOT 为 0..7 的击球表下标', () => {
    expect(Object.values(JUDGE_GRADE)).toEqual([1, 2, 3, 4]);
    expect(Object.values(SHOT)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(SHOT_COUNT).toBe(8);
  });
});

describe('击球表轴（计划 2.5）', () => {
  test('8 × 15 × 53 = 6360 格；高度 0.4–3.2 m，距离 1–14 m', () => {
    expect(SHOT_TABLE_CELLS).toBe(6360);
    expect(SHOT_TABLE_H_MIN_M + SHOT_TABLE_H_STEP_M * (SHOT_TABLE_H_COUNT - 1)).toBeCloseTo(3.2, 12);
    expect(SHOT_TABLE_D_MIN_M + SHOT_TABLE_D_STEP_M * (SHOT_TABLE_D_COUNT - 1)).toBe(14);
    expect(SHOT_TABLE_CELLS * 4).toBeLessThan(26 * 1024);
  });
});

describe('统一导出', () => {
  test('index 导出各模块的关键名字', () => {
    const names = Object.keys(contracts);
    for (const n of [
      'SIM_HZ',
      'U_PER_TICK',
      'U_PER_MS',
      'INPUT_KIND',
      'INPUT_OFFSET_MIN_MS',
      'SIM_EVENT',
      'SIM_EVENT_STRIDE',
      'RULES_ID',
      'PLAYER_KIND',
      'MATCH_CFG_I32_LEN',
      'encodeMatchCfg',
      'decodeMatchCfg',
      'validateMatchCfg',
      'defaultMatchCfg',
      'defaultPlayerCfg',
      'INPUT_EVENT_BYTES',
      'encodeInputEvent',
      'decodeInputEvent',
      'validateInputEvent',
      'SNAPSHOT_MAGIC',
      'SNAPSHOT_SCHEMA_VER',
      'POS_RING_LEN',
      'computeLayout',
      'createSnapshot',
      'normalizeNegZero',
      'findNaN',
      'SNAP_I32_LEN',
      'SNAP_F64_LEN',
      'SNAP_I32_MATCH_CFG',
      'encodeReplay',
      'decodeReplay',
      'ReplayError',
      'REPLAY_HASH_EVERY_TICKS',
    ]) {
      expect(names).toContain(n);
    }
  });

  test('每个 src 文件头写明契约草案 v0、待 10-11 人工审定冻结', () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith('.ts')) files.push(join(d, e.name));
      }
    };
    walk(SRC);
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      const head = readFileSync(f, 'utf8').slice(0, 800);
      expect([f, head.includes('契约草案 v0，待 10-11 人工审定冻结。')]).toEqual([f, true]);
    }
  });
});

describe('类型契约（编译期）', () => {
  test('一个假的 CreateSim 满足 Sim 接口', () => {
    const fake: CreateSim = (cfg, content, tables) => {
      const view = new Float64Array(4);
      let tick = 0;
      const sim: Sim = {
        step(_inputs: ArrayLike<InputEvent>) {
          tick += 1;
        },
        save(dst: Snapshot) {
          dst.i32[contracts.SNAP_I32_TICK] = tick;
        },
        load(src: Snapshot) {
          tick = src.i32[contracts.SNAP_I32_TICK]!;
        },
        hash: () => (cfg.seed ^ content.contentHash ^ tables.tablesHash) >>> 0,
        drainEvents: (_out: Int32Array) => 0,
        predictContact: (_p: 0 | 1, out: Float64Array) => out.length >= PREDICT_LEN,
        view,
      };
      return sim;
    };
    const content = { contentHash: 7 } as unknown as ContentBundle;
    const tables: ShotTables = {
      tablesHash: 9,
      slope: new Float32Array(SHOT_TABLE_CELLS),
      valid: new Uint8Array(SHOT_TABLE_CELLS),
    };
    const sim = fake(defaultMatchCfg(1), content, tables);
    sim.step([]);
    const snap = createSnapshot();
    sim.save(snap);
    expect(snap.i32[contracts.SNAP_I32_TICK]).toBe(1);
    sim.load(createSnapshot());
    sim.save(snap);
    expect(snap.i32[contracts.SNAP_I32_TICK]).toBe(0);
    expect(sim.hash()).toBe((1 ^ 7 ^ 9) >>> 0);
    expect(sim.predictContact(0, new Float64Array(PREDICT_LEN))).toBe(true);
  });
});
