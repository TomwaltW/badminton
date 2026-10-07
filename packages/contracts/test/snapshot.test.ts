/**
 * 快照布局：生成器输出与已提交文件一致（含 --check 退出码）、偏移连续无重叠、名字唯一、
 * 只许追加（对照 fixtures/snapshot-layout.v<ver>.json 基线）、与 sim 内核布局的对齐、
 * MATCH_CFG 槽数、createSnapshot / validateSnapshotHeader / normalizeNegZero / findNaN。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GEN_OFFSETS_PATH, genSnapshotOffsets, renderSnapshotOffsets } from '../scripts/gen-snapshot-offsets';
import * as offs from '../src/gen/snapshot-offsets';
import { MATCH_CFG_I32_LEN, decodeMatchCfg, defaultMatchCfg, encodeMatchCfg } from '../src/match-cfg';
import {
  POS_RING_LEN,
  SNAPSHOT_F64_FIELDS,
  SNAPSHOT_F64_LAYOUT,
  SNAPSHOT_I32_FIELDS,
  SNAPSHOT_I32_LAYOUT,
  SNAPSHOT_MAGIC,
  SNAPSHOT_SCHEMA_VER,
  computeLayout,
  createSnapshot,
  findNaN,
  normalizeNegZero,
  slotOffset,
  validateSnapshotHeader,
  type SnapshotLayout,
} from '../src/snapshot.schema';
import { FL_G, FL_K, FL_PX, FL_STRIDE, FL_VX, flightLaunch } from '../../sim/src/flight';
import { RNG_AI_A, RNG_AI_B, RNG_SCATTER, deriveRngStreams } from '../../sim/src/rng';
import { FNV_OFFSET, fnvHashState } from '../../sim/src/hash';

const GEN_SCRIPT = resolve(import.meta.dir, '../scripts/gen-snapshot-offsets.ts');
const BASELINE = resolve(import.meta.dir, `../fixtures/snapshot-layout.v${SNAPSHOT_SCHEMA_VER}.json`);
const BUN = process.execPath;
const OFFS = offs as unknown as Record<string, number>;

interface BaseSlot {
  name: string;
  offset: number;
  count: number;
}
interface Baseline {
  schemaVer: number;
  i32Len: number;
  f64Len: number;
  i32: BaseSlot[];
  f64: BaseSlot[];
}

/** "只许追加"检查：基线每一项必须原样出现在当前布局的同一位置。返回违规说明。 */
function appendOnlyViolations(base: readonly BaseSlot[], cur: readonly BaseSlot[]): string[] {
  const v: string[] = [];
  if (cur.length < base.length) v.push(`字段数从 ${base.length} 减到 ${cur.length}`);
  for (let i = 0; i < base.length && i < cur.length; i++) {
    const b = base[i]!;
    const c = cur[i]!;
    if (b.name !== c.name || b.offset !== c.offset || b.count !== c.count) {
      v.push(`第 ${i} 项：基线 ${b.name}@${b.offset}×${b.count}，当前 ${c.name}@${c.offset}×${c.count}`);
    }
  }
  return v;
}

function strip(l: SnapshotLayout): BaseSlot[] {
  return l.slots.map((s) => ({ name: s.name, offset: s.offset, count: s.count }));
}

