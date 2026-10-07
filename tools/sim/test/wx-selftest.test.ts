/**
 * tools/wx-selftest 与 bun run wx-selftest:sync 的测试（计划 6 章"真机内核自测"、派单 A 第 8 项）。
 *
 * 云端没有微信开发者工具与真机，这里在 node:vm 的新上下文里模拟微信小游戏运行时：
 * - GameGlobal 指向上下文的全局对象（另测"GameGlobal 是独立对象"与"没有 GameGlobal"两种情形）；
 * - wx.createCanvas() 返回记录型假画布，getContext('2d') 记录 fillRect / fillText / setTransform 等调用；
 * - wx.getWindowInfo / getDeviceInfo / getAppBaseInfo（或旧的 getSystemInfoSync）返回屏幕尺寸与设备信息；
 * - require('./sim.js') 按微信的方式（每个文件包一层函数，顶层变量只在本文件有效）在同一上下文里执行该文件；
 * - setTimeout 只入队，由测试同步冲刷（先断言"运行中…"已上屏、内核尚未运行）；console 全部捕获。
 * 断言 console 与屏幕都输出了 "DET <hash> <steps> <steps/s>"，且 hash、steps 等于在主进程里加载同一份 sim.js
 * 按 det 的方式跑 kernel.run() 的结果；Math.sqrt 参考行同理。
 *
 * sim.js 用 buildSim 构建到临时目录，再用 syncWxSelftest 复制到临时的 wx 工程目录（连同 game.js），
 * 不依赖预先构建好的 packages/sim/dist，也不写仓库里的 tools/wx-selftest/sim.js。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createContext, runInContext, type Context } from 'node:vm';
import { buildSim, type BuildResult } from '../build';
import { fnv1aBytes, hex8 } from '../fnv';
import { SyncError, WX_SELFTEST_DIR, newerSources, parseSyncArgs, syncWxSelftest } from '../sync-wx-selftest';
import { runKernel } from '../../../packages/sim/src/kernel';
import type { BadmintonSimApi } from '../../../packages/sim/src/api';

const SYNC_TS = resolve(import.meta.dir, '..', 'sync-wx-selftest.ts');
const GAME_JS = join(WX_SELFTEST_DIR, 'game.js');
const BUILD_TIMEOUT = 30_000;
const DET_RE = /^DET ([0-9a-f]{8}) (\d+) (\d+)$/;
const BG = '#0f1419';

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `wx-selftest-${prefix}-`));
  tmpDirs.push(d);
  return d;
}

let build: BuildResult;
let simCode = '';
/** 已同步好的临时 wx 工程：game.js + sim.js。 */
let wxDir = '';
/** 主进程里加载同一份 sim.js 得到的 API 与两条路径的结果。 */
let mainSim: BadmintonSimApi;
let refDsqrt: { hash: number; steps: number };
let refSqrt: { hash: number; steps: number };

beforeAll(async () => {
  build = await buildSim({ outDir: tmp('dist'), dts: false });
  simCode = readFileSync(build.jsPath, 'utf8');
  wxDir = tmp('wx');
  copyFileSync(GAME_JS, join(wxDir, 'game.js'));
  syncWxSelftest({ srcJs: build.jsPath, destDir: wxDir });
  mainSim = loadSimInMain(readFileSync(join(wxDir, 'sim.js'), 'utf8'));
  // 基准按 det 的 driver.js 的调用方式取（拍数 = DEFAULT_SHOTS、记录检查点）；game.js 用 checkpoints: false。
  // 检查点只影响返回值、不影响哈希，所以两者必须相同——DET 行前两项才能与 bun run det 的 DET 行直接比对。
  refDsqrt = mainSim.kernel.run({ shots: mainSim.kernel.DEFAULT_SHOTS, checkpoints: true });
  refSqrt = mainSim.kernel.run({ shots: mainSim.kernel.DEFAULT_SHOTS, checkpoints: true, sqrt: Math.sqrt });
}, BUILD_TIMEOUT);

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 在主进程（本 realm）里执行 sim.js：用函数参数遮住 GameGlobal，不污染测试进程的 globalThis。 */
function loadSimInMain(code: string): BadmintonSimApi {
  const holder: { BadmintonSim?: BadmintonSimApi } = {};
  new Function('GameGlobal', code)(holder);
  if (!holder.BadmintonSim) throw new Error('sim.js 没有把 BadmintonSim 挂到 GameGlobal 上');
  return holder.BadmintonSim;
}

