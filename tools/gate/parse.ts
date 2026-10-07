/**
 * 从 gate 各步骤的输出里提取要点（测试条数、错误数、simVer、det 结论……）。
 * 输入先去 ANSI；解析不到时返回 null，调用方据此只显示退出码。
 */
import { stripAnsi } from './run';

export interface BunTestSummary {
  pass: number;
  fail: number;
  skip: number;
  todo: number;
  /** 测试之间的未处理错误（bun 把它们也计入 fail）。 */
  errors: number;
  expectCalls: number | null;
  /** "Ran K tests across F files" 的 K 与 F。 */
  tests: number | null;
  files: number | null;
}

/** 取正则在文本中的最后一次匹配（摘要行在最后；测试自己打印的同形行在前面）。 */
function lastMatch(text: string, re: RegExp): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let last: RegExpExecArray | null = null;
  for (let m = g.exec(text); m !== null; m = g.exec(text)) last = m;
  return last;
}

function lastInt(text: string, re: RegExp): number | null {
  const m = lastMatch(text, re);
  return m ? Number(m[1]) : null;
}

/**
 * 解析 bun test 的结尾摘要：
 *    3 pass / 1 skip / 1 todo / 2 fail / 1 error / 3 expect() calls / Ran 7 tests across 4 files. [6.00ms]
 * 一行都找不到（例如 bun 没跑起来）返回 null。
 */
export function parseBunTest(output: string): BunTestSummary | null {
  const text = stripAnsi(output);
  const pass = lastInt(text, /^\s*(\d+) pass\s*$/m);
  const fail = lastInt(text, /^\s*(\d+) fail\s*$/m);
  const ran = lastMatch(text, /^Ran (\d+) tests? across (\d+) files?\./m);
  if (pass === null && fail === null && ran === null) return null;
  return {
    pass: pass ?? 0,
    fail: fail ?? 0,
    skip: lastInt(text, /^\s*(\d+) skip\s*$/m) ?? 0,
    todo: lastInt(text, /^\s*(\d+) todo\s*$/m) ?? 0,
    errors: lastInt(text, /^\s*(\d+) errors?\s*$/m) ?? 0,
    expectCalls: lastInt(text, /^\s*(\d+) expect\(\) calls\s*$/m),
    tests: ran ? Number(ran[1]) : null,
    files: ran ? Number(ran[2]) : null,
  };
}

/** "123 通过 / 0 失败（125 条，30 个文件；2 跳过）" */
export function formatBunTest(s: BunTestSummary): string {
  const extra: string[] = [];
  if (s.skip > 0) extra.push(`${s.skip} 跳过`);
  if (s.todo > 0) extra.push(`${s.todo} 待办`);
  if (s.errors > 0) extra.push(`${s.errors} 个测试间错误`);
  const ran = s.tests !== null ? `${s.tests} 条，${s.files} 个文件` : '';
  const paren = [ran, extra.join('、')].filter((x) => x.length > 0).join('；');
  return `${s.pass} 通过 / ${s.fail} 失败${paren ? `（${paren}）` : ''}`;
}

export interface EslintSummary {
  problems: number;
  errors: number;
  warnings: number;
}

/** 解析 ESLint stylish 格式的结尾 "✖ 5 problems (4 errors, 1 warning)"；没有问题时 ESLint 不输出，返回全 0。 */
export function parseEslint(output: string): EslintSummary {
  const text = stripAnsi(output);
  const m = lastMatch(text, /(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/);
  if (!m) return { problems: 0, errors: 0, warnings: 0 };
  return { problems: Number(m[1]), errors: Number(m[2]), warnings: Number(m[3]) };
}

/** tsc 的错误条数（"file(1,2): error TS2322: …" 与非 pretty 模式下的 "error TS…" 行）。 */
export function parseTsc(output: string): number {
  const text = stripAnsi(output);
  return (text.match(/\berror TS\d+:/g) ?? []).length;
}

/** sim:build 的 "[sim:build] packages/sim/dist/sim.js  12345 字节  simVer=0123abcd"。 */
export function parseSimBuild(output: string): { simVer: string; bytes: number } | null {
  const text = stripAnsi(output);
  const m = lastMatch(text, /(\d+) 字节\s+simVer=([0-9a-f]{8})/);
  return m ? { bytes: Number(m[1]), simVer: m[2]! } : null;
}

/** sim:scan 的 "[sim:scan] 1 个文件，0 处违规"。 */
export function parseSimScan(output: string): { files: number; violations: number } | null {
  const text = stripAnsi(output);
  const m = lastMatch(text, /\[sim:scan\] (\d+) 个文件，(\d+) 处违规/);
  return m ? { files: Number(m[1]), violations: Number(m[2]) } : null;
}

/** det 的 "结论：…" 与 "DET <hash> <steps>" 两行。 */
export function parseDet(output: string): { conclusion: string | null; hash: string | null; steps: string | null } | null {
  const text = stripAnsi(output);
  const c = lastMatch(text, /^结论：(.+)$/m);
  const d = lastMatch(text, /^DET (\S+) (\S+)\s*$/m);
  if (!c && !d) return null;
  return { conclusion: c ? c[1]!.trim() : null, hash: d ? d[1]! : null, steps: d ? d[2]! : null };
}

/** 截断到 max 个显示字符（按码点），超出加省略号。 */
export function clip(s: string, max: number): string {
  const cps = [...s];
  return cps.length <= max ? s : `${cps.slice(0, max - 1).join('')}…`;
}
