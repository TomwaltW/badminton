/**
 * 引擎清单校验与单引擎运行的单元测试：
 * - engines.json 结构校验、随仓库的两档清单；
 * - 相对路径、~/ 展开、可执行文件缺失 / 不可执行 → 判失败；
 * - arch / 版本前缀 / JIT 状态 / kind 不符 → 判失败；
 * - runEngine 对退出码非 0、没有 @@DET@@ 行、超时、期望不符的处理（用 /bin/sh 写的假引擎）；
 *   失败诊断（首条错误行、stderr / stdout 末尾）、两条路径同哈希判失败、子进程跑在空临时目录里；
 * - jsc 版本读取（假 plutil）、命令行拼接、子进程环境。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ConfigError,
  checkExpectations,
  defaultProfile,
  expandHome,
  loadEnginesConfig,
  parseEnginesConfig,
  resolveCommand,
  selectProfile,
  type EngineInfo,
  type EngineSpec,
} from '../config';
import {
  BOOT_CJS,
  DIAG_TAIL_LINES,
  DRIVER_JS,
  SQRT_CHECK_MIN_SHOTS,
  buildEngineArgv,
  checkPathsDiffer,
  engineBinary,
  engineEnv,
  engineInfoFrom,
  firstErrorLine,
  parseDriverOutput,
  readJscVersion,
  runEngine,
  type DriverOutput,
} from '../runner';
import { DEFAULT_ENGINES } from '../det';

const SH = '/bin/sh';
const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `det-${prefix}-`));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 写一个可执行的 sh 脚本。 */
function script(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!${SH}\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function spec(over: Partial<EngineSpec> = {}): EngineSpec {
  return { name: 'e', kind: 'node', cmd: ['/bin/sh'], env: {}, expect: {}, ...over };
}

function info(over: Partial<EngineInfo> = {}): EngineInfo {
  return { arch: 'x64', version: 'v22.1.0', webkit: null, jit: null, hasProcess: true, isBun: false, ...over };
}

/** 一份形状正确的 driver 输出。 */
function driverOutput(over: Partial<DriverOutput> = {}): DriverOutput {
  const p = { hash: 1, steps: 10, substeps: 20, shots: 1, corpusVersion: 1, ms: 1, checkpoints: [1, 0, 10, 1] };
  return {
    v: 1,
    apiVersion: 0,
    corpusVersion: 1,
    shots: 1,
    seed: null,
    engine: { hasProcess: true, arch: 'x64', nodeVersion: 'v22.1.0', bunVersion: null, webkitVersion: null, cwd: null },
    jit: null,
    dfgCompiles: null,
    timer: 'performance.now',
    cp: { stride: 4, tick: 0, shotEnd: 1 },
    paths: { dsqrt: p, mathSqrt: { ...p, hash: 2 } },
    ...over,
  };
}

describe('engines.json 结构校验', () => {
  const ok = { profiles: { p: [{ name: 'a', kind: 'node', cmd: ['/bin/sh'] }] } };

  test('最小合法清单', () => {
    const cfg = parseEnginesConfig(ok, 'x.json');
    expect(selectProfile(cfg, 'p')).toEqual([{ name: 'a', kind: 'node', cmd: ['/bin/sh'], env: {}, expect: {} }]);
  });

  test('档不存在 → ConfigError，列出现有档', () => {
    expect(() => selectProfile(parseEnginesConfig(ok, 'x.json'), 'q')).toThrow('没有档 "q"（现有：p）');
  });

  const bad: [string, unknown, string][] = [
    ['顶层不是对象', [], '顶层必须是对象'],
    ['缺 profiles', {}, '缺少 profiles'],
    ['顶层未知字段', { ...ok, extra: 1 }, '顶层未知字段 "extra"'],
    ['档为空', { profiles: { p: [] } }, '必须是非空数组'],
    ['未知字段（拼错 expect）', { profiles: { p: [{ name: 'a', kind: 'node', cmd: ['/x'], expected: {} }] } }, '未知字段 "expected"'],
    ['kind 不对', { profiles: { p: [{ name: 'a', kind: 'deno', cmd: ['/x'] }] } }, 'kind 必须是 node | bun | jsc'],
    ['cmd 为空', { profiles: { p: [{ name: 'a', kind: 'node', cmd: [] }] } }, 'cmd 必须是'],
    ['cmd 是字符串', { profiles: { p: [{ name: 'a', kind: 'node', cmd: '/x' }] } }, 'cmd 必须是'],
    ['name 非法', { profiles: { p: [{ name: 'a b', kind: 'node', cmd: ['/x'] }] } }, 'name 必须是'],
    [
      '重名',
      { profiles: { p: [{ name: 'a', kind: 'node', cmd: ['/x'] }, { name: 'a', kind: 'bun', cmd: ['/y'] }] } },
      '引擎名 a 重复',
    ],
    ['env 值不是字符串', { profiles: { p: [{ name: 'a', kind: 'bun', cmd: ['/x'], env: { X: 0 } }] } }, 'env.X 必须是字符串'],
    ['expect.jit 不是布尔', { profiles: { p: [{ name: 'a', kind: 'bun', cmd: ['/x'], expect: { jit: 'on' } }] } }, 'expect.jit'],
    ['expect 未知字段', { profiles: { p: [{ name: 'a', kind: 'bun', cmd: ['/x'], expect: { os: 'mac' } }] } }, 'expect 里有未知字段 "os"'],
    ['jsc 设 arch', { profiles: { p: [{ name: 'a', kind: 'jsc', cmd: ['/x'], expect: { arch: 'x64' } }] } }, '不能设 expect.arch'],
  ];
  for (const [title, raw, msg] of bad) {
    test(`${title} → ConfigError`, () => {
      expect(() => parseEnginesConfig(raw, 'x.json')).toThrow(ConfigError);
      expect(() => parseEnginesConfig(raw, 'x.json')).toThrow(msg);
    });
  }

  test('文件读不到 / 不是 JSON → ConfigError', () => {
    const d = tmp('cfg');
    expect(() => loadEnginesConfig(join(d, 'none.json'))).toThrow('读不到引擎清单');
    writeFileSync(join(d, 'bad.json'), '{ nope');
    expect(() => loadEnginesConfig(join(d, 'bad.json'))).toThrow('不是合法 JSON');
  });

  test('$comment 字段被忽略', () => {
    const raw = {
      $comment: ['说明'],
      profiles: { $comment: 'x', p: [{ $comment: 'y', name: 'a', kind: 'jsc', cmd: ['/x'], expect: { $comment: 'z', version: '' } }] },
    };
    expect(selectProfile(parseEnginesConfig(raw, 'x.json'), 'p')[0]!.expect).toEqual({ version: '' });
  });

  test('defaultProfile：darwin → mac，linux → linux，其他 → null', () => {
    expect(defaultProfile('darwin')).toBe('mac');
    expect(defaultProfile('linux')).toBe('linux');
    expect(defaultProfile('win32')).toBeNull();
  });
});

describe('随仓库的 engines.json', () => {
  const cfg = loadEnginesConfig(DEFAULT_ENGINES);

  test('linux 档：node、bun、bun-nojit，全部绝对路径', () => {
    const l = selectProfile(cfg, 'linux');
    expect(l.map((e) => e.name)).toEqual(['node', 'bun', 'bun-nojit']);
    expect(l.map((e) => e.kind)).toEqual(['node', 'bun', 'bun']);
    for (const e of l) expect(e.cmd[0]!.startsWith('/')).toBe(true);
    expect(l[0]!.expect).toEqual({ arch: 'x64', version: 'v22.' });
    expect(l[1]!.expect).toEqual({ arch: 'x64', version: '1.4.', jit: true });
    expect(l[2]!.env).toEqual({ BUN_JSC_useJIT: '0' });
    expect(l[2]!.expect).toEqual({ arch: 'x64', version: '1.4.', jit: false });
    expect(l[2]!.cmd).toEqual(l[1]!.cmd);
  });

  test('mac 档：node-arm64、node-x64（arch -x86_64）、bun（~/）、jsc-nojit（--useJIT=false，版本留空）', () => {
    const m = selectProfile(cfg, 'mac');
    expect(m.map((e) => e.name)).toEqual(['node-arm64', 'node-x64', 'bun', 'jsc-nojit']);
    expect(m[1]!.cmd).toEqual(['/usr/bin/arch', '-x86_64', '/usr/local/bin/node']);
    expect(m[1]!.expect.arch).toBe('x64');
    expect(m[2]!.cmd).toEqual(['~/.bun/bin/bun']);
    expect(m[3]!.kind).toBe('jsc');
    expect(m[3]!.cmd[1]).toBe('--useJIT=false');
    expect(m[3]!.expect).toEqual({ version: '', jit: false });
    for (const e of m) {
      expect(e.cmd[0]!.startsWith('/') || e.cmd[0]!.startsWith('~/')).toBe(true);
      // 展开后全部是绝对路径（存在与否另说：这台机器上大多不存在）
      const r = resolveCommand(e, '/Users/someone');
      expect(r.errors.filter((x) => x.startsWith('不是绝对路径'))).toEqual([]);
    }
  });
});

describe('路径：绝对路径、~/ 展开、缺失与不可执行', () => {
  test('expandHome 只展开开头的 ~/', () => {
    expect(expandHome('~/.bun/bin/bun', '/home/u')).toBe('/home/u/.bun/bin/bun');
    expect(expandHome('~', '/home/u')).toBe('~');
    expect(expandHome('~other/bin/x', '/home/u')).toBe('~other/bin/x');
    expect(expandHome('/usr/bin/x', '/home/u')).toBe('/usr/bin/x');
    expect(expandHome('a/~/b', '/home/u')).toBe('a/~/b');
  });

  test('相对路径 → 失败（cmd[0] 与后面的路径参数都检查）', () => {
    expect(resolveCommand(spec({ cmd: ['node'] }), '/h').errors[0]).toContain('不是绝对路径：node');
    expect(resolveCommand(spec({ cmd: ['./bin/node'] }), '/h').errors[0]).toContain('不是绝对路径');
    const r = resolveCommand(spec({ cmd: ['/bin/sh', '-x86_64', 'node'] }), '/h');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('不是绝对路径：node');
  });

  test('以 - 开头的参数不当路径检查', () => {
    expect(resolveCommand(spec({ cmd: ['/bin/sh', '--useJIT=false', '-x86_64'] }), '/h').errors).toEqual([]);
  });

  test('~/ 展开为注入的主目录，展开后存在且可执行 → 通过', () => {
    const home = tmp('home');
    mkdirSync(join(home, '.bun/bin'), { recursive: true });
    script(join(home, '.bun/bin'), 'bun', 'exit 0');
    const r = resolveCommand(spec({ cmd: ['~/.bun/bin/bun'] }), home);
    expect(r.errors).toEqual([]);
    expect(r.cmd).toEqual([join(home, '.bun/bin/bun')]);
  });

  test('~/ 展开后不存在 → 失败，并显示展开结果', () => {
    const home = tmp('home2');
    const r = resolveCommand(spec({ cmd: ['~/.bun/bin/bun'] }), home);
    expect(r.errors[0]).toBe(`可执行文件不存在：~/.bun/bin/bun（展开为 ${join(home, '.bun/bin/bun')}）`);
  });

  test('主目录本身是相对路径时，~/ 展开后仍不是绝对路径 → 失败', () => {
    expect(resolveCommand(spec({ cmd: ['~/bin/x'] }), 'relhome').errors[0]).toContain('不是绝对路径');
  });

  test('不存在 / 是目录 / 没有执行权限 → 失败', () => {
    const d = tmp('exe');
    expect(resolveCommand(spec({ cmd: [join(d, 'nope')] }), '/h').errors[0]).toContain('可执行文件不存在');
    expect(resolveCommand(spec({ cmd: [d] }), '/h').errors[0]).toContain('不是文件');
    const p = join(d, 'plain');
    writeFileSync(p, 'x');
    chmodSync(p, 0o644);
    expect(resolveCommand(spec({ cmd: [p] }), '/h').errors[0]).toContain('没有执行权限');
    // 包装器后面的路径参数缺失也算
    const r = resolveCommand(spec({ cmd: ['/bin/sh', '-x86_64', join(d, 'node')] }), '/h');
    expect(r.errors[0]).toContain(`可执行文件不存在：${join(d, 'node')}`);
  });

  test('engineBinary 取最后一个路径元素（跳过 arch 之类的包装器与选项）', () => {
    expect(engineBinary(['/usr/bin/arch', '-x86_64', '/usr/local/bin/node'])).toBe('/usr/local/bin/node');
    expect(engineBinary(['/a/jsc', '--useJIT=false'])).toBe('/a/jsc');
  });
});

describe('期望：arch / 版本前缀 / JIT / kind', () => {
  test('全部符合 → 无错误', () => {
    const s = spec({ expect: { arch: 'x64', version: 'v22.' } });
    expect(checkExpectations(s, info())).toEqual([]);
  });

  test('arch 不符', () => {
    const e = checkExpectations(spec({ expect: { arch: 'arm64' } }), info());
    expect(e).toEqual(['arch 不符：期望 arm64，实际 x64']);
    expect(checkExpectations(spec({ expect: { arch: 'x64' } }), info({ arch: null }))[0]).toContain('实际 未知');
  });

  test('版本前缀不符 / 读不到版本', () => {
    expect(checkExpectations(spec({ expect: { version: 'v24.' } }), info())).toEqual([
      '版本不符：期望前缀 v24.，实际 v22.1.0',
    ]);
    const j = spec({ kind: 'jsc', expect: { version: '20621.' } });
    expect(checkExpectations(j, info({ hasProcess: false, arch: null, version: null }))).toEqual([
      '版本不符：期望前缀 20621.，实际 未知',
    ]);
  });

  test('版本期望为空串 = 只打印不判定', () => {
    const j = spec({ kind: 'jsc', expect: { version: '' } });
    expect(checkExpectations(j, info({ hasProcess: false, arch: null, version: null }))).toEqual([]);
  });

  test('JIT 不符（两个方向）与探针缺失', () => {
    const b = (jit: boolean) => spec({ kind: 'bun', expect: { jit } });
    const bi = (jit: boolean | null) => info({ isBun: true, version: '1.4.2', jit });
    expect(checkExpectations(b(true), bi(false))).toEqual(['JIT 状态不符：期望开启，实际关闭']);
    expect(checkExpectations(b(false), bi(true))).toEqual(['JIT 状态不符：期望关闭，实际开启']);
    expect(checkExpectations(b(false), bi(null))[0]).toContain('没有 JIT 探针');
    expect(checkExpectations(b(false), bi(false))).toEqual([]);
  });

  test('kind 与实际引擎不符', () => {
    expect(checkExpectations(spec({ kind: 'bun' }), info())).toContain('kind 为 bun，但引擎里没有 process.versions.bun');
    expect(checkExpectations(spec({ kind: 'node' }), info({ isBun: true }))).toContain('kind 为 node，但引擎其实是 bun');
    expect(checkExpectations(spec({ kind: 'jsc' }), info())[0]).toContain('kind 为 jsc，但引擎里有 process');
  });

  test('engineInfoFrom 按 kind 取版本', () => {
    const o = driverOutput({
      engine: { hasProcess: true, arch: 'x64', nodeVersion: 'v24.3.0', bunVersion: '1.4.2', webkitVersion: 'abcdef0123456789', cwd: '/t' },
    });
    expect(engineInfoFrom(spec({ kind: 'bun' }), o, null).version).toBe('1.4.2');
    expect(engineInfoFrom(spec({ kind: 'bun' }), o, null).webkit).toBe('abcdef0123456789');
    expect(engineInfoFrom(spec({ kind: 'node' }), o, null).version).toBe('v24.3.0');
    expect(engineInfoFrom(spec({ kind: 'jsc' }), o, '20621.1').version).toBe('20621.1');
    expect(engineInfoFrom(spec({ kind: 'bun' }), o, null).isBun).toBe(true);
  });
});

describe('命令行与环境', () => {
  test('node / bun：cmd + boot.cjs + sim + driver + 参数；jsc：cmd + sim + driver + -- + 参数', () => {
    expect(buildEngineArgv(spec({ kind: 'bun' }), ['/b'], '/s.js', ['--shots', '3'])).toEqual([
      '/b',
      BOOT_CJS,
      '/s.js',
      DRIVER_JS,
      '--shots',
      '3',
    ]);
    expect(buildEngineArgv(spec({ kind: 'jsc' }), ['/j', '--useJIT=false'], '/s.js', ['--shots', '3'])).toEqual([
      '/j',
      '--useJIT=false',
      '/s.js',
      DRIVER_JS,
      '--',
      '--shots',
      '3',
    ]);
  });

  test('子进程环境去掉 BUN_JSC_* / JSC_* / NODE_OPTIONS，再叠上清单里的 env', () => {
    const env = engineEnv(spec({ env: { BUN_JSC_useJIT: '0' } }), {
      PATH: '/bin',
      BUN_JSC_useJIT: '1',
      BUN_JSC_foo: 'x',
      JSC_useJIT: 'false',
      NODE_OPTIONS: '--jitless',
      HOME: '/h',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', BUN_JSC_useJIT: '0' });
  });
});

describe('解析 @@DET@@ 行', () => {
  test('取最后一行 @@DET@@，忽略其他输出', () => {
    const o = driverOutput();
    const text = `噪声\n@@DET@@ {"v":0}\n@@DET@@ ${JSON.stringify(o)}\n尾巴\n`;
    expect(parseDriverOutput(text).paths.dsqrt.hash).toBe(1);
  });

  test('没有 @@DET@@ 行 / JSON 坏 / 形状不对 → 抛错', () => {
    expect(() => parseDriverOutput('hello\n')).toThrow('没有 @@DET@@ 行');
    expect(() => parseDriverOutput('@@DET@@ {bad')).toThrow('不是合法 JSON');
    expect(() => parseDriverOutput('@@DET@@ {"v":2}')).toThrow('版本不是 1');
    const noPath = { ...driverOutput(), paths: { dsqrt: driverOutput().paths.dsqrt } };
    expect(() => parseDriverOutput(`@@DET@@ ${JSON.stringify(noPath)}`)).toThrow('paths.mathSqrt');
  });

  test('检查点数组不是整条记录 → 抛错（记为该引擎失败，而不是互比时崩溃）', () => {
    const o = driverOutput();
    const bad = { ...o, paths: { ...o.paths, mathSqrt: { ...o.paths.mathSqrt, checkpoints: [1, 0, 10] } } };
    expect(() => parseDriverOutput(`@@DET@@ ${JSON.stringify(bad)}`)).toThrow('paths.mathSqrt.checkpoints 长度 3 不是步长 4');
  });

  test('engine 缺字段 → 规范成 null / false，期望检查照常判失败而不崩溃', () => {
    const o = { ...driverOutput(), engine: { arch: 7 } };
    const p = parseDriverOutput(`@@DET@@ ${JSON.stringify(o)}`);
    expect(p.engine).toEqual({ hasProcess: false, arch: null, nodeVersion: null, bunVersion: null, webkitVersion: null, cwd: null });
    const s = spec({ expect: { arch: 'x64', version: 'v22.' } });
    expect(checkExpectations(s, engineInfoFrom(s, p, null))).toEqual([
      'kind 为 node，但引擎里没有 process',
      'arch 不符：期望 x64，实际 未知',
      '版本不符：期望前缀 v22.，实际 未知',
    ]);
  });

  test('缺检查点常量时退回默认布局；jit 非布尔视为未知', () => {
    const o = { ...driverOutput(), cp: undefined, jit: 'x' };
    const p = parseDriverOutput(`@@DET@@ ${JSON.stringify(o)}`);
    expect(p.cp).toEqual({ stride: 4, tick: 0, shotEnd: 1 });
    expect(p.jit).toBeNull();
  });
});

describe('runEngine（/bin/sh 写的假引擎）', () => {
  const dir = tmp('fake');
  const opts = { simPath: '/nonexistent/sim.js', driverArgs: [], home: '/h' };

  test('相对路径 → 不启动、记为失败', () => {
    const r = runEngine(spec({ cmd: ['node'] }), opts);
    expect(r.errors[0]).toContain('不是绝对路径');
    expect(r.output).toBeNull();
    expect(r.wallMs).toBe(0);
  });

  test('可执行文件不存在 → 失败', () => {
    const r = runEngine(spec({ cmd: [join(dir, 'missing-node')] }), opts);
    expect(r.errors[0]).toContain('可执行文件不存在');
  });

  test('退出码非 0 → 失败，保留 stderr 末尾', () => {
    const p = script(dir, 'exit3', 'echo 坏了 >&2; exit 3');
    const r = runEngine(spec({ cmd: [p] }), opts);
    expect(r.errors).toEqual(['退出码 3']);
    expect(r.stderrTail).toContain('坏了');
  });

  test('没有 @@DET@@ 行 → 失败', () => {
    const p = script(dir, 'silent', 'echo hello');
    expect(runEngine(spec({ cmd: [p] }), opts).errors).toEqual(['输出里没有 @@DET@@ 行']);
  });

  test('node 形状的 stderr：错误行后有 10 多行栈，失败原因仍带上错误行；stderr 末尾保留 30 行', () => {
    const stack = Array.from({ length: 25 }, (_, i) => `echo "    at f${i} (/x/boot.cjs:${i}:1)" >&2`).join('\n');
    const p = script(
      dir,
      'node-like',
      [
        'echo "/tmp/boom-sim.js:1" >&2',
        `echo 'throw new Error("a: b");' >&2`,
        'echo "^" >&2',
        'echo "" >&2',
        'echo "Error: sim 加载失败：boom" >&2',
        stack,
        'echo "" >&2',
        'echo "Node.js v22.22.0" >&2',
        'exit 1',
      ].join('\n'),
    );
    const r = runEngine(spec({ cmd: [p] }), opts);
    // 源码行 throw new Error("a: b") 不算错误行
    expect(r.errors).toEqual(['退出码 1：Error: sim 加载失败：boom']);
    const tailLines = r.stderrTail.split('\n');
    expect(tailLines).toHaveLength(DIAG_TAIL_LINES);
    expect(tailLines.at(-1)).toBe('Node.js v22.22.0');
    expect(r.stderrTail).toContain('at f0 ');
    expect(r.stdoutTail).toBe('');
  });

  test('jsc 形状：未捕获异常写在 stdout、stderr 为空 → 失败原因带上异常行，stdout 末尾去掉 @@DET@@ 行', () => {
    const p = script(
      dir,
      'jsc-like',
      [
        'echo "Exception: Error: sim 加载失败：boom"',
        'echo "global code@/tmp/boom-sim.js:1:16"',
        'echo \'@@DET@@ {"v":1}\'',
        'echo "Exception: Error: driver.js：全局没有 BadmintonSim.kernel.run"',
        'exit 3',
      ].join('\n'),
    );
    const r = runEngine(spec({ kind: 'jsc', cmd: [p] }), opts);
    expect(r.errors).toEqual(['退出码 3：Exception: Error: sim 加载失败：boom']);
    expect(r.stderrTail).toBe('');
    expect(r.stdoutTail).toBe(
      ['Exception: Error: sim 加载失败：boom', 'global code@/tmp/boom-sim.js:1:16', 'Exception: Error: driver.js：全局没有 BadmintonSim.kernel.run'].join('\n'),
    );
  });

  test('子进程的工作目录是新建的空临时目录（不是调用方的工作目录），结束后删除', () => {
    const p = script(dir, 'pwd', 'pwd >&2; ls -A >&2; echo 结束 >&2; exit 5');
    const r = runEngine(spec({ cmd: [p] }), opts);
    const [cwd, ...rest] = r.stderrTail.split('\n');
    expect(r.errors).toEqual(['退出码 5']);
    expect(rest).toEqual(['结束']);
    expect(cwd).not.toBe(process.cwd());
    expect(cwd).not.toBe(resolve(import.meta.dir, '..', '..', '..'));
    expect(basename(cwd!)).toStartWith('det-cwd-');
    expect(existsSync(cwd!)).toBe(false);
  });

  test('sim 路径按调用方的工作目录解析成绝对路径再传给引擎', () => {
    const p = script(dir, 'args', 'echo "$@" >&2; exit 4');
    const r = runEngine(spec({ cmd: [p] }), { ...opts, simPath: 'rel/sim.js' });
    expect(r.stderrTail).toBe(`${BOOT_CJS} ${resolve('rel/sim.js')} ${DRIVER_JS}`);
  });

  test('两条路径哈希相同（拍数够多）→ 失败：注入的 Math.sqrt 没有生效；输出仍保留供互比', () => {
    const o = driverOutput({ shots: 2000 });
    const same = { ...o, paths: { dsqrt: o.paths.dsqrt, mathSqrt: { ...o.paths.dsqrt } } };
    const out = join(dir, 'same.txt');
    writeFileSync(out, `@@DET@@ ${JSON.stringify(same)}\n`);
    const p = script(dir, 'same', `cat ${JSON.stringify(out)}`);
    const r = runEngine(spec({ cmd: [p] }), opts);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('dsqrt 路径与 Math.sqrt 路径哈希相同（00000001）');
    expect(r.errors[0]).toContain('注入的 Math.sqrt 没有生效');
    expect(r.output).not.toBeNull();
  });

  test('超时 → 失败', () => {
    const p = script(dir, 'slow', 'exec sleep 5');
    const r = runEngine(spec({ cmd: [p] }), { ...opts, timeoutMs: 200 });
    expect(r.errors[0]).toContain('超时');
  });

  test('输出正常但 arch / 版本不符 → 失败，输出仍保留供互比', () => {
    const out = join(dir, 'out.txt');
    writeFileSync(out, `@@DET@@ ${JSON.stringify(driverOutput())}\n`);
    const p = script(dir, 'canned', `cat ${JSON.stringify(out)}`);
    const okRun = runEngine(spec({ cmd: [p], expect: { arch: 'x64', version: 'v22.' } }), opts);
    expect(okRun.errors).toEqual([]);
    expect(okRun.info!.version).toBe('v22.1.0');
    const bad = runEngine(spec({ cmd: [p], expect: { arch: 'arm64', version: 'v24.' } }), opts);
    expect(bad.errors).toEqual(['arch 不符：期望 arm64，实际 x64', '版本不符：期望前缀 v24.，实际 v22.1.0']);
    expect(bad.output).not.toBeNull();
  });

  test('env 传给引擎', () => {
    const p = script(dir, 'envcheck', '[ "$DET_TEST_X" = "42" ] || exit 7; [ -z "$BUN_JSC_useJIT" ] || exit 8; echo none');
    const prev = process.env.BUN_JSC_useJIT;
    process.env.BUN_JSC_useJIT = '1';
    try {
      expect(runEngine(spec({ cmd: [p], env: { DET_TEST_X: '42' } }), opts).errors).toEqual(['输出里没有 @@DET@@ 行']);
      expect(runEngine(spec({ cmd: [p] }), opts).errors).toEqual(['退出码 7']);
    } finally {
      if (prev === undefined) delete process.env.BUN_JSC_useJIT;
      else process.env.BUN_JSC_useJIT = prev;
    }
  });
});

describe('jsc 版本：../Resources/Info.plist 的 CFBundleVersion', () => {
  test('读得到 → 返回 plutil 的输出（用假 plutil 验证参数）', () => {
    const root = tmp('jscfw');
    mkdirSync(join(root, 'Helpers'));
    mkdirSync(join(root, 'Resources'));
    const jsc = script(join(root, 'Helpers'), 'jsc', 'exit 0');
    const plist = join(root, 'Resources', 'Info.plist');
    writeFileSync(plist, '<plist/>');
    const fake = script(
      root,
      'plutil',
      `[ "$1 $2 $3 $4 $5" = "-extract CFBundleVersion raw -o -" ] || exit 9\n[ "$6" = ${JSON.stringify(resolve(plist))} ] || exit 10\necho 20621.1.15.11.4`,
    );
    expect(readJscVersion(jsc, fake)).toBe('20621.1.15.11.4');
  });

  test('没有 Info.plist / 没有 plutil / plutil 失败 → null（打印"未知"）', () => {
    const root = tmp('jscfw2');
    mkdirSync(join(root, 'Helpers'));
    mkdirSync(join(root, 'Resources'));
    const jsc = script(join(root, 'Helpers'), 'jsc', 'exit 0');
    expect(readJscVersion(jsc, '/bin/true')).toBeNull();
    writeFileSync(join(root, 'Resources', 'Info.plist'), '<plist/>');
    expect(readJscVersion(jsc, join(root, 'no-plutil'))).toBeNull();
    expect(readJscVersion(jsc, script(root, 'failing', 'exit 1'))).toBeNull();
    expect(readJscVersion(jsc, script(root, 'empty', 'exit 0'))).toBeNull();
  });
});

describe('失败诊断：错误行', () => {
  test('匹配 node / bun / jsc 的错误行，不匹配源码行、栈帧与 @@DET@@ 行', () => {
    expect(firstErrorLine('x\nError: a\n')).toBe('Error: a');
    expect(firstErrorLine('TypeError [ERR_INVALID_ARG_TYPE]: b')).toBe('TypeError [ERR_INVALID_ARG_TYPE]: b');
    expect(firstErrorLine('1 | throw x\n    error: c\n')).toBe('error: c');
    expect(firstErrorLine('Exception: Error: d')).toBe('Exception: Error: d');
    expect(firstErrorLine('Uncaught RangeError: e')).toBe('Uncaught RangeError: e');
    expect(firstErrorLine('throw new Error("a: b");\n    at f (a.js:1:2)\n@@DET@@ {"Error: ":1}\nerrors: 3 个')).toBeNull();
    // 先找第一段（stderr），没有再找第二段（stdout）
    expect(firstErrorLine('', 'Exception: Error: s')).toBe('Exception: Error: s');
    expect(firstErrorLine('Error: 先', 'Error: 后')).toBe('Error: 先');
    expect(firstErrorLine(`Error: ${'长'.repeat(600)}`)!.length).toBe(501);
  });
});

describe('两条路径必须不同', () => {
  test(`拍数 ≥ ${SQRT_CHECK_MIN_SHOTS} 且哈希相同 → 问题；拍数太少或哈希不同 → 无问题`, () => {
    const o = driverOutput({ shots: SQRT_CHECK_MIN_SHOTS });
    const same = { ...o, paths: { dsqrt: o.paths.dsqrt, mathSqrt: { ...o.paths.dsqrt } } };
    expect(checkPathsDiffer(same)[0]).toContain('注入的 Math.sqrt 没有生效');
    expect(checkPathsDiffer({ ...same, shots: SQRT_CHECK_MIN_SHOTS - 1 })).toEqual([]);
    expect(checkPathsDiffer(o)).toEqual([]);
  });
});
