/**
 * 互比与"首个分歧"逻辑的单元测试：直接构造检查点数组（[种类, 拍号, 全局 tick, 哈希] × N）。
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LAYOUT,
  checkpointCount,
  firstDivergence,
  formatDivergence,
  hex8,
  kindLabel,
  recordAt,
  type CheckpointLayout,
  type PathRun,
} from '../compare';
import { comparePath } from '../det';
import type { EngineResult, DriverOutput, DriverPath } from '../runner';
import type { EngineSpec } from '../config';

const T = DEFAULT_LAYOUT.tick;
const E = DEFAULT_LAYOUT.shotEnd;

/** 一段典型序列：拍 0 有 tick 30、60 两个状态检查点后结束于 tick 75；拍 1 在 tick 90 有状态检查点后结束于 tick 101。 */
function seq(): number[] {
  return [T, 0, 30, 0x11111111, T, 0, 60, 0x22222222, E, 0, 75, 0x33333333, T, 1, 90, 0x44444444, E, 1, 101, 0x55555555];
}

function run(cps: number[], hash = cps.length ? cps[cps.length - 1]! : 0, steps = 101): PathRun {
  return { hash, steps, checkpoints: cps };
}

describe('firstDivergence', () => {
  test('完全一致 → null', () => {
    expect(firstDivergence(run(seq()), run(seq()))).toBeNull();
    expect(firstDivergence(run([], 7, 0), run([], 7, 0))).toBeNull();
  });

  test('某条检查点哈希不同 → 报告该条的拍号、tick、种类与双方哈希，以及上一条相同的检查点', () => {
    const b = seq();
    const o = seq();
    o[3 * 4 + 3] = 0xdeadbeef; // 第 4 条（拍 1、tick 90、状态检查点）
    o[4 * 4 + 3] = 0x0badf00d;
    const d = firstDivergence(run(b), run(o))!;
    expect(d.reason).toBe('checkpoint');
    expect(d.index).toBe(3);
    expect(d.base).toEqual({ index: 3, kind: T, shot: 1, tick: 90, hash: 0x44444444 });
    expect(d.other).toEqual({ index: 3, kind: T, shot: 1, tick: 90, hash: 0xdeadbeef });
    expect(d.prev).toEqual({ index: 2, kind: E, shot: 0, tick: 75, hash: 0x33333333 });
    expect(d.baseHash).toBe(0x55555555);
    expect(d.otherHash).toBe(0x0badf00d);

    const text = formatDivergence(d, 'node', 'bun');
    expect(text).toContain('首个分歧');
    expect(text).toContain('语料号（拍号）1');
    expect(text).toContain('全局 tick 90');
    expect(text).toContain('30 tick 完整状态');
    expect(text).toContain('node：44444444');
    expect(text).toContain('bun：deadbeef');
    expect(text).toContain('上一条相同的检查点（语料号（拍号）0，全局 tick 75，一拍结束）');
  });

  test('只有最后一条（一拍结束）不同 → 种类报"一拍结束"', () => {
    const o = seq();
    o[4 * 4 + 3] = 1;
    const d = firstDivergence(run(seq()), run(o))!;
    expect(d.index).toBe(4);
    expect(d.base!.kind).toBe(E);
    expect(formatDivergence(d, 'a', 'b')).toContain('检查点种类：一拍结束');
  });

  test('第一条就不同 → prev 为 null', () => {
    const o = seq();
    o[3] = 0;
    const d = firstDivergence(run(seq()), run(o))!;
    expect(d.index).toBe(0);
    expect(d.prev).toBeNull();
    expect(formatDivergence(d, 'a', 'b')).toContain('第一条检查点就已分歧');
  });

  test('检查点位置不同（tick 与种类都变了）→ 分别描述双方', () => {
    const o = seq();
    // 另一方拍 0 提前一个 tick 落地：第 3 条变成 tick 74 的"一拍结束"
    o[2 * 4 + 2] = 74;
    o[2 * 4 + 3] = 0x99999999;
    const d = firstDivergence(run(seq()), run(o))!;
    expect(d.reason).toBe('checkpoint');
    expect(d.index).toBe(2);
    const text = formatDivergence(d, 'node', 'jsc');
    expect(text).toContain('双方的检查点位置已不同');
    expect(text).toContain('node：语料号（拍号）0，全局 tick 75，一拍结束，哈希 33333333');
    expect(text).toContain('jsc：语料号（拍号）0，全局 tick 74，一拍结束，哈希 99999999');
  });

  test('一方是另一方的前缀 → reason length，说明哪一方先结束', () => {
    const b = seq();
    const o = seq().slice(0, 12);
    const d = firstDivergence(run(b), run(o, 0x33333333, 75))!;
    expect(d.reason).toBe('length');
    expect(d.index).toBe(3);
    expect(d.base).toEqual({ index: 3, kind: T, shot: 1, tick: 90, hash: 0x44444444 });
    expect(d.other).toBeNull();
    const text = formatDivergence(d, 'node', 'bun');
    expect(text).toContain('bun 的检查点序列已结束，node 还有');
    expect(text).toContain('语料号（拍号）1，全局 tick 90');

    const r = firstDivergence(run(o, 0x33333333, 75), run(b))!;
    expect(r.reason).toBe('length');
    expect(r.base).toBeNull();
    expect(formatDivergence(r, 'node', 'bun')).toContain('node 的检查点序列已结束，bun 还有');
  });

  test('检查点相同但最终哈希不同 → reason hash', () => {
    const d = firstDivergence(run(seq(), 1), run(seq(), 2))!;
    expect(d.reason).toBe('hash');
    expect(d.index).toBe(5);
    const text = formatDivergence(d, 'a', 'b');
    expect(text).toContain('最终哈希不同');
    expect(text).toContain('a：00000001');
    expect(text).toContain('b：00000002');
  });

  test('哈希与检查点都相同、只有 steps 不同 → reason steps', () => {
    const d = firstDivergence(run(seq(), 5, 100), run(seq(), 5, 101))!;
    expect(d.reason).toBe('steps');
    const text = formatDivergence(d, 'a', 'b');
    expect(text).toContain('steps 不同');
    expect(text).toContain('a：100');
    expect(text).toContain('b：101');
  });

  test('检查点种类常量取自 sim（自定义布局）', () => {
    const layout: CheckpointLayout = { stride: 4, tick: 7, shotEnd: 9 };
    expect(kindLabel(7, layout)).toBe('30 tick 完整状态');
    expect(kindLabel(9, layout)).toBe('一拍结束');
    expect(kindLabel(0, layout)).toBe('未知种类 0');
    const b = [7, 0, 30, 1, 9, 0, 40, 2];
    const o = [7, 0, 30, 1, 9, 0, 40, 3];
    expect(formatDivergence(firstDivergence(run(b), run(o), layout)!, 'a', 'b', layout)).toContain('一拍结束');
  });

  test('步长更大的布局也按条比较（多出的字段参与比较）', () => {
    const layout: CheckpointLayout = { stride: 5, tick: 0, shotEnd: 1 };
    const b = [0, 0, 30, 1, 100, 1, 0, 40, 2, 200];
    const o = [0, 0, 30, 1, 100, 1, 0, 40, 2, 201];
    const d = firstDivergence(run(b), run(o), layout)!;
    expect(d.index).toBe(1);
  });

  test('检查点数组长度不是步长的整数倍 → 抛错', () => {
    expect(() => checkpointCount([1, 2, 3], 4)).toThrow('不是 4 的整数倍');
    expect(() => firstDivergence(run([0, 0, 30]), run(seq()))).toThrow();
  });

  test('recordAt 越界返回 null；hex8 补零', () => {
    expect(recordAt(seq(), 5)).toBeNull();
    expect(recordAt(seq(), -1)).toBeNull();
    expect(recordAt(seq(), 0)).toEqual({ index: 0, kind: T, shot: 0, tick: 30, hash: 0x11111111 });
    expect(hex8(0xabc)).toBe('00000abc');
    expect(hex8(-1)).toBe('ffffffff');
  });
});