// ---------------------------------------------------------------------------------------------
// 假的微信运行时
// ---------------------------------------------------------------------------------------------

interface DrawCall {
  op: 'fillRect' | 'fillText' | 'setTransform' | 'clearRect';
  text?: string;
  x?: number;
  y?: number;
  args?: number[];
  font?: string;
  fillStyle?: string;
}

function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  if (!m) throw new Error(`字体里没有 px 字号：${font}`);
  return Number(m[1]);
}

/** 假的文字宽度：ASCII 0.6 em（近似等宽字体），其余字符 1 em（近似汉字）。 */
function fakeWidth(text: string, font: string): number {
  const px = fontPx(font);
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) < 0x80 ? 0.6 * px : px;
  return w;
}

class FakeContext2D {
  font = '10px sans-serif';
  fillStyle = '#000000';
  textBaseline = 'alphabetic';
  textAlign = 'start';
  readonly calls: DrawCall[] = [];
  fillRect(x: number, y: number, w: number, h: number): void {
    this.calls.push({ op: 'fillRect', args: [x, y, w, h], fillStyle: this.fillStyle });
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.calls.push({ op: 'clearRect', args: [x, y, w, h] });
  }
  fillText(text: string, x: number, y: number): void {
    this.calls.push({ op: 'fillText', text: String(text), x, y, font: this.font, fillStyle: this.fillStyle });
  }
  measureText(text: string): { width: number } {
    return { width: fakeWidth(String(text), this.font) };
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.calls.push({ op: 'setTransform', args: [a, b, c, d, e, f] });
  }
}

class FakeCanvas {
  readonly ctx = new FakeContext2D();
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(type: string): FakeContext2D {
    if (type !== '2d') throw new Error(`假画布只支持 2d，收到 ${type}`);
    return this.ctx;
  }
}

interface GameOptions {
  /** 工程目录（含 game.js 与可选的 sim.js）。 */
  dir: string;
  width?: number;
  height?: number;
  dpr?: number;
  safeTop?: number;
  /** global：GameGlobal 就是上下文的全局对象（微信的情形）；separate：独立对象；none：不定义。 */
  gameGlobal?: 'global' | 'separate' | 'none';
  /** true：只有旧接口 wx.getSystemInfoSync（没有 getWindowInfo / getDeviceInfo / getAppBaseInfo）。 */
  legacyApis?: boolean;
}

interface GameRuntime {
  context: Context;
  gameGlobal: Record<string, unknown> | undefined;
  canvases: FakeCanvas[];
  logs: string[];
  warns: string[];
  errors: string[];
  timers: Array<() => void>;
  onError: ((res: unknown) => void) | undefined;
  /** 依次执行排队的 setTimeout 回调（回调里新排的也执行），返回执行个数。 */
  flush(): number;
}