function runGen(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(BUN, [GEN_SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('偏移生成器', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'contracts-gen-'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('生成内容与已提交的 src/gen/snapshot-offsets.ts 逐字相同', () => {
    expect(readFileSync(GEN_OFFSETS_PATH, 'utf8')).toBe(renderSnapshotOffsets());
  });

  test('生成文件头写明"自动生成，勿手改"与草案 v0', () => {
    const text = readFileSync(GEN_OFFSETS_PATH, 'utf8');
    expect(text).toContain('自动生成，勿手改');
    expect(text).toContain('契约草案 v0，待 10-11 人工审定冻结。');
  });

  test('--check：与磁盘一致时退出 0', () => {
    const r = runGen(['--check']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('一致');
  });

  test('--check：内容不同或文件缺失时退出 1 且绝不写盘；默认模式写出后再 --check 通过', () => {
    const p = join(dir, 'offsets.ts');
    expect(runGen(['--check', '--out', p]).status).toBe(1);
    expect(existsSync(p)).toBe(false);
    const stale = renderSnapshotOffsets().replace('SNAP_F64_LEN = ', 'SNAP_F64_LEN = 1 + ');
    writeFileSync(p, stale);
    const bad = runGen(['--check', '--out', p]);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('不一致');
    expect(readFileSync(p, 'utf8')).toBe(stale);
    expect(runGen(['--out', p]).status).toBe(0);
    expect(readFileSync(p, 'utf8')).toBe(renderSnapshotOffsets());
    expect(runGen(['--check', '--out', p]).status).toBe(0);
  });

  test('默认模式：内容已是最新时不写盘', () => {
    const p = join(dir, 'fresh.ts');
    expect(genSnapshotOffsets(p)).toEqual({ path: p, upToDate: false, wrote: true });
    expect(genSnapshotOffsets(p)).toEqual({ path: p, upToDate: true, wrote: false });
    expect(genSnapshotOffsets(p, true)).toEqual({ path: p, upToDate: true, wrote: false });
  });

  test('未知参数退出 2', () => {
    expect(runGen(['--bogus']).status).toBe(2);
  });

  test('生成的常量与 computeLayout 逐项一致，且没有多余常量', () => {
    const want = new Map<string, number>();
    want.set('SNAP_I32_LEN', SNAPSHOT_I32_LAYOUT.length);
    want.set('SNAP_F64_LEN', SNAPSHOT_F64_LAYOUT.length);
    for (const [prefix, l] of [
      ['SNAP_I32', SNAPSHOT_I32_LAYOUT],
      ['SNAP_F64', SNAPSHOT_F64_LAYOUT],
    ] as const) {
      for (const s of l.slots) {
        want.set(`${prefix}_${s.name}`, s.offset);
        want.set(`${prefix}_${s.name}_LEN`, s.count);
      }
    }
    expect(new Set(Object.keys(OFFS))).toEqual(new Set(want.keys()));
    for (const [k, v] of want) expect(OFFS[k]).toBe(v);
  });
});

describe('布局不变量', () => {
  for (const [name, l] of [
    ['I32', SNAPSHOT_I32_LAYOUT],
    ['F64', SNAPSHOT_F64_LAYOUT],
  ] as const) {
    test(`${name}：偏移从 0 起连续、无重叠，总长 = 各段之和`, () => {
      let at = 0;
      for (const s of l.slots) {
        expect(s.offset).toBe(at);
        expect(Number.isInteger(s.count) && s.count >= 1).toBe(true);
        at += s.count;
      }
      expect(l.length).toBe(at);
    });
    test(`${name}：展开后的名字唯一`, () => {
      const names = l.slots.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
    });
  }

  test('I32 头字段顺序（计划 2.5）', () => {
    expect(SNAPSHOT_I32_FIELDS.map((f) => f.name)).toEqual([
      'MAGIC',
      'SCHEMA_VER',
      'SIM_VER',
      'CONTENT_HASH',
      'TICK',
      'RNG_AI_A',
      'RNG_AI_B',
      'RNG_SCATTER',
      'PHASE',
      'SCORE',
      'GAMES',
      'SERVER',
      'HITSTOP_LEFT',
      'POS_RING_HEAD',
      'MATCH_CFG',
    ]);
    expect(offs.SNAP_I32_SCORE_LEN).toBe(2);
    expect(offs.SNAP_I32_GAMES_LEN).toBe(2);
  });

  test('MATCH_CFG 槽数 = MATCH_CFG_I32_LEN，且 encodeMatchCfg 能直接写进快照头', () => {
    expect(offs.SNAP_I32_MATCH_CFG_LEN).toBe(MATCH_CFG_I32_LEN);
    const s = createSnapshot();
    const cfg = defaultMatchCfg(0xfedcba98);
    encodeMatchCfg(cfg, s.i32, offs.SNAP_I32_MATCH_CFG);
    expect(decodeMatchCfg(s.i32, offs.SNAP_I32_MATCH_CFG)).toEqual(cfg);
    expect(offs.SNAP_I32_MATCH_CFG + offs.SNAP_I32_MATCH_CFG_LEN).toBeLessThanOrEqual(offs.SNAP_I32_LEN);
  });

  test('3 路 RNG 槽相邻且顺序同 sim/rng.ts：deriveRngStreams 可直接写进快照头', () => {
    expect(offs.SNAP_I32_RNG_AI_A + RNG_AI_B - RNG_AI_A).toBe(offs.SNAP_I32_RNG_AI_B);
    expect(offs.SNAP_I32_RNG_AI_A + RNG_SCATTER - RNG_AI_A).toBe(offs.SNAP_I32_RNG_SCATTER);
    const s = createSnapshot();
    deriveRngStreams(12345, s.i32, offs.SNAP_I32_RNG_AI_A);
    expect(s.i32[offs.SNAP_I32_MAGIC]).toBe(SNAPSHOT_MAGIC);
    expect(s.i32[offs.SNAP_I32_RNG_AI_A]).not.toBe(0);
    expect(s.i32[offs.SNAP_I32_RNG_SCATTER]).not.toBe(0);
    expect(s.i32[offs.SNAP_I32_PHASE]).toBe(0);
  });

  test('球的前 8 槽与 sim/flight.ts 的 FL_* 布局一致（可原地积分）', () => {
    expect(offs.SNAP_F64_BALL_POS + FL_PX).toBe(offs.SNAP_F64_BALL_POS);
    expect(offs.SNAP_F64_BALL_POS + FL_VX).toBe(offs.SNAP_F64_BALL_VEL);
    expect(offs.SNAP_F64_BALL_POS + FL_G).toBe(offs.SNAP_F64_BALL_G);
    expect(offs.SNAP_F64_BALL_POS + FL_K).toBe(offs.SNAP_F64_BALL_K);
    expect(offs.SNAP_F64_BALL_K + 1 - offs.SNAP_F64_BALL_POS).toBe(FL_STRIDE);
    const s = createSnapshot();
    s.f64[offs.SNAP_F64_BALL_ALPHA] = 1.25;
    flightLaunch(s.f64, offs.SNAP_F64_BALL_POS, 1, 2.8, 0, 30, 20, 1, 1.25, 9.81, 0.232);
    expect(s.f64[offs.SNAP_F64_BALL_VEL]).toBe(37.5);
    expect(s.f64[offs.SNAP_F64_BALL_G]).toBe(9.81 * 1.25 * 1.25);
    expect(s.f64[offs.SNAP_F64_BALL_ALPHA]).toBe(1.25);
  });

  test('按球员展开：P1_X = P0_X + P0_X_LEN，两段相邻', () => {
    let n = 0;
    for (const f of SNAPSHOT_F64_FIELDS) {
      if (f.perPlayer !== true) continue;
      const p0 = OFFS[`SNAP_F64_P0_${f.name}`]!;
      const len = OFFS[`SNAP_F64_P0_${f.name}_LEN`]!;
      expect(len).toBe(f.count);
      expect(OFFS[`SNAP_F64_P1_${f.name}`]).toBe(p0 + len);
      expect(OFFS[`SNAP_F64_P1_${f.name}_LEN`]).toBe(len);
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(6);
  });

  test('位置环：每名球员 8 个 tick × 3 坐标', () => {
    expect(POS_RING_LEN).toBe(8);
    expect(offs.SNAP_F64_P0_POS_RING_LEN).toBe(POS_RING_LEN * 3);
    expect(offs.SNAP_F64_P1_POS_RING_LEN).toBe(POS_RING_LEN * 3);
    expect(offs.SNAP_I32_POS_RING_HEAD_LEN).toBe(1);
  });

  test('v0 的 AI 状态块在 F64 体末尾（反应计时、落点估计、习惯环）', () => {
    const names = SNAPSHOT_F64_LAYOUT.slots.map((s) => s.name);
    const first = names.findIndex((n) => /^P[01]_AI_/.test(n));
    expect(first).toBeGreaterThan(0);
    for (const n of names.slice(first)) expect(n).toMatch(/^P[01]_AI_/);
    for (const want of ['P0_AI_REACT_U', 'P1_AI_REACT_U', 'P0_AI_EST', 'P1_AI_EST', 'P0_AI_HABIT', 'P1_AI_HABIT']) {
      expect(names).toContain(want);
    }
  });
});

describe('只许追加（对照基线）', () => {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;

  test('基线与当前布局版本相同', () => {
    expect(base.schemaVer).toBe(SNAPSHOT_SCHEMA_VER);
  });

  test('I32 头：基线各项的名字、偏移、count 不变，新字段只在末尾', () => {
    expect(appendOnlyViolations(base.i32, strip(SNAPSHOT_I32_LAYOUT))).toEqual([]);
    expect(SNAPSHOT_I32_LAYOUT.length).toBeGreaterThanOrEqual(base.i32Len);
  });

  test('F64 体：基线各项的名字、偏移、count 不变，新字段只在末尾', () => {
    expect(appendOnlyViolations(base.f64, strip(SNAPSHOT_F64_LAYOUT))).toEqual([]);
    expect(SNAPSHOT_F64_LAYOUT.length).toBeGreaterThanOrEqual(base.f64Len);
  });

  test('检查器自测：末尾追加通过；插入、改名、改 count、删除都报违规', () => {
    const fields = [
      { name: 'A', count: 1, doc: '' },
      { name: 'B', count: 2, perPlayer: true, doc: '' },
    ];
    const b0 = strip(computeLayout(fields));
    expect(appendOnlyViolations(b0, strip(computeLayout([...fields, { name: 'C', count: 3, doc: '' }])))).toEqual([]);
    expect(appendOnlyViolations(b0, strip(computeLayout([{ name: 'Z', count: 1, doc: '' }, ...fields]))).length).toBeGreaterThan(0);
    expect(appendOnlyViolations(b0, strip(computeLayout([{ name: 'A2', count: 1, doc: '' }, fields[1]!]))).length).toBe(1);
    expect(appendOnlyViolations(b0, strip(computeLayout([{ name: 'A', count: 2, doc: '' }, fields[1]!]))).length).toBeGreaterThan(0);
    expect(appendOnlyViolations(b0, strip(computeLayout([fields[0]!]))).length).toBeGreaterThan(0);
  });
});

describe('computeLayout', () => {
  test('按球员展开成 P0_/P1_ 相邻两段', () => {
    const l = computeLayout([
      { name: 'X', count: 2, doc: 'x' },
      { name: 'Y', count: 3, perPlayer: true, doc: 'y' },
    ]);
    expect(l.length).toBe(8);
    expect(l.slots.map((s) => [s.name, s.field, s.player, s.offset, s.count])).toEqual([
      ['X', 'X', -1, 0, 2],
      ['P0_Y', 'Y', 0, 2, 3],
      ['P1_Y', 'Y', 1, 5, 3],
    ]);
    expect(slotOffset(l, 'P1_Y')).toBe(5);
    expect(() => slotOffset(l, 'NOPE')).toThrow(/没有字段/);
  });

  test('名字重复（含展开后撞名）抛错', () => {
    expect(() => computeLayout([{ name: 'A', count: 1, doc: '' }, { name: 'A', count: 1, doc: '' }])).toThrow(/重复/);
    expect(() =>
      computeLayout([
        { name: 'P0_B', count: 1, doc: '' },
        { name: 'B', count: 1, perPlayer: true, doc: '' },
      ]),
    ).toThrow(/重复/);
  });

  test('非法名字与 count 抛错', () => {
    for (const name of ['a', '1A', 'A-B', 'LEN', 'X_LEN', '']) {
      expect(() => computeLayout([{ name, count: 1, doc: '' }])).toThrow(/不合法/);
    }
    for (const count of [0, -1, 1.5, Number.NaN]) {
      expect(() => computeLayout([{ name: 'A', count, doc: '' }])).toThrow(/count/);
    }
  });

  test('纯函数：同一输入两次结果相同', () => {
    expect(computeLayout(SNAPSHOT_F64_FIELDS)).toEqual(SNAPSHOT_F64_LAYOUT);
    expect(computeLayout(SNAPSHOT_I32_FIELDS)).toEqual(SNAPSHOT_I32_LAYOUT);
  });
});

describe('快照对象', () => {
  test("SNAPSHOT_MAGIC 的小端字节是 'BMSS'", () => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, SNAPSHOT_MAGIC, true);
    expect(String.fromCharCode(...b)).toBe('BMSS');
  });

  test('createSnapshot：长度、魔数、布局版本；其余为 0', () => {
    const s = createSnapshot();
    expect(s.i32.length).toBe(offs.SNAP_I32_LEN);
    expect(s.f64.length).toBe(offs.SNAP_F64_LEN);
    expect(s.i32[offs.SNAP_I32_MAGIC]).toBe(SNAPSHOT_MAGIC);
    expect(s.i32[offs.SNAP_I32_SCHEMA_VER]).toBe(SNAPSHOT_SCHEMA_VER);
    expect(s.f64.every((x) => x === 0)).toBe(true);
    expect(validateSnapshotHeader(s)).toBeNull();
    // 两份新快照的哈希相同（sim 的 fnvHashState 可直接作用于快照）。
    expect(fnvHashState(FNV_OFFSET, s.i32, s.f64)).toBe(fnvHashState(FNV_OFFSET, createSnapshot().i32, createSnapshot().f64));
  });

  test('validateSnapshotHeader 发现长度、魔数、版本错误', () => {
    const s = createSnapshot();
    s.i32[offs.SNAP_I32_MAGIC] = 0x504d5242;
    expect(validateSnapshotHeader(s)).toMatch(/魔数/);
    const s2 = createSnapshot();
    s2.i32[offs.SNAP_I32_SCHEMA_VER] = 7;
    expect(validateSnapshotHeader(s2)).toMatch(/版本/);
    expect(validateSnapshotHeader({ i32: new Int32Array(3), f64: createSnapshot().f64 })).toMatch(/I32/);
    expect(validateSnapshotHeader({ i32: createSnapshot().i32, f64: new Float64Array(1) })).toMatch(/F64/);
  });

  test('normalizeNegZero：−0 → +0（位全零），其余不变，返回个数', () => {
    const a = new Float64Array([-0, 0, 1, -1, Number.NaN, -0, Number.NEGATIVE_INFINITY, -1e-300]);
    expect(normalizeNegZero(a)).toBe(2);
    expect(Object.is(a[0], 0)).toBe(true);
    expect(Object.is(a[5], 0)).toBe(true);
    expect(Object.is(a[1], 0)).toBe(true);
    expect(a[2]).toBe(1);
    expect(a[3]).toBe(-1);
    expect(Number.isNaN(a[4])).toBe(true);
    expect(a[6]).toBe(Number.NEGATIVE_INFINITY);
    expect(a[7]).toBe(-1e-300);
    expect(new Uint8Array(a.buffer, 0, 8).every((b) => b === 0)).toBe(true);
    expect(normalizeNegZero(a)).toBe(0);
  });

  test('归一后 −0 与 +0 的快照哈希相同', () => {
    const s1 = createSnapshot();
    const s2 = createSnapshot();
    s1.f64[offs.SNAP_F64_P0_VEL] = -0;
    expect(fnvHashState(FNV_OFFSET, s1.i32, s1.f64)).not.toBe(fnvHashState(FNV_OFFSET, s2.i32, s2.f64));
    normalizeNegZero(s1.f64);
    expect(fnvHashState(FNV_OFFSET, s1.i32, s1.f64)).toBe(fnvHashState(FNV_OFFSET, s2.i32, s2.f64));
  });

  test('findNaN：返回首个 NaN 下标，没有则 −1；无穷不算 NaN', () => {
    expect(findNaN(new Float64Array([1, 2, Number.POSITIVE_INFINITY]))).toBe(-1);
    expect(findNaN(new Float64Array(0))).toBe(-1);
    expect(findNaN(new Float64Array([0, 1, 2, Number.NaN, 4, Number.NaN]))).toBe(3);
    const s = createSnapshot();
    s.f64[offs.SNAP_F64_P1_AI_EST + 1] = 0 / 0;
    expect(findNaN(s.f64)).toBe(offs.SNAP_F64_P1_AI_EST + 1);
  });
});
