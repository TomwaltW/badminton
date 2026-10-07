/**
 * det.ts 命令行的单元测试：参数解析、尚未实现的模式、前置条件错误（退出码 2）、源码比 sim.js 新的检测。
 * 这些路径都不起引擎子进程。
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError, main, parseArgs, staleSources, type SimPaths } from '../det';
import { fnv1aBytes, hex8 } from '../../sim/fnv';

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `det-${prefix}-`));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 跑 main，收集 stdout / stderr 文本。 */
async function capture(argv: string[], simPaths?: SimPaths): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  try {
    const code = await main(argv, simPaths);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe('parseArgs', () => {
  test('默认值', () => {
    expect(parseArgs(['--kernel'])).toEqual({
      kernel: true,
      matches: false,
      rollback: false,
      profile: null,
      sim: null,
      engines: null,
      shots: null,
      fixture: null,
      json: false,
      help: false,
    });
  });

  test('--flag value 与 --flag=value 两种写法', () => {
    const a = parseArgs(['--kernel', '--profile', 'mac', '--sim=/a/sim.js', '--engines', 'e.json', '--shots=12', '--fixture', 'sin', '--json']);
    expect(a.profile).toBe('mac');
    expect(a.sim).toBe('/a/sim.js');
    expect(a.engines).toBe('e.json');
    expect(a.shots).toBe(12);
    expect(a.fixture).toBe('sin');
    expect(a.json).toBe(true);
  });

  test('--matches 可带局数', () => {
    expect(parseArgs(['--matches', '200', '--kernel']).matches).toBe(true);
    expect(parseArgs(['--matches']).matches).toBe(true);
    expect(parseArgs(['--rollback']).rollback).toBe(true);
  });

  test('开关参数不接受 =值（--json=false 不能被当成打开）', () => {
    for (const a of ['--json=false', '--kernel=0', '--rollback=x', '--help=1']) {
      expect(() => parseArgs([a])).toThrow('不带值');
    }
  });

  test('错误：未知参数、缺值、--shots 非法', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['--profile'])).toThrow('--profile 需要一个值');
    expect(() => parseArgs(['--profile', '--kernel'])).toThrow('需要一个值');
    expect(() => parseArgs(['--shots', '0'])).toThrow('--shots 需要');
    expect(() => parseArgs(['--shots', '1.5'])).toThrow('--shots 需要');
    expect(() => parseArgs(['--shots', '-3'])).toThrow();
  });
});