function startGame(opts: GameOptions): GameRuntime {
  const width = opts.width ?? 375;
  const height = opts.height ?? 667;
  const dpr = opts.dpr ?? 2;
  const safeTop = opts.safeTop ?? 20;
  const rt: GameRuntime = {
    context: {} as Context,
    gameGlobal: undefined,
    canvases: [],
    logs: [],
    warns: [],
    errors: [],
    timers: [],
    onError: undefined,
    flush() {
      let n = 0;
      while (rt.timers.length > 0) {
        if (++n > 100) throw new Error('setTimeout 回调超过 100 个，疑似死循环');
        rt.timers.shift()!();
      }
      return n;
    },
  };
  const windowInfo = {
    windowWidth: width,
    windowHeight: height,
    screenWidth: width,
    screenHeight: height,
    pixelRatio: dpr,
    statusBarHeight: safeTop,
    safeArea: { top: safeTop, left: 0, right: width, bottom: height, width, height: height - safeTop },
  };
  const deviceInfo = { model: 'iPhone 7<iPhone9,1>', system: 'iOS 15.8', platform: 'ios', brand: 'iPhone', benchmarkLevel: 20 };
  const appBaseInfo = { SDKVersion: '3.5.8', version: '8.0.50' };
  const wx: Record<string, unknown> = {
    createCanvas() {
      const c = new FakeCanvas(width, height);
      rt.canvases.push(c);
      return c;
    },
    getSystemInfoSync() {
      return { ...windowInfo, ...deviceInfo, ...appBaseInfo };
    },
    onError(fn: (res: unknown) => void) {
      rt.onError = fn;
    },
  };
  if (!opts.legacyApis) {
    wx.getWindowInfo = () => ({ ...windowInfo });
    wx.getDeviceInfo = () => ({ ...deviceInfo });
    wx.getAppBaseInfo = () => ({ ...appBaseInfo });
  }
  const fmt = (args: unknown[]): string => args.map((a) => String(a)).join(' ');
  const sandbox = {
    wx,
    console: {
      log: (...a: unknown[]) => rt.logs.push(fmt(a)),
      info: (...a: unknown[]) => rt.logs.push(fmt(a)),
      warn: (...a: unknown[]) => rt.warns.push(fmt(a)),
      error: (...a: unknown[]) => rt.errors.push(fmt(a)),
    },
    setTimeout: (fn: () => void) => {
      rt.timers.push(fn);
      return rt.timers.length;
    },
  };
  const context = createContext(sandbox);
  rt.context = context;
  const mode = opts.gameGlobal ?? 'global';
  if (mode === 'global') runInContext('var GameGlobal = globalThis;', context);
  else if (mode === 'separate') runInContext('var GameGlobal = {};', context);
  if (mode !== 'none') rt.gameGlobal = runInContext('GameGlobal', context) as Record<string, unknown>;

  // 微信的模块方式：每个文件包一层 function (require, module, exports)，顶层变量只在本文件有效
  const cache = new Map<string, unknown>();
  const runModule = (file: string, name: string): unknown => {
    const mod = { exports: {} as unknown };
    const wrapped = runInContext(`(function (require, module, exports) {\n${readFileSync(file, 'utf8')}\n})`, context, {
      filename: name,
    }) as (r: (p: string) => unknown, m: { exports: unknown }, e: unknown) => void;
    wrapped(requireFn, mod, mod.exports);
    return mod.exports;
  };
  const requireFn = (p: string): unknown => {
    if (p !== './sim.js') throw new Error(`module '${p}' is not defined`);
    const file = join(opts.dir, 'sim.js');
    if (!existsSync(file)) throw new Error("module 'sim.js' is not defined");
    if (!cache.has(file)) cache.set(file, runModule(file, 'sim.js'));
    return cache.get(file);
  };
  runModule(join(opts.dir, 'game.js'), 'game.js');
  return rt;
}

/** 最后一帧的 fillText（每帧以整屏背景 fillRect 开始）。 */
function lastFrameTexts(canvas: FakeCanvas): DrawCall[] {
  const calls = canvas.ctx.calls;
  let start = 0;
  for (let i = 0; i < calls.length; i++) if (calls[i]!.op === 'fillRect') start = i;
  return calls.slice(start).filter((c) => c.op === 'fillText');
}

function allTexts(canvas: FakeCanvas): string[] {
  return canvas.ctx.calls.filter((c) => c.op === 'fillText').map((c) => c.text!);
}

