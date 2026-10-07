/**
 * bun run sim:build：把模拟核心打成唯一发布产物 packages/sim/dist/sim.js（计划 2.2）。
 *
 * 1. esbuild：入口 packages/sim/src/index.ts → IIFE、ES2017、不压缩、无外部依赖。
 *    入口最后一句显式赋值 (typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis).BadmintonSim = api；
 *    不用 --global-name。构建后校验这句确实是文件里 IIFE 的最后一条语句。
 * 2. tsc --emitDeclarationOnly（packages/sim/tsconfig.dts.json，单文件 outFile）→ dist/sim.d.ts，
 *    其中 declare global { var BadmintonSim } 声明全局变量；模块名统一加前缀 badminton-sim/ 防冲突。
 * 3. dist/sim.version = sim.js 文件字节的 FNV-1a（8 位十六进制）= simVer。
 *
 * 也可作为模块调用：buildSim({ outDir }) 供测试与自测夹具在临时目录里构建。
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { REPO_ROOT, SIM_DIST, SIM_DTS_TSCONFIG, SIM_ENTRY, TSC_BIN } from './paths';
import { fnv1aBytes, hex8 } from './fnv';

export const SIM_BANNER = '/* BadmintonSim 模拟核心：由 bun run sim:build 生成，勿手改。simVer = 本文件字节的 FNV-1a。 */';

/** 末尾全局赋值的形状：IIFE 体内最后一条语句，后面只剩 IIFE 的收尾。 */
const TAIL_RE =
  /\(typeof GameGlobal !== "undefined" \? GameGlobal : globalThis\)\.BadmintonSim = (\w+);\n\}\)\(\);\n$/;

export interface BuildOptions {
  /** 入口文件，默认 packages/sim/src/index.ts（自测夹具会换入口）。 */
  entry?: string;
  /** 输出目录，默认 packages/sim/dist。 */
  outDir?: string;
  /** 是否生成 sim.d.ts（默认 true；夹具不需要）。 */
  dts?: boolean;
}

export interface BuildResult {
  jsPath: string;
  bytes: number;
  simVer: string;
  dtsPath: string | null;
}

/** esbuild 打包；返回 sim.js 的文本。 */
export async function bundleSim(entry: string): Promise<string> {
  const res = await build({
    entryPoints: [entry],
    absWorkingDir: REPO_ROOT,
    bundle: true,
    format: 'iife',
    target: 'es2017',
    platform: 'neutral',
    minify: false,
    write: false,
    charset: 'utf8',
    legalComments: 'none',
    banner: { js: SIM_BANNER },
    logLevel: 'silent',
  });
  if (res.errors.length > 0) throw new Error(`esbuild 失败：${res.errors.map((e) => e.text).join('; ')}`);
  const file = res.outputFiles[0];
  if (!file) throw new Error('esbuild 没有产出文件');
  const text = file.text;
  if (!TAIL_RE.test(text)) {
    throw new Error('sim.js 末尾不是显式的全局赋值 (typeof GameGlobal …).BadmintonSim = api；检查入口文件');
  }
  return text;
}

/** 生成单文件 sim.d.ts：tsc 输出 AMD 形式的 declare module "x"，统一改名为 badminton-sim/x。 */
export function emitDts(outFile: string): void {
  const r = spawnSync(TSC_BIN, ['-p', SIM_DTS_TSCONFIG, '--outFile', outFile], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`tsc 生成 sim.d.ts 失败：\n${r.stdout}${r.stderr}`);
  const raw = readFileSync(outFile, 'utf8');
  const names = new Set<string>();
  for (const m of raw.matchAll(/^declare module "([^"]+)" \{$/gm)) names.add(m[1]!);
  if (!names.has('index')) throw new Error('sim.d.ts 里没有 index 模块，tsc 输出形状变了');
  const renamed = raw.replace(/(declare module |from |import\()"([^"]+)"/g, (all, head: string, name: string) =>
    names.has(name) ? `${head}"badminton-sim/${name}"` : all,
  );
  const header =
    '// 由 bun run sim:build 生成（tsc --emitDeclarationOnly），勿手改。\n' +
    '// 引入本文件即得到全局变量 BadmintonSim 的类型（见 declare module "badminton-sim/index" 里的 declare global）。\n';
  writeFileSync(outFile, header + renamed);
}

export async function buildSim(opts: BuildOptions = {}): Promise<BuildResult> {
  const entry = opts.entry ?? SIM_ENTRY;
  const outDir = opts.outDir ?? SIM_DIST;
  mkdirSync(outDir, { recursive: true });
  const text = await bundleSim(entry);
  const bytes = new TextEncoder().encode(text);
  const jsPath = resolve(outDir, 'sim.js');
  writeFileSync(jsPath, bytes);
  const simVer = hex8(fnv1aBytes(bytes));
  writeFileSync(resolve(outDir, 'sim.version'), `${simVer}\n`);
  let dtsPath: string | null = null;
  if (opts.dts !== false) {
    dtsPath = resolve(outDir, 'sim.d.ts');
    emitDts(dtsPath);
  }
  return { jsPath, bytes: bytes.length, simVer, dtsPath };
}

if (import.meta.main) {
  try {
    const r = await buildSim();
    console.log(`[sim:build] ${relative(REPO_ROOT, r.jsPath)}  ${r.bytes} 字节  simVer=${r.simVer}`);
    if (r.dtsPath) console.log(`[sim:build] ${relative(REPO_ROOT, r.dtsPath)}`);
  } catch (e) {
    console.error(`[sim:build] 失败：${(e as Error).message}`);
    process.exit(1);
  }
}