describe('comparePath（det.ts）', () => {
  const spec = (name: string): EngineSpec => ({ name, kind: 'node', cmd: ['/x'], env: {}, expect: {} });
  const path = (cps: number[], hash: number, steps = 101): DriverPath => ({
    hash,
    steps,
    substeps: steps * 2,
    shots: 2,
    corpusVersion: 1,
    ms: 1,
    checkpoints: cps,
  });
  const result = (name: string, d: DriverPath | null, m: DriverPath | null, errors: string[] = []): EngineResult => ({
    spec: spec(name),
    cmd: ['/x'],
    errors,
    info: null,
    output:
      d && m
        ? ({
            v: 1,
            apiVersion: 0,
            corpusVersion: 1,
            shots: 2,
            seed: null,
            engine: { hasProcess: true, arch: 'x64', nodeVersion: 'v22.0.0', bunVersion: null, webkitVersion: null, cwd: null },
            jit: null,
            dfgCompiles: null,
            timer: 'performance.now',
            cp: DEFAULT_LAYOUT,
            paths: { dsqrt: d, mathSqrt: m },
          } satisfies DriverOutput)
        : null,
    wallMs: 1,
    stderrTail: '',
    stdoutTail: '',
  });

  test('以第一个成功的引擎为基准；没有输出的引擎不参与互比', () => {
    const good = path(seq(), 0x55555555);
    const bad = seq();
    bad[3] = 0;
    const rs = [
      result('missing', null, null, ['可执行文件不存在：/x']),
      result('a', good, good),
      result('b', path(bad, 0x55555555), good),
    ];
    const d = comparePath('dsqrt', rs);
    expect(d.baseline!.spec.name).toBe('a');
    expect(d.consistent).toBe(false);
    expect(d.divergences.map((x) => x.engine.spec.name)).toEqual(['b']);
    expect(d.divergences[0]!.d.index).toBe(0);
    const m = comparePath('mathSqrt', rs);
    expect(m.consistent).toBe(true);
  });

  test('期望不符但有输出的引擎不当基准，但照样参与互比', () => {
    const good = path(seq(), 0x55555555);
    const other = path(seq(), 0x55555555, 102);
    const rs = [result('archBad', other, good, ['arch 不符']), result('ok', good, good)];
    const d = comparePath('dsqrt', rs);
    expect(d.baseline!.spec.name).toBe('ok');
    expect(d.divergences.map((x) => x.engine.spec.name)).toEqual(['archBad']);
    expect(d.divergences[0]!.d.reason).toBe('steps');
  });

  test('都没有输出 → 没有基准、不一致', () => {
    const d = comparePath('dsqrt', [result('x', null, null, ['e'])]);
    expect(d.baseline).toBeNull();
    expect(d.consistent).toBe(false);
  });
});
