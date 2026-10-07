/**
 * bun run sim:build：把模拟核心打成唯一发布产物 packages/sim/dist/sim.js（计划 2.2）。
 *
 * 1. esbuild：入口 packages/sim/src/index.ts → IIFE、ES2017、不压缩、无外部依赖。
 *    入口最后一句显式赋值 (typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis).BadmintonSim = api；
 *    不用 --global-name。构建后校验这句确实是文件里 IIFE 的最后一条语句。
 * 2. tsc --emitDeclarationOnly（packages/sim/tsconfig.dts.json，单文件 outFile）→ dist/sim.d.ts，
 *    其中 declare global { var BadmintonSim } 声明全局变量。sim 以相对路径引用的契约源码一并编进来；
 *    模块名改名防冲突：sim/src/<x> → badminton-sim/<x>，contracts/src/<x> → badminton-sim/contracts/<x>，
 *    其余模块名报错；产物里不许有指向本文件未声明模块的导入（消费者工程解析不了）。
 * 3. dist/sim.version = sim.js 文件字节的 FNV-1a（8 位十六进制）= simVer。
 *
 * 也可作为模块调用：buildSim({ outDir }) 供测试与自测夹具在临时目录里构建。
 */
import { build } from 'esbuild';
import ts from 'typescript';
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

/** tsc 输出的模块名前缀（tsconfig.dts.json 的 rootDir = packages）→ sim.d.ts 里的模块名前缀。 */
const DTS_MODULE_PREFIXES: ReadonlyArray<readonly [from: string, to: string]> = [
  ['sim/src/', 'badminton-sim/'],
  ['contracts/src/', 'badminton-sim/contracts/'],
];
/** sim.d.ts 里必须有的入口模块（declare global { var BadmintonSim } 在它里面）。 */
export const DTS_INDEX_MODULE = 'badminton-sim/index';

/**
 * tsc 输出的模块名 → sim.d.ts 里的模块名：sim/src/<x> → badminton-sim/<x>，contracts/src/<x> → badminton-sim/contracts/<x>。
 * 其余任何模块名（别的包、sim/test 等）都报错而不是放过：sim 只应引用自身与契约。
 */
export function dtsModuleName(name: string): string {
  for (const [from, to] of DTS_MODULE_PREFIXES) {
    if (name.startsWith(from) && name.length > from.length) return to + name.slice(from.length);
  }
  throw new Error(
    `sim.d.ts 里出现了意外的模块 "${name}"：只允许 sim/src/<x> 与 contracts/src/<x>（sim 只应引用自身与以相对路径引用的契约）`,
  );
}

/** d.ts 的模块引用：declare module 的模块名、全部模块说明符、三斜线引用。用语法树取，注释里的文字不算。 */
export interface DtsModuleRefs {
  declared: string[];
  /** import / export … from、import "x"、import("x") 类型、import x = require("x") 的说明符。 */
  specifiers: string[];
  /** /// <reference path | types | lib>。 */
  tripleSlash: string[];
}

export function dtsModuleRefs(text: string): DtsModuleRefs {
  const sf = ts.createSourceFile('sim.d.ts', text, ts.ScriptTarget.ES2017, true, ts.ScriptKind.TS);
  const refs: DtsModuleRefs = { declared: [], specifiers: [], tripleSlash: [] };
  const stack: ts.Node[] = [sf];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (ts.isModuleDeclaration(n) && ts.isStringLiteral(n.name)) refs.declared.push(n.name.text);
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      refs.specifiers.push(n.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      refs.specifiers.push(n.argument.literal.text);
    }
    if (ts.isExternalModuleReference(n) && ts.isStringLiteral(n.expression)) refs.specifiers.push(n.expression.text);
    // 子节点倒序入栈，结果按文件中出现的先后
    const kids: ts.Node[] = [];
    n.forEachChild((c) => {
      kids.push(c);
    });
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  for (const r of [...sf.referencedFiles, ...sf.typeReferenceDirectives, ...sf.libReferenceDirectives]) {
    refs.tripleSlash.push(r.fileName);
  }
  return refs;
}

/**
 * 把 tsc 输出的 AMD 形式单文件 d.ts（declare module "sim/src/x" …）整理成发布的 sim.d.ts 文本：
 * 模块名按 dtsModuleName 改名；必须有 badminton-sim/index；改名后每个导入都得指向本文件声明的模块、
 * 不许有三斜线引用（否则消费者工程解析不了）。任何一条不满足都抛错。
 */
export function finalizeDts(raw: string): string {
  const rename = new Map<string, string>();
  const owner = new Map<string, string>();
  for (const name of dtsModuleRefs(raw).declared) {
    const to = dtsModuleName(name);
    const prev = owner.get(to);
    if (prev !== undefined && prev !== name) throw new Error(`sim.d.ts 里的模块 "${prev}" 与 "${name}" 都改名成了 "${to}"`);
    owner.set(to, name);
    rename.set(name, to);
  }
  if (!owner.has(DTS_INDEX_MODULE)) throw new Error(`sim.d.ts 里没有 ${DTS_INDEX_MODULE} 模块，tsc 输出形状变了`);
  const renamed = raw.replace(
    /(declare module |from |import\(|import |require\()"([^"]+)"/g,
    (all, head: string, name: string) => {
      const to = rename.get(name);
      return to === undefined ? all : `${head}"${to}"`;
    },
  );
  const refs = dtsModuleRefs(renamed);
  const declared = new Set(refs.declared);
  const external = [...new Set(refs.specifiers.filter((s) => !declared.has(s)))];
  if (external.length > 0) {
    throw new Error(
      `sim.d.ts 里有指向 badminton-sim/* 以外（本文件未声明）的导入：${external.map((s) => `"${s}"`).join('、')}；` +
        '消费者工程解析不了，sim 只应引用自身与以相对路径引用的契约',
    );
  }
  if (refs.tripleSlash.length > 0) {
    throw new Error(`sim.d.ts 里有三斜线引用：${refs.tripleSlash.map((s) => `"${s}"`).join('、')}；消费者工程可能解析不了`);
  }
  const header =
    '// 由 bun run sim:build 生成（tsc --emitDeclarationOnly），勿手改。\n' +
    `// 引入本文件即得到全局变量 BadmintonSim 的类型（见 declare module "${DTS_INDEX_MODULE}" 里的 declare global）；\n` +
    '// 契约类型在 badminton-sim/contracts/* 里。\n';
  return header + renamed;
}

/** 生成单文件 sim.d.ts：tsc 输出 AMD 形式的 declare module "x"，由 finalizeDts 改名并检查。 */
export function emitDts(outFile: string): void {
  const r = spawnSync(TSC_BIN, ['-p', SIM_DTS_TSCONFIG, '--outFile', outFile], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  // tsc 根本没能启动（找不到可执行文件等）时 stdout/stderr 是 null，原因只在 r.error 里
  if (r.error) throw new Error(`无法运行 tsc（${TSC_BIN}）：${r.error.message}；先在仓库根 bun install`);
  if (r.status !== 0) throw new Error(`tsc 生成 sim.d.ts 失败：\n${r.stdout}${r.stderr}`);
  writeFileSync(outFile, finalizeDts(readFileSync(outFile, 'utf8')));
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
