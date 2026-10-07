/**
 * pre-commit 钩子的主体（.githooks/pre-commit 调用；计划 4.2：ESLint 禁令 + 暂存区的 sim:scan）。
 *
 * 查的是暂存（索引）版本，不是工作树版本：只 git add 了一半的文件按暂存的那一半判。
 *   1. 列出暂存的 .ts/.js/.mjs/.cjs（git diff --cached --name-only --diff-filter=ACMR）；没有就直接通过。
 *   2. ESLint Node API（new ESLint({ cwd: 仓库根 })）：被忽略的文件跳过，其余用 lintText(git show :路径, { filePath })
 *      检查暂存内容。只有错误（含解析失败）才拦，警告只打印。
 *   3. tools/sim/scan.ts 的 scanStaged(仓库根)：暂存区里的 packages/sim/src/**\/*.ts 与（若被暂存的）dist/sim.js。
 * 有错误或违规 → 打印并返回 1（git 中止提交）；否则 0。
 *
 * git 调用继承环境变量：git commit -a / git commit <路径> 时 git 用 GIT_INDEX_FILE 指向临时索引，必须读那一份。
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

/** 要检查的扩展名。 */
export const LINT_EXTS = ['.ts', '.js', '.mjs', '.cjs'] as const;

export function isLintTarget(path: string): boolean {
  return LINT_EXTS.some((ext) => path.endsWith(ext));
}

function git(repoRoot: string, args: string[]): Buffer {
  const r = spawnSync('git', args, { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`无法运行 git：${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr.toString('utf8').trim()}`);
  return r.stdout;
}

/** 暂存区里新增/复制/修改/改名的文件（仓库内相对路径，排序）。 */
export function listStaged(repoRoot: string): string[] {
  return git(repoRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0)
    .sort();
}

/** 读暂存版本的文件内容。 */
export function readStaged(repoRoot: string, path: string): string {
  return git(repoRoot, ['show', `:${path}`]).toString('utf8');
}

export interface PreCommitIO {
  out?: (s: string) => void;
  err?: (s: string) => void;
}

const TAG = '[pre-commit]';

/** 跑钩子；返回退出码（0 通过，1 拦下）。 */
export async function runPreCommit(repoRoot: string, io: PreCommitIO = {}): Promise<number> {
  const out = io.out ?? ((s: string) => void process.stdout.write(s));
  const err = io.err ?? ((s: string) => void process.stderr.write(s));
  const root = resolve(repoRoot);

  let staged: string[];
  try {
    staged = listStaged(root).filter(isLintTarget);
  } catch (e) {
    err(`${TAG} ${(e as Error).message}\n`);
    return 1;
  }
  if (staged.length === 0) {
    out(`${TAG} 没有暂存的 ${LINT_EXTS.join('/')} 文件，跳过 ESLint 与 sim:scan\n`);
    return 0;
  }

  let failed = false;

  // 1. ESLint：检查暂存内容
  let lintErrors = 0;
  let lintWarnings = 0;
  let linted = 0;
  let ignored = 0;
  try {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({ cwd: root });
    const results: Awaited<ReturnType<typeof eslint.lintText>> = [];
    for (const rel of staged) {
      const abs = join(root, rel);
      if (await eslint.isPathIgnored(abs)) {
        ignored++;
        continue;
      }
      linted++;
      results.push(...(await eslint.lintText(readStaged(root, rel), { filePath: abs, warnIgnored: false })));
    }
    for (const r of results) {
      lintErrors += r.errorCount;
      lintWarnings += r.warningCount;
    }
    if (lintErrors + lintWarnings > 0) {
      const formatter = await eslint.loadFormatter('stylish');
      const text = await formatter.format(results);
      (lintErrors > 0 ? err : out)(`${text.trimEnd()}\n`);
    }
  } catch (e) {
    err(`${TAG} ESLint 运行失败（还没装依赖？先在仓库根 bun install）：${(e as Error).message}\n`);
    failed = true;
  }
  const ignoredNote = ignored > 0 ? `（${ignored} 个被忽略）` : '';
  out(`${TAG} ESLint：${linted} 个暂存文件${ignoredNote}，${lintErrors} 个错误，${lintWarnings} 个警告\n`);
  if (lintErrors > 0) failed = true;

  // 2. sim:scan：暂存区
  try {
    const { scanStaged, formatViolation } = await import('../sim/scan');
    const scan = scanStaged(root);
    for (const v of scan.violations) err(`${formatViolation(v)}\n`);
    out(`${TAG} sim:scan（暂存区）：${scan.files} 个文件，${scan.violations.length} 处违规\n`);
    if (scan.violations.length > 0) failed = true;
  } catch (e) {
    err(`${TAG} sim:scan 运行失败：${(e as Error).message}\n`);
    failed = true;
  }

  if (failed) {
    err(`${TAG} 提交被拦下：改好后重新 git add 再提交（检查的是暂存版本，不是工作树）\n`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  // 钩子从工作树根运行；用本文件所在的工作树作为仓库根（主干与 .worktrees/task-xx 各查各的）。
  const root = resolve(import.meta.dir, '..', '..');
  runPreCommit(root).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`${TAG} 意外错误：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.exit(1);
    },
  );
}