describe('main：不起引擎的路径', () => {
  test('--help → 0', async () => {
    const r = await capture(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('用法：bun run det --kernel');
  });

  test('--matches / --rollback → 打印"尚未实现（计划 10-27 / 11-10）"，退出码 2', async () => {
    for (const argv of [['--matches', '1000'], ['--rollback'], ['--kernel', '--rollback']]) {
      const r = await capture(argv);
      expect(r.code).toBe(2);
      expect(r.err).toContain('尚未实现（计划 10-27 / 11-10）');
    }
  });

  test('缺 --kernel / 参数错误 → 2', async () => {
    expect((await capture([])).code).toBe(2);
    expect((await capture(['--kernel', '--bogus'])).err).toContain('未知参数 --bogus');
  });

  test('档不存在 / 引擎清单坏 → 2', async () => {
    const d = tmp('cli');
    const r = await capture(['--kernel', '--profile', 'nope']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('没有档 "nope"');
    writeFileSync(join(d, 'e.json'), JSON.stringify({ profiles: { p: [{ name: 'x', kind: 'node', cmd: ['/x'], typo: 1 }] } }));
    const r2 = await capture(['--kernel', '--profile', 'p', '--engines', join(d, 'e.json')]);
    expect(r2.code).toBe(2);
    expect(r2.err).toContain('未知字段 "typo"');
  });

  test('--sim 指向不存在的文件 → 2；未知夹具、--fixture 与 --sim 同用 → 2', async () => {
    const r = await capture(['--kernel', '--profile', 'linux', '--sim', '/nonexistent/sim.js']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('找不到 /nonexistent/sim.js');
    expect((await capture(['--kernel', '--profile', 'linux', '--fixture', 'cos'])).err).toContain('未知夹具 cos');
    expect((await capture(['--kernel', '--profile', 'linux', '--fixture', 'sin', '--sim', '/a.js'])).err).toContain(
      '不能同时使用',
    );
  });
});

describe('main：默认 sim 路径的前置检查（注入临时目录，不碰真实 dist）', () => {
  /** 临时"仓库"：src/ 下一个 .ts、dist/ 目录；engines 清单里只有一个不存在的引擎（不起子进程）。 */
  function fixture(): { paths: SimPaths; engines: string; src: string } {
    const d = tmp('pre');
    const src = join(d, 'src');
    mkdirSync(src);
    mkdirSync(join(d, 'dist'));
    writeFileSync(join(src, 'a.ts'), '');
    const engines = join(d, 'engines.json');
    writeFileSync(
      engines,
      JSON.stringify({ profiles: { p: [{ name: 'ghost', kind: 'node', cmd: [join(d, 'no-such-node')] }] } }),
    );
    return {
      paths: { simJs: join(d, 'dist', 'sim.js'), srcDir: src, versionFile: join(d, 'dist', 'sim.version') },
      engines,
      src,
    };
  }
  const argv = (engines: string) => ['--kernel', '--profile', 'p', '--engines', engines];
  const old = new Date(Date.now() - 60_000);
  const now = new Date();

  test('sim.js 不存在 → 2，提示先 bun run sim:build', async () => {
    const f = fixture();
    const r = await capture(argv(f.engines), f.paths);
    expect(r.code).toBe(2);
    expect(r.err).toContain('请先运行 bun run sim:build');
  });

  test('src 下有 .ts 比 sim.js 新 → 2，提示重新构建并列出文件', async () => {
    const f = fixture();
    writeFileSync(f.paths.simJs, 'x');
    utimesSync(f.paths.simJs, old, old);
    utimesSync(join(f.src, 'a.ts'), now, now);
    const r = await capture(argv(f.engines), f.paths);
    expect(r.code).toBe(2);
    expect(r.err).toContain('比源码旧');
    expect(r.err).toContain('请重新运行 bun run sim:build');
    expect(r.err).toContain('a.ts');
  });

  test('sim.version 与 sim.js 字节哈希不符 → 2', async () => {
    const f = fixture();
    writeFileSync(f.paths.simJs, 'x');
    writeFileSync(f.paths.versionFile, '00000000\n');
    utimesSync(join(f.src, 'a.ts'), old, old);
    const r = await capture(argv(f.engines), f.paths);
    expect(r.code).toBe(2);
    expect(r.err).toContain('与 sim.js 的字节哈希');
  });

  test('前置检查通过 → 打印 simVer、照常跑引擎（引擎缺失 → 退出 1，不是 2）', async () => {
    const f = fixture();
    writeFileSync(f.paths.simJs, 'x');
    const ver = hex8(fnv1aBytes(new TextEncoder().encode('x')));
    writeFileSync(f.paths.versionFile, `${ver}\n`);
    utimesSync(join(f.src, 'a.ts'), old, old);
    const r = await capture(argv(f.engines), f.paths);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`simVer=${ver}`);
    expect(r.out).toContain('ghost：可执行文件不存在');
    expect(r.out).toContain('结论：失败');
    expect(r.out).toMatch(/^DET - -$/m);
  });
});

describe('staleSources：源码比 sim.js 新', () => {
  test('只报告比 sim.js 新的 .ts（含子目录），其他扩展名忽略', () => {
    const d = tmp('stale');
    const src = join(d, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    const sim = join(d, 'sim.js');
    writeFileSync(sim, '');
    for (const f of ['a.ts', 'b.ts', 'sub/c.ts', 'notes.md']) writeFileSync(join(src, f), '');
    const old = new Date(Date.now() - 60_000);
    const mid = new Date(Date.now() - 30_000);
    const now = new Date();
    utimesSync(sim, mid, mid);
    utimesSync(join(src, 'a.ts'), old, old);
    utimesSync(join(src, 'b.ts'), now, now);
    utimesSync(join(src, 'sub/c.ts'), now, now);
    utimesSync(join(src, 'notes.md'), now, now);
    const stale = staleSources(sim, src);
    expect(stale.map((p) => p.split('/').slice(-2).join('/'))).toEqual(['src/b.ts', 'sub/c.ts']);
    utimesSync(sim, now, now);
    utimesSync(join(src, 'b.ts'), old, old);
    utimesSync(join(src, 'sub/c.ts'), old, old);
    expect(staleSources(sim, src)).toEqual([]);
  });
});