/** 相对亮度（0 黑 … 1 白），只认 #rrggbb。 */
function luminance(color: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) throw new Error(`不是 #rrggbb 颜色：${color}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h!, 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function detLines(rt: GameRuntime): string[] {
  return rt.logs.filter((l) => l.startsWith('DET'));
}

/** 共用断言：console 与最后一帧都有 DET 行，哈希与 steps 等于主进程加载同一 sim.js 的结果。 */
function expectDetMatchesMain(rt: GameRuntime): RegExpExecArray {
  const lines = detLines(rt);
  expect(lines).toHaveLength(1);
  const m = DET_RE.exec(lines[0]!);
  if (!m) throw new Error(`DET 行格式不对：${lines[0]}`);
  expect(m[1]).toBe(hex8(refDsqrt.hash));
  expect(Number(m[2])).toBe(refDsqrt.steps);
  expect(Number(m[3])).toBeGreaterThan(0);
  expect(lastFrameTexts(rt.canvases[0]!).map((c) => c.text)).toContain(lines[0]!);
  return m;
}

// ---------------------------------------------------------------------------------------------

describe('wx-selftest:sync', () => {
  test('原样复制 dist/sim.js，返回并校验 simVer', () => {
    const dest = tmp('sync-ok');
    const r = syncWxSelftest({ srcJs: build.jsPath, destDir: dest });
    expect(r.simVer).toBe(build.simVer);
    expect(r.bytes).toBe(build.bytes);
    expect(r.destJs).toBe(join(dest, 'sim.js'));
    expect(r.staleSources).toEqual([]);
    const copied = readFileSync(r.destJs);
    expect(Buffer.compare(copied, readFileSync(build.jsPath))).toBe(0);
    expect(hex8(fnv1aBytes(copied))).toBe(build.simVer);
    expect(readdirSync(dest)).toEqual(['sim.js']);
  });

  test('dist/sim.js 不存在 → SyncError，提示先 bun run sim:build', () => {
    const missing = join(tmp('sync-missing'), 'dist', 'sim.js');
    expect(() => syncWxSelftest({ srcJs: missing, destDir: tmp('sync-missing-dest') })).toThrow(SyncError);
    expect(() => syncWxSelftest({ srcJs: missing, destDir: tmp('sync-missing-dest') })).toThrow('bun run sim:build');
  });

  test('sim.version 与字节不符 → 拒绝，原有目标文件不动、不留临时文件', () => {
    const dist = tmp('sync-tamper');
    copyFileSync(build.jsPath, join(dist, 'sim.js'));
    writeFileSync(join(dist, 'sim.version'), '00000000\n');
    const dest = tmp('sync-tamper-dest');
    writeFileSync(join(dest, 'sim.js'), '// 旧的\n');
    expect(() => syncWxSelftest({ srcJs: join(dist, 'sim.js'), destDir: dest })).toThrow('不符');
    expect(readFileSync(join(dest, 'sim.js'), 'utf8')).toBe('// 旧的\n');
    expect(readdirSync(dest)).toEqual(['sim.js']);
  });

  test('sim.version 缺失或格式不对 → 拒绝；目标目录不存在 → 拒绝', () => {
    const dist = tmp('sync-badver');
    copyFileSync(build.jsPath, join(dist, 'sim.js'));
    const dest = tmp('sync-badver-dest');
    expect(() => syncWxSelftest({ srcJs: join(dist, 'sim.js'), destDir: dest })).toThrow('sim.version');
    writeFileSync(join(dist, 'sim.version'), 'not-a-hash\n');
    expect(() => syncWxSelftest({ srcJs: join(dist, 'sim.js'), destDir: dest })).toThrow('8 位十六进制');
    expect(() => syncWxSelftest({ srcJs: build.jsPath, destDir: join(dest, 'nope') })).toThrow('不存在');
    expect(existsSync(join(dest, 'sim.js'))).toBe(false);
  });

  test('过期检测：只列出比参照时刻新的 .ts（递归）', () => {
    const src = tmp('stale');
    mkdirSync(join(src, 'sub'));
    for (const f of ['a.ts', 'b.js', 'sub/c.ts', 'sub/d.ts']) writeFileSync(join(src, f), '');
    const old = new Date('2026-01-01T00:00:00Z');
    const fresh = new Date('2026-06-01T00:00:00Z');
    for (const f of ['a.ts', 'b.js', 'sub/c.ts']) utimesSync(join(src, f), fresh, fresh);
    utimesSync(join(src, 'sub/d.ts'), old, old);
    const ref = new Date('2026-03-01T00:00:00Z').getTime();
    expect(newerSources(src, ref)).toEqual([join(src, 'a.ts'), join(src, 'sub', 'c.ts')]);
    expect(newerSources(join(src, 'nope'), ref)).toEqual([]);
  });

  test('参数解析', () => {
    expect(parseSyncArgs([])).toEqual({});
    expect(parseSyncArgs(['--src', 'a/sim.js', '--dest', 'b'])).toEqual({ srcJs: 'a/sim.js', destDir: 'b' });
    expect(() => parseSyncArgs(['--src'])).toThrow('需要一个路径参数');
    expect(() => parseSyncArgs(['--dest', '--src', 'x'])).toThrow('需要一个路径参数');
    expect(() => parseSyncArgs(['--force'])).toThrow('未知参数');
  });

  test(
    '命令行：成功退出 0 并打印 simVer；缺 dist 退出 1 并提示 sim:build',
    () => {
      const dest = tmp('sync-cli');
      const ok = spawnSync(process.execPath, [SYNC_TS, '--src', build.jsPath, '--dest', dest], { encoding: 'utf8' });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain(`simVer=${build.simVer}`);
      expect(readFileSync(join(dest, 'sim.js'), 'utf8')).toBe(simCode);

      const missing = join(tmp('sync-cli-missing'), 'sim.js');
      const bad = spawnSync(process.execPath, [SYNC_TS, '--src', missing, '--dest', dest], { encoding: 'utf8' });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('bun run sim:build');

      const unknown = spawnSync(process.execPath, [SYNC_TS, '--what'], { encoding: 'utf8' });
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain('未知参数');
    },
    BUILD_TIMEOUT,
  );
});

describe('game.js 源码约束', () => {
  const code = readFileSync(GAME_JS, 'utf8');

  test('只用 ES2017 语法（esbuild 按 es2017 与 esnext 转换结果相同）', () => {
    const a = transformSync(code, { target: 'es2017', loader: 'js' }).code;
    const b = transformSync(code, { target: 'esnext', loader: 'js' }).code;
    expect(a).toBe(b);
  });

  test('经典 CommonJS 脚本：没有 import / export / import.meta / 动态 import', () => {
    const sf = ts.createSourceFile('game.js', code, ts.ScriptTarget.ES2017, true, ts.ScriptKind.JS);
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      if (
        ts.isImportDeclaration(n) ||
        ts.isImportEqualsDeclaration(n) ||
        ts.isExportDeclaration(n) ||
        ts.isExportAssignment(n) ||
        ts.isMetaProperty(n) ||
        (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)
      ) {
        found.push(n.getText(sf).slice(0, 40));
      }
      if (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        found.push(n.getText(sf).slice(0, 40));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(found).toEqual([]);
    expect(code).toContain("require('./sim.js')");
  });

  test('文件顶部有中文说明与 ESLint 全局声明', () => {
    expect(code.startsWith('/*')).toBe(true);
    const m = /\/\* global ([^*]+)\*\//.exec(code);
    if (!m) throw new Error('没有 /* global … */ 声明');
    const names = m[1]!.split(',').map((s) => s.trim());
    for (const n of ['wx', 'GameGlobal', 'require', 'console', 'setTimeout']) expect(names).toContain(n);
  });
});

describe('工程配置', () => {
  test('game.json：竖屏、不显示状态栏', () => {
    const g = JSON.parse(readFileSync(join(WX_SELFTEST_DIR, 'game.json'), 'utf8'));
    expect(g.deviceOrientation).toBe('portrait');
    expect(g.showStatusBar).toBe(false);
  });

  test('project.config.json：小游戏、测试号占位、关闭改写或校验代码的选项、打包忽略 README', () => {
    const p = JSON.parse(readFileSync(join(WX_SELFTEST_DIR, 'project.config.json'), 'utf8'));
    expect(p.compileType).toBe('game');
    expect(p.appid).toBe('touristappid');
    expect(typeof p.projectname).toBe('string');
    for (const k of ['es6', 'enhance', 'minified', 'urlCheck', 'postcss', 'uglifyFileName']) expect(p.setting[k]).toBe(false);
    expect(p.setting.babelSetting.ignore).toContain('sim.js');
    expect(p.packOptions.ignore).toContainEqual({ type: 'file', value: 'README.md' });
  });
});

describe('game.js 在模拟的微信运行时里', () => {
  test(
    '先画"运行中…"，冲刷 setTimeout 后输出 DET 行与参考行，等于主进程加载同一 sim.js 的结果',
    () => {
      const rt = startGame({ dir: wxDir, width: 375, height: 667, dpr: 2, safeTop: 20 });
      // 只取了一块主屏画布，并按设备像素比放大
      expect(rt.canvases).toHaveLength(1);
      const canvas = rt.canvases[0]!;
      expect(canvas.width).toBe(750);
      expect(canvas.height).toBe(1334);
      expect(canvas.ctx.calls.find((c) => c.op === 'setTransform')?.args).toEqual([2, 0, 0, 2, 0, 0]);
      // 内核尚未运行：屏幕上是"运行中…"，console 里还没有 DET
      expect(allTexts(canvas).some((t) => t.includes('运行中…'))).toBe(true);
      expect(detLines(rt)).toEqual([]);
      expect(rt.timers.length).toBe(1);

      expect(rt.flush()).toBe(2);
      expect(rt.errors).toEqual([]);
      expect(rt.warns).toEqual([]);
      const m = expectDetMatchesMain(rt);

      // sim.js 与源码一致：主进程结果也等于直接跑源码
      const src = runKernel({ checkpoints: false });
      expect(hex8(src.hash)).toBe(m[1]!);
      expect(src.steps).toBe(Number(m[2]));

      // 参考行：Math.sqrt 路径的哈希与 steps、每 tick 微秒数、语料版本、apiVersion
      const ref = rt.logs.find((l) => l.startsWith('参考 Math.sqrt '));
      if (!ref) throw new Error(`没有参考行：${rt.logs.join(' | ')}`);
      expect(ref.startsWith(`参考 Math.sqrt ${hex8(refSqrt.hash)} ${refSqrt.steps}；`)).toBe(true);
      expect(ref).toMatch(/dsqrt 每 tick \d+\.\d{2} µs/);
      expect(ref).toContain(`语料版本 ${mainSim.kernel.CORPUS_VERSION}`);
      expect(ref).toContain(`apiVersion ${mainSim.apiVersion}`);
      expect(refSqrt.hash).not.toBe(refDsqrt.hash);

      // steps/s 与耗时自洽：round(steps × 1000 / max(ms, 1))
      const timing = rt.logs.find((l) => l.includes('耗时：dsqrt 路径'));
      const ms = Number(/dsqrt 路径 (\d+) ms/.exec(timing ?? '')?.[1]);
      expect(Number.isInteger(ms)).toBe(true);
      expect(Number(m[3])).toBe(Math.round((refDsqrt.steps * 1000) / Math.max(ms, 1)));

      // 深色背景、浅色字；最后一帧里参考行也在屏幕上
      const frame = lastFrameTexts(canvas);
      const bg = canvas.ctx.calls.filter((c) => c.op === 'fillRect');
      expect(bg.length).toBeGreaterThanOrEqual(3);
      for (const r of bg) {
        expect(r.args).toEqual([0, 0, 375, 667]);
        expect(r.fillStyle).toBe(BG);
      }
      for (const t of frame) expect(luminance(t.fillStyle!)).toBeGreaterThan(luminance(BG) + 0.3);
      const joined = frame.map((t) => t.text).join('').replace(/\s+/g, '');
      for (const part of ref.split('；')) expect(joined).toContain(part.replace(/\s+/g, ''));
      expect(frame.map((t) => t.text)).toContain(`参考 Math.sqrt ${hex8(refSqrt.hash)} ${refSqrt.steps}`);
      expect(joined).toContain('iPhone7<iPhone9,1>');
      expect(joined.includes('运行中')).toBe(false);

      // GameGlobal 就是全局对象：BadmintonSim 成为真正的全局变量
      expect(runInContext('typeof BadmintonSim', rt.context)).toBe('object');
    },
    BUILD_TIMEOUT,
  );

  test(
    'GameGlobal 是独立对象：从 GameGlobal 取 BadmintonSim，全局上没有它',
    () => {
      const rt = startGame({ dir: wxDir, gameGlobal: 'separate' });
      rt.flush();
      expect(rt.errors).toEqual([]);
      expectDetMatchesMain(rt);
      expect(runInContext('typeof BadmintonSim', rt.context)).toBe('undefined');
      expect(typeof rt.gameGlobal!.BadmintonSim).toBe('object');
    },
    BUILD_TIMEOUT,
  );

  test(
    '没有 GameGlobal（Node / Bun）：退回 globalThis',
    () => {
      const rt = startGame({ dir: wxDir, gameGlobal: 'none' });
      rt.flush();
      expect(rt.errors).toEqual([]);
      expectDetMatchesMain(rt);
      expect(runInContext('typeof BadmintonSim', rt.context)).toBe('object');
    },
    BUILD_TIMEOUT,
  );

  test(
    '小屏（240×320、只有旧接口 getSystemInfoSync）：DET 行整行画出，其余换行不越界、不丢字',
    () => {
      const rt = startGame({ dir: wxDir, width: 240, height: 320, dpr: 1, safeTop: 0, legacyApis: true });
      rt.flush();
      expect(rt.errors).toEqual([]);
      expectDetMatchesMain(rt);
      const canvas = rt.canvases[0]!;
      expect(canvas.width).toBe(240);
      const frame = lastFrameTexts(canvas);
      for (const t of frame) {
        expect(t.x!).toBeGreaterThanOrEqual(0);
        expect(t.x! + fakeWidth(t.text!, t.font!)).toBeLessThanOrEqual(240);
      }
      // 换行只在空白处去掉空白：拼回去（去掉空白）等于原文（去掉空白）
      const joined = frame.map((t) => t.text).join('').replace(/\s+/g, '');
      const ref = rt.logs.find((l) => l.startsWith('参考 Math.sqrt '))!;
      for (const part of ref.split('；')) expect(joined).toContain(part.replace(/\s+/g, ''));
      expect(frame.map((t) => t.text)).toContain(`参考 Math.sqrt ${hex8(refSqrt.hash)} ${refSqrt.steps}`);
      expect(frame.length).toBeGreaterThan(8);
      // 旧接口的设备信息也能读到
      expect(joined).toContain('设备iPhone7<iPhone9,1>');
    },
    BUILD_TIMEOUT,
  );

  test('没有 sim.js：屏幕上画出错误并 console.error，提示先 sync，不排任何定时器', () => {
    const dir = tmp('game-nosim');
    copyFileSync(GAME_JS, join(dir, 'game.js'));
    const rt = startGame({ dir });
    expect(rt.timers).toHaveLength(0);
    expect(rt.errors).toHaveLength(1);
    expect(rt.errors[0]).toContain('bun run wx-selftest:sync');
    expect(rt.errors[0]).toContain("module 'sim.js' is not defined");
    const frame = lastFrameTexts(rt.canvases[0]!);
    const err = frame.find((t) => t.text!.includes('出错'));
    expect(err?.fillStyle).toBeDefined();
    expect(luminance(err!.fillStyle!)).toBeGreaterThan(0.3);
    expect(detLines(rt)).toEqual([]);
  });

  test('sim.js 没有挂出 BadmintonSim：报错指明 GameGlobal.BadmintonSim', () => {
    const dir = tmp('game-noglobal');
    copyFileSync(GAME_JS, join(dir, 'game.js'));
    writeFileSync(join(dir, 'sim.js'), 'var BadmintonSim = {}; // 顶层 var 在微信里不会成为全局\n');
    const rt = startGame({ dir });
    expect(rt.errors).toHaveLength(1);
    expect(rt.errors[0]).toContain('GameGlobal.BadmintonSim 不存在');
    expect(allTexts(rt.canvases[0]!).some((t) => t.includes('GameGlobal.BadmintonSim'))).toBe(true);
  });

  test('内核运行时抛错、wx.onError 收到未捕获异常：都画到屏幕并 console.error', () => {
    const dir = tmp('game-throw');
    copyFileSync(GAME_JS, join(dir, 'game.js'));
    writeFileSync(
      join(dir, 'sim.js'),
      [
        'GameGlobal.BadmintonSim = {',
        '  apiVersion: 0,',
        '  hash: { hex8: function (u) { return ("00000000" + (u >>> 0).toString(16)).slice(-8); } },',
        '  kernel: { DEFAULT_SHOTS: 1, CORPUS_VERSION: 1, run: function () { throw new Error("内核炸了"); } }',
        '};',
      ].join('\n'),
    );
    const rt = startGame({ dir });
    expect(rt.errors).toEqual([]);
    rt.flush();
    expect(rt.errors).toHaveLength(1);
    expect(rt.errors[0]).toContain('内核炸了');
    expect(allTexts(rt.canvases[0]!).some((t) => t.includes('内核炸了'))).toBe(true);
    expect(detLines(rt)).toEqual([]);

    expect(typeof rt.onError).toBe('function');
    rt.onError!({ message: '别处炸了', stack: 'at somewhere' });
    expect(rt.errors).toHaveLength(2);
    expect(rt.errors[1]).toContain('别处炸了');
    const frame = lastFrameTexts(rt.canvases[0]!).map((t) => t.text!);
    expect(frame.some((t) => t.includes('内核炸了'))).toBe(true);
    expect(frame.some((t) => t.includes('别处炸了'))).toBe(true);
  });

  test('调用约定：两段依次 run({checkpoints:false}) 与 run({checkpoints:false, sqrt: Math.sqrt})；哈希补足 8 位', () => {
    // 真实语料的哈希恰好没有前导 0，补位错误（如直接 toString(16)）在上面的测试里发现不了，这里用假内核专门测
    const dir = tmp('game-contract');
    copyFileSync(GAME_JS, join(dir, 'game.js'));
    writeFileSync(
      join(dir, 'sim.js'),
      [
        'GameGlobal.__runCalls = [];',
        'GameGlobal.BadmintonSim = {',
        '  apiVersion: 7,',
        '  hash: { hex8: function (u) { return ("00000000" + (u >>> 0).toString(16)).slice(-8); } },',
        '  kernel: { DEFAULT_SHOTS: 3, CORPUS_VERSION: 9, run: function (opts) {',
        '    GameGlobal.__runCalls.push(opts);',
        '    return { corpusVersion: 9, hash: opts && opts.sqrt ? 1 : 0xbeef, steps: 7, substeps: 14, shots: 3, checkpoints: [] };',
        '  } }',
        '};',
      ].join('\n'),
    );
    const rt = startGame({ dir });
    expect(rt.flush()).toBe(2);
    expect(rt.errors).toEqual([]);
    expect(detLines(rt)).toHaveLength(1);
    expect(detLines(rt)[0]).toMatch(/^DET 0000beef 7 \d+$/);
    const ref = rt.logs.find((l) => l.startsWith('参考 Math.sqrt '));
    expect(ref?.startsWith('参考 Math.sqrt 00000001 7；')).toBe(true);
    expect(ref).toContain('语料版本 9');
    expect(ref).toContain('apiVersion 7');
    const calls = rt.gameGlobal!.__runCalls as Array<{ checkpoints?: boolean; sqrt?: unknown; shots?: unknown; seed?: unknown }>;
    expect(calls).toHaveLength(2);
    // 拍数与种子不传：用内核默认值，与 bun run det --kernel 一致
    for (const c of calls) {
      expect(c.checkpoints).toBe(false);
      expect(c.shots).toBeUndefined();
      expect(c.seed).toBeUndefined();
    }
    expect(calls[0]!.sqrt).toBeUndefined();
    expect(calls[1]!.sqrt).toBe(runInContext('Math.sqrt', rt.context));
  });
});
