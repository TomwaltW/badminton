/**
 * bun run merge <轨>：把一条并行轨道合进主干（计划 4.2）。
 *
 *   <轨> 如 t1 → 工作树 .worktrees/task-t1（用 git worktree list --porcelain 确认它是本仓库的工作树并取分支）。
 *
 * 前置检查（任何一项不过即拒绝执行，不动任何东西）：
 *   - 在主工作树（不是链接工作树）里运行；主干当前分支即合并目标（不能是分离 HEAD，不能有进行中的合并）；
 *   - 主干与轨道工作树的已跟踪文件都干净（git status --porcelain --untracked-files=no 为空）；
 *   - 轨道工作树在分支上（不是分离 HEAD），且分支有主干之外的新提交。
 * 流程：
 *   1. 轨道工作树里：有 bun.lock 则先 bun install --frozen-lockfile，再 bun run gate → 红则不合并；
 *   2. 主干：再查一次主干（工作树 gate 期间主干若被提交或改脏，就不合并——否则回退时会连带抹掉别人的工作）；
 *      先写一份"进行中"回执（见下），再 git merge --no-ff --no-edit -m "合并 <轨>（<分支>）" <gate 过的那个提交>；
 *      冲突则 git merge --abort；
 *   3. 主干：（合并改了 bun.lock 则先 bun install --frozen-lockfile）bun run gate → 红则 git reset --keep <合并前 sha>。
 *      一律用 --keep 而不是 --hard：主干 gate 期间别人可能改了已跟踪文件，或在被本次合并删除 / 新增的路径上建了
 *      未跟踪文件，--hard 会静默覆盖它们；--keep 遇到这种挡路的文件就拒绝执行，转为"未能自动回退（需手工处理）"，
 *      回执里给出挡路的文件与手工回退命令。保险：主干 gate 期间若主干又有新提交，也不自动回退（需手工处理）。
 * 无论结果，把完整过程写到 review/receipt-<轨>.md（时间、轨道、分支、合并前后 sha、两次 gate 的退出码与输出尾部、结论）。
 * git merge 之前先写一份结论为"进行中"的回执，正常结束时被最终结论覆盖；merge 若被 kill -9、断电等无法拦截的方式
 * 中断，留下的就是这一份——说明主干可能停在未经 gate 的合并提交上，并给出检查与手工回退命令。
 * 命令行运行时 Ctrl-C（SIGINT）、SIGTERM 与 SIGHUP（关终端 / SSH 断线）都不会让主干停在未经 gate 的合并上：
 * 等当前子进程退出后不再合并、已合并则回退，并照常写回执；终端已关闭时写输出失败也不影响收尾。
 *
 * 退出码：0 已合并；1 未合并（工作树 gate 红）；2 拒绝执行（参数或前置检查）；3 冲突已中止；
 *         4 已回退（主干 gate 红）；5 未合并（git merge 因冲突以外的原因失败）；6 已中断（未合并）；
 *         7 主干 gate 红但未能自动回退（需手工处理）。
 *
 * 逻辑在 runMerge() 里，gate / install 命令、环境、输出、时钟与中断状态都可注入（测试用）；默认就是 bun run gate。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { bunBin, formatCmd, formatDuration, runCommand, stripAnsi, tailLines } from '../gate/run';

export type MergeOutcome =
  | 'merged'
  | 'worktree-red'
  | 'refused'
  | 'conflict'
  | 'reverted'
  | 'merge-failed'
  | 'interrupted'
  | 'revert-failed';

export const OUTCOME_TEXT: Record<MergeOutcome, string> = {
  merged: '已合并',
  'worktree-red': '未合并（工作树 gate 红）',
  refused: '拒绝执行（前置检查未通过）',
  conflict: '冲突已中止',
  reverted: '已回退（主干 gate 红）',
  'merge-failed': '未合并（git merge 失败）',
  interrupted: '已中断（未合并）',
  'revert-failed': '主干 gate 红，未能自动回退（需手工处理）',
};

export const OUTCOME_EXIT: Record<MergeOutcome, number> = {
  merged: 0,
  'worktree-red': 1,
  refused: 2,
  conflict: 3,
  reverted: 4,
  'merge-failed': 5,
  interrupted: 6,
  'revert-failed': 7,
};

/** 轨道名：字母数字开头，只含字母数字 . _ -（它会拼进路径与文件名）。 */
export const TRACK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 回执里每段输出最多保留的行数。 */
export const RECEIPT_TAIL_LINES = 200;

/** 子进程非 0 退出后等待挂起的信号处理函数执行的时间（毫秒），见 runMerge 里的 run()。 */
const SIGNAL_SETTLE_MS = 100;

export interface WorktreeEntry {
  path: string;
  head: string | null;
  /** 完整引用名，如 refs/heads/track/t1；分离 HEAD 或裸仓库为 null。 */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/** 解析 git worktree list --porcelain。第一条是主工作树。 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const raw of porcelain.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length === 0) {
      cur = null;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      cur = { path: val, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  return out;
}

/** 规范化路径以便比较（存在则取 realpath，处理 /tmp → /private/tmp 之类的符号链接）。 */
function canon(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** 会改变 git 定位仓库方式的环境变量：merge 永远按 cwd 找仓库，不继承它们（例如在钩子里被调用时）。 */
const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
];

function cleanEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of GIT_LOCATION_VARS) delete env[k];
  return env;
}

export interface CmdRecord {
  label: string;
  cmd: string[];
  cwd: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface MergeReport {
  outcome: MergeOutcome;
  exitCode: number;
  track: string;
  /** 一句话说明结论的原因。 */
  reason: string;
  mainRoot: string | null;
  mainBranch: string | null;
  trackPath: string | null;
  branch: string | null;
  branchSha: string | null;
  preSha: string | null;
  mergeSha: string | null;
  finalSha: string | null;
  startedAt: Date;
  endedAt: Date;
  /** 过程记录（按时间顺序）。 */
  steps: string[];
  installs: CmdRecord[];
  worktreeGate: CmdRecord | null;
  mainGate: CmdRecord | null;
  conflicts: string[];
  warnings: string[];
  receiptPath: string | null;
}

export interface MergeOptions {
  track: string;
  /** 运行位置（默认 process.cwd()）：必须在主工作树里。 */
  cwd?: string;
  /** gate 命令，默认 bun run gate。 */
  gateCmd?: string[];
  /** 依赖安装命令（工作树有 bun.lock 时先跑），默认 bun install --frozen-lockfile。 */
  installCmd?: string[];
  /** gate / install / git 的环境（默认继承；会去掉 GIT_DIR 等定位变量）。 */
  env?: NodeJS.ProcessEnv;
  /** 进度输出（默认 stdout）。 */
  write?: (s: string) => void;
  /** 是否把 gate 输出实时转发到 write（默认 true）。 */
  echo?: boolean;
  now?: () => Date;
  /** 回执里每段输出保留的行数，默认 200。 */
  tailLines?: number;
  /** 是否已收到中断信号（返回信号名，如 SIGINT；未中断返回 null）。命令行入口据 SIGINT / SIGTERM / SIGHUP 设置。 */
  interrupted?: () => string | null;
}

interface GitResult {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
}

class Refused extends Error {
  override name = 'Refused';
}

/** 合并一条轨道；永不抛错（意外错误也记进回执，按"拒绝执行"或当时的阶段处理）。 */
export async function runMerge(opts: MergeOptions): Promise<MergeReport> {
  const now = opts.now ?? (() => new Date());
  const write = opts.write ?? ((s: string) => void process.stdout.write(s));
  const echo = opts.echo ?? true;
  const env = cleanEnv(opts.env ?? process.env);
  const bun = bunBin();
  const gateCmd = opts.gateCmd ?? [bun, 'run', 'gate'];
  const installCmd = opts.installCmd ?? [bun, 'install', '--frozen-lockfile'];
  const cwd = resolve(opts.cwd ?? process.cwd());

  const report: MergeReport = {
    outcome: 'refused',
    exitCode: OUTCOME_EXIT.refused,
    track: opts.track,
    reason: '',
    mainRoot: null,
    mainBranch: null,
    trackPath: null,
    branch: null,
    branchSha: null,
    preSha: null,
    mergeSha: null,
    finalSha: null,
    startedAt: now(),
    endedAt: now(),
    steps: [],
    installs: [],
    worktreeGate: null,
    mainGate: null,
    conflicts: [],
    warnings: [],
    receiptPath: null,
  };

  const log = (s: string) => {
    report.steps.push(s);
    write(`[merge] ${s}\n`);
  };
  const warn = (s: string) => {
    report.warnings.push(s);
    write(`[merge] 警告：${s}\n`);
  };
  const git = (dir: string, args: string[]): GitResult => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { ok: false, status: 127, stdout: '', stderr: `无法运行 git：${r.error.message}` };
    return { ok: r.status === 0, status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  const gitOut = (dir: string, args: string[], what: string): string => {
    const r = git(dir, args);
    if (!r.ok) throw new Error(`${what}失败（git ${args.join(' ')}）：${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  const run = async (label: string, cmd: string[], dir: string): Promise<CmdRecord> => {
    const shownDir = report.mainRoot ? relative(report.mainRoot, dir) || '.' : dir;
    log(`${label}：$ ${formatCmd(cmd)}（cwd ${shownDir}）`);
    const r = await runCommand(cmd, { cwd: dir, env, onOutput: echo ? (s) => write(s) : undefined });
    // Ctrl-C / 关终端的信号发给整个进程组：子进程随之退出，而本进程的信号处理函数可能还排在事件循环里。
    // 子进程非 0 退出时让一让事件循环，免得接下来的 signalled() 读到旧状态、把"已中断"误判成"gate 红"。
    if (r.exitCode !== 0 && opts.interrupted) await new Promise((res) => setTimeout(res, SIGNAL_SETTLE_MS));
    if (echo && r.output.length > 0 && !r.output.endsWith('\n')) write('\n');
    const rec: CmdRecord = { label, cmd, cwd: dir, exitCode: r.exitCode, durationMs: r.durationMs, output: r.output };
    log(`${label}：退出码 ${r.exitCode}（${formatDuration(r.durationMs)}）`);
    return rec;
  };
  const finish = (outcome: MergeOutcome, reason: string) => {
    report.outcome = outcome;
    report.exitCode = OUTCOME_EXIT[outcome];
    report.reason = reason;
  };
  const signalled = (): string | null => opts.interrupted?.() ?? null;

  /** 主干相对 expectHead 的变化（分支、HEAD、进行中的合并、已跟踪文件的改动）；没变返回 null。 */
  const mainDrift = (root: string, expectHead: string): string | null => {
    const sym = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = sym.ok ? sym.stdout.trim() : '分离 HEAD';
    if (branch !== report.mainBranch) return `当前分支变成了 ${branch}`;
    const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
    if (head !== expectHead) return `HEAD 从 ${expectHead.slice(0, 12)} 变成了 ${head.slice(0, 12)}`;
    if (git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) return '有进行中的合并';
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']).stdout.trim();
    return dirty.length > 0 ? `已跟踪文件有未提交的改动：${dirty.split('\n').join('；')}` : null;
  };

  /**
   * 撤掉本次合并，返回主干是否已回到合并前 sha。
   * 只在主干仍停在本次合并提交上时回退（gate 期间有人又提交了就不动，免得 reset 抹掉那些提交）。
   * 一律用 git reset --keep：它保留与本次合并无关的未提交改动；本次合并动过的路径上若有未提交改动或挡路的
   * 未跟踪文件（例如 gate 期间在被合并删除的路径上新建的文件），它拒绝执行而不是覆盖——这时转"需手工处理"。
   * （--hard 会把这些文件静默覆盖成合并前的内容。）
   */
  const revertMerge = (): boolean => {
    const root = report.mainRoot!;
    const pre = report.preSha!;
    const merged = report.mergeSha!;
    const sym = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = sym.ok ? sym.stdout.trim() : null;
    const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
    if (branch !== report.mainBranch || head !== merged) {
      warn(
        `主干已不在本次合并提交上（${branch ?? '分离 HEAD'} @ ${head}），为免抹掉别人的提交，没有自动回退；` +
          `请手工撤掉合并提交 ${merged}（例如 git revert -m 1 ${merged}）`,
      );
      return false;
    }
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']).stdout.trim();
    if (dirty.length > 0) warn(`主干在 gate 期间出现了未提交的已跟踪改动，git reset --keep 回退时保留它们：\n${dirty}`);
    const rs = git(root, ['reset', '--keep', pre]);
    const why = `${rs.stdout}${rs.stderr}`.trim();
    log(rs.ok ? `已执行 git reset --keep ${pre}` : `git reset --keep ${pre} 失败（退出码 ${rs.status}）：\n${why}`);
    const now = git(root, ['rev-parse', 'HEAD']).stdout.trim();
    if (now !== pre) {
      warn(
        `回退没有完成：主干 HEAD 是 ${now}，不是合并前的 ${pre}。git reset --keep 被拒绝——通常是 gate 期间` +
          `在本次合并动过的路径上出现了未提交改动或未跟踪文件，--keep 不会覆盖它们（git 的说明如下）：\n` +
          `${why || '（git 没有给出说明）'}\n` +
          `手工处理：先 git status 查看，把上面列出的文件挪走（或提交到别处）后运行 git reset --keep ${pre}；` +
          `若主干上已经有人接着提交，改用 git revert -m 1 ${merged}`,
      );
      return false;
    }
    return true;
  };

  /** 前置检查；不过则抛 Refused。 */
  const preflight = () => {
    if (!TRACK_RE.test(opts.track)) {
      throw new Refused(`轨道名不合法：${JSON.stringify(opts.track)}（只许字母、数字、. _ -，如 t1）`);
    }
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    if (!top.ok) throw new Refused(`${cwd} 不在 git 工作树里：${top.stderr.trim()}`);
    const toplevel = top.stdout.trim();

    const list = parseWorktreeList(gitOut(toplevel, ['worktree', 'list', '--porcelain'], '列出工作树'));
    const main = list[0];
    if (!main || main.bare) throw new Refused('找不到主工作树（裸仓库？）');
    report.mainRoot = main.path;
    if (canon(main.path) !== canon(toplevel)) {
      throw new Refused(`必须在主工作树里运行：当前在链接工作树 ${toplevel}，主工作树是 ${main.path}`);
    }

    const sym = git(main.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!sym.ok) throw new Refused('主干处于分离 HEAD：先切到要合并进去的分支');
    report.mainBranch = sym.stdout.trim();
    if (git(main.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
      throw new Refused('主干有进行中的合并（MERGE_HEAD 存在）：先完成或 git merge --abort');
    }

    const trackPath = join(main.path, '.worktrees', `task-${opts.track}`);
    report.trackPath = trackPath;
    const entry = list.slice(1).find((e) => canon(e.path) === canon(trackPath));
    if (!entry) {
      throw new Refused(
        `git worktree list 里没有 .worktrees/task-${opts.track}：它不是本仓库的工作树` +
          `（先 git worktree add .worktrees/task-${opts.track} -b <分支> <基线 sha>）`,
      );
    }
    if (entry.prunable || !existsSync(trackPath)) throw new Refused(`轨道工作树目录不存在（prunable）：${trackPath}`);
    if (!entry.branch) throw new Refused(`轨道工作树 .worktrees/task-${opts.track} 处于分离 HEAD，没有可合并的分支`);
    report.branch = entry.branch.replace(/^refs\/heads\//, '');
    if (report.branch === report.mainBranch) throw new Refused(`轨道分支与主干是同一个分支 ${report.branch}`);

    const dirtyMain = gitOut(main.path, ['status', '--porcelain', '--untracked-files=no'], '检查主干状态');
    if (dirtyMain.length > 0) throw new Refused(`主干有未提交的已跟踪改动（先提交或还原）：\n${dirtyMain}`);
    const dirtyTrack = gitOut(trackPath, ['status', '--porcelain', '--untracked-files=no'], '检查轨道工作树状态');
    if (dirtyTrack.length > 0) {
      throw new Refused(`轨道工作树 .worktrees/task-${opts.track} 有未提交的已跟踪改动（gate 查的必须是要合并的提交）：\n${dirtyTrack}`);
    }

    report.preSha = gitOut(main.path, ['rev-parse', 'HEAD'], '读取主干 sha');
    report.branchSha = gitOut(main.path, ['rev-parse', '--verify', `refs/heads/${report.branch}^{commit}`], '读取分支 sha');
    const ahead = Number(gitOut(main.path, ['rev-list', '--count', `${report.preSha}..${report.branchSha}`], '比较分支'));
    if (ahead === 0) throw new Refused(`分支 ${report.branch} 没有主干 ${report.mainBranch} 之外的新提交，无需合并`);
    log(
      `前置检查通过：主干 ${report.mainBranch} @ ${report.preSha.slice(0, 12)}，` +
        `轨道 ${opts.track} → .worktrees/task-${opts.track}（${report.branch} @ ${report.branchSha.slice(0, 12)}，领先 ${ahead} 个提交）`,
    );
  };

  /** 回执路径：轨道名不合法或找不到仓库时为 null（路径不可信或无处可写）。 */
  const receiptPath = (): string | null =>
    report.mainRoot && TRACK_RE.test(opts.track) ? join(report.mainRoot, 'review', `receipt-${opts.track}.md`) : null;
  /** 写回执；成功返回路径，失败只提示（不影响合并流程）。 */
  const writeReceipt = (text: string): string | null => {
    const path = receiptPath();
    if (!path) return null;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return path;
    } catch (e) {
      write(`[merge] 写回执失败：${(e as Error).message}\n`);
      return null;
    }
  };

  const flow = async (): Promise<void> => {
    try {
      preflight();
    } catch (e) {
      if (e instanceof Refused) {
        log(`前置检查未通过：${e.message}`);
        finish('refused', e.message);
        return;
      }
      throw e;
    }
    const mainRoot = report.mainRoot!;
    const trackPath = report.trackPath!;
    const preSha = report.preSha!;
    const branchSha = report.branchSha!;

    // 1. 轨道工作树：安装依赖 + gate
    if (existsSync(join(trackPath, 'bun.lock'))) {
      const ins = await run('工作树依赖安装', installCmd, trackPath);
      report.installs.push(ins);
      const sig = signalled();
      if (sig) {
        finish('interrupted', `依赖安装时收到 ${sig}，没有跑 gate，没有合并；主干没有改动`);
        return;
      }
      if (ins.exitCode !== 0) {
        finish('worktree-red', `轨道工作树依赖安装失败（退出码 ${ins.exitCode}），没有跑 gate，未合并`);
        return;
      }
    } else {
      log('工作树依赖安装：跳过（没有 bun.lock）');
    }
    report.worktreeGate = await run('工作树 gate', gateCmd, trackPath);
    const sigWt = signalled();
    if (sigWt) {
      finish('interrupted', `收到 ${sigWt}（工作树 gate 退出码 ${report.worktreeGate.exitCode}），没有合并；主干没有改动`);
      return;
    }
    if (report.worktreeGate.exitCode !== 0) {
      finish('worktree-red', `轨道工作树 gate 退出码 ${report.worktreeGate.exitCode}，未合并；主干没有改动`);
      return;
    }
    const dirtyAfter = git(trackPath, ['status', '--porcelain', '--untracked-files=no']).stdout.trim();
    if (dirtyAfter.length > 0) warn(`工作树 gate 运行后轨道工作树的已跟踪文件有改动（gate 不应改源码）：\n${dirtyAfter}`);
    const branchNow = git(mainRoot, ['rev-parse', '--verify', `refs/heads/${report.branch}^{commit}`]).stdout.trim();
    if (branchNow !== branchSha) {
      warn(`分支 ${report.branch} 在 gate 期间前进到 ${branchNow}；本次只合并经过 gate 的 ${branchSha}`);
    }

    // 2. 主干：--no-ff 合并（合并的是 gate 过的那个提交）。
    // 工作树 gate 可能跑了几分钟，其间主干可能被提交或改脏（例如 INT 会话在主干上工作）。合并前再查一次：
    // 否则合并会把别人的未提交改动带进来，主干 gate 红时 reset 会连同别人的新提交一起抹掉。
    const drift = mainDrift(mainRoot, preSha);
    if (drift) {
      finish('refused', `工作树 gate 期间主干发生了变化（${drift}），本次不合并；确认主干干净后重新运行 bun run merge ${opts.track}`);
      return;
    }
    const msg = `合并 ${opts.track}（${report.branch}）`;
    // 先写"进行中"回执：merge 若在合并之后被 kill -9 等无法拦截的方式中断，留下的回执会指出主干可能停在
    // 未经 gate 的合并提交上，并给出检查与手工回退命令；正常结束时被最终结论覆盖。
    const pending = receiptPath();
    if (pending) {
      log(`写"进行中"回执 ${relative(mainRoot, pending)}（正常结束时覆盖为最终结论）`);
      if (!writeReceipt(renderInProgressReceipt(report, msg, opts.tailLines ?? RECEIPT_TAIL_LINES))) {
        warn('"进行中"回执没有写成：merge 若被强行中断，将没有回执提示主干可能停在未经 gate 的合并提交上');
      }
    }
    const mergeArgs = ['merge', '--no-ff', '--no-edit', '-m', msg, branchSha];
    log(`主干合并：$ git ${formatCmd(mergeArgs)}`);
    const m = git(mainRoot, mergeArgs);
    if (!m.ok) {
      const mergeOutput = `${m.stdout}${m.stderr}`.trim();
      if (git(mainRoot, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
        report.conflicts = git(mainRoot, ['diff', '--name-only', '--diff-filter=U'])
          .stdout.split('\n')
          .filter((l) => l.length > 0);
        log(`主干合并：冲突（${report.conflicts.join('、') || '见 git 输出'}）\n${mergeOutput}`);
        const ab = git(mainRoot, ['merge', '--abort']);
        log(ab.ok ? '已执行 git merge --abort' : `git merge --abort 失败：${ab.stderr.trim()}`);
        const head = git(mainRoot, ['rev-parse', 'HEAD']).stdout.trim();
        const dirty = git(mainRoot, ['status', '--porcelain', '--untracked-files=no']).stdout.trim();
        if (head !== preSha || dirty.length > 0) {
          warn(`中止后主干不干净（HEAD ${head}，改动：${dirty || '无'}）：请手工检查`);
        }
        finish('conflict', `合并冲突，已 git merge --abort；主干保持在 ${preSha}`);
        return;
      }
      log(`主干合并：git merge 失败（退出码 ${m.status}）\n${mergeOutput}`);
      const head = git(mainRoot, ['rev-parse', 'HEAD']).stdout.trim();
      if (head !== preSha) warn(`git merge 失败后主干 HEAD 变成了 ${head}：请手工检查`);
      finish('merge-failed', `git merge 失败（退出码 ${m.status}），没有产生合并提交`);
      return;
    }
    report.mergeSha = gitOut(mainRoot, ['rev-parse', 'HEAD'], '读取合并提交');
    log(`主干合并：完成，合并提交 ${report.mergeSha}`);

    // 3. 主干：（必要时安装依赖）gate，红则回退；合并后已收到中断信号则不跑 gate、直接回退
    let installedOnMain = false;
    const lockChanged = git(mainRoot, ['diff', '--name-only', preSha, report.mergeSha, '--', 'bun.lock']).stdout.trim();
    if (lockChanged.length > 0 && existsSync(join(mainRoot, 'bun.lock')) && !signalled()) {
      const ins = await run('主干依赖安装（合并改了 bun.lock）', installCmd, mainRoot);
      report.installs.push(ins);
      installedOnMain = true;
      if (ins.exitCode !== 0) warn(`主干依赖安装失败（退出码 ${ins.exitCode}），继续跑 gate`);
    }
    if (!signalled()) report.mainGate = await run('主干 gate', gateCmd, mainRoot);
    const mainCode = report.mainGate ? report.mainGate.exitCode : null;
    if (mainCode !== 0) {
      const sig = signalled();
      const why = mainCode === null ? `合并后收到 ${sig}，没有跑主干 gate` : `主干 gate 退出码 ${mainCode}${sig ? `（收到 ${sig}）` : ''}`;
      if (!revertMerge()) {
        finish('revert-failed', `${why}，但没能自动回退（见警告），主干仍含合并提交 ${report.mergeSha}`);
        return;
      }
      if (installedOnMain) {
        const ins = await run('主干依赖安装（回退后恢复）', installCmd, mainRoot);
        report.installs.push(ins);
        if (ins.exitCode !== 0) warn(`回退后的依赖安装失败（退出码 ${ins.exitCode}）：请手工 bun install`);
      }
      finish(sig ? 'interrupted' : 'reverted', `${why}，已回退到合并前 ${preSha}`);
      return;
    }
    const dirtyMain = git(mainRoot, ['status', '--porcelain', '--untracked-files=no']).stdout.trim();
    if (dirtyMain.length > 0) warn(`主干 gate 运行后已跟踪文件有改动（gate 不应改源码）：\n${dirtyMain}`);
    finish('merged', `两次 gate 都通过，已合并为 ${report.mergeSha}`);
  };

  try {
    await flow();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`意外错误：${msg}`);
    // 意外错误发生在合并之后时尽量撤销本次合并，保证主干回到合并前。
    if (report.mergeSha && report.preSha && report.mainRoot) {
      if (revertMerge()) finish('reverted', `合并后发生意外错误，已回退：${msg}`);
      else finish('revert-failed', `合并后发生意外错误，且没能自动回退（见警告）：${msg}`);
    } else {
      finish(report.preSha ? 'merge-failed' : 'refused', `意外错误：${msg}`);
    }
  }

  if (report.mainRoot) {
    const head = git(report.mainRoot, ['rev-parse', 'HEAD']);
    report.finalSha = head.ok ? head.stdout.trim() : null;
  }
  report.endedAt = now();
  log(`结论：${OUTCOME_TEXT[report.outcome]}——${report.reason}`);

  // 回执写到主工作树的 review/ 下（覆盖"进行中"回执）；轨道名不合法或找不到仓库时不写（路径不可信或无处可写）。
  const path = writeReceipt(renderReceipt(report, opts.tailLines ?? RECEIPT_TAIL_LINES));
  if (path) {
    report.receiptPath = path;
    write(`[merge] 回执：${relative(cwd, path) || path}\n`);
  }
  return report;
}

/** 本地时间 "2026-10-08 17:30:01 +08:00"。 */
export function formatTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ` +
    `${off >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}:${p(a % 60)}`
  );
}

/** 足够长的代码围栏：比内容里最长的反引号串多一个，至少 3 个。 */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function outputBlock(title: string, rec: CmdRecord, root: string | null, tailN: number): string[] {
  const clean = stripAnsi(rec.output);
  const t = tailLines(clean, tailN);
  const dir = root ? relative(root, rec.cwd) || '.' : rec.cwd;
  const range = t.total === 0 ? '无输出' : t.truncated ? `共 ${t.total} 行，以下为最后 ${tailN} 行` : `共 ${t.total} 行`;
  const fence = fenceFor(t.text);
  return [
    `## ${title}`,
    '',
    `命令 \`${formatCmd(rec.cmd)}\`，cwd \`${dir}\`，退出码 **${rec.exitCode}**，耗时 ${formatDuration(rec.durationMs)}；${range}。`,
    '',
    `${fence}text`,
    t.text,
    fence,
    '',
  ];
}

function code(s: string | null): string {
  return s ? `\`${s}\`` : '—';
}

/** 合并提交后来的去向：已回退 / 仍在主干上（需手工处理）。 */
function mergeShaNote(r: MergeReport): string {
  if (r.outcome === 'revert-failed') return '，未能自动回退，仍在主干上';
  return r.outcome === 'merged' ? '' : '，已回退';
}

function gateCell(rec: CmdRecord | null): string {
  return rec ? `退出码 ${rec.exitCode}（${formatDuration(rec.durationMs)}）` : '未运行';
}

/** "## 过程"一节：编号步骤，多行细节放进代码围栏。 */
function stepsSection(r: MergeReport): string[] {
  const lines = ['## 过程', ''];
  r.steps.forEach((s, i) => {
    const [first, ...rest] = s.split('\n');
    lines.push(`${i + 1}. ${first}`);
    if (rest.length > 0) {
      const body = rest.join('\n');
      const fence = fenceFor(body);
      lines.push('', `   ${fence}text`, ...rest.map((l) => `   ${l}`), `   ${fence}`, '');
    }
  });
  lines.push('');
  return lines;
}

/** 依赖安装与两次 gate 的输出尾部。 */
function outputSections(r: MergeReport, tailN: number): string[] {
  const lines: string[] = [];
  for (const ins of r.installs) lines.push(...outputBlock(`${ins.label} 输出`, ins, r.mainRoot, tailN));
  if (r.worktreeGate) lines.push(...outputBlock('工作树 gate 输出', r.worktreeGate, r.mainRoot, tailN));
  if (r.mainGate) lines.push(...outputBlock('主干 gate 输出', r.mainGate, r.mainRoot, tailN));
  return lines;
}

function finishReceipt(lines: string[]): string {
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * "进行中"回执：git merge 之前写出，正常结束（含回退、中断）时被最终结论覆盖。
 * 留在磁盘上说明 merge 被强行中断，主干可能停在未经 gate 的合并提交上；这里给出检查与手工回退命令。
 */
export function renderInProgressReceipt(r: MergeReport, mergeMessage: string, tailN: number = RECEIPT_TAIL_LINES): string {
  const root = r.mainRoot;
  const trackDir = r.trackPath && root ? relative(root, r.trackPath) : r.trackPath;
  const pre = r.preSha ?? '<合并前 sha>';
  const lines: string[] = [
    `# 合并回执：${r.track}`,
    '',
    '由 `bun run merge` 生成（计划 4.2）。',
    '',
    '| 项 | 值 |',
    '|---|---|',
    '| 结论 | **进行中**（merge 尚未结束；正常结束时这份回执会被最终结论覆盖） |',
    '| 说明 | 若 merge 已不在运行而回执仍是这份，说明它被强行中断，主干可能停在未经 gate 的合并提交上（处理办法见下） |',
    `| 轨道 | ${r.track}（工作树 ${code(trackDir)}） |`,
    `| 分支 | ${code(r.branch)} @ ${code(r.branchSha)} |`,
    `| 主干 | ${code(r.mainBranch)} |`,
    `| 合并前 sha | ${code(r.preSha)} |`,
    `| 合并提交信息 | ${mergeMessage} |`,
    `| 开始 | ${formatTime(r.startedAt)} |`,
    `| 工作树 gate | ${gateCell(r.worktreeGate)} |`,
    '| 主干 gate | 未运行 |',
    '',
    '## 若 merge 已不在运行而回执仍是这份',
    '',
    `\`bun run merge\` 被 kill -9、断电、容器回收等无法拦截的方式中断了，**主干可能停在未经 gate 的合并提交上**。` +
      `在主工作树 ${code(root)} 里：`,
    '',
    `1. 确认 merge 已退出：\`pgrep -af "merge.ts ${r.track}"\` 没有输出。`,
    '2. 检查主干：`git log -1 --format="%H %P %s"` 与 `git status`。',
    `   - HEAD 仍是 \`${pre}\`：没有合并，主干未动；若 \`git rev-parse -q --verify MERGE_HEAD\` 有输出（合并停在冲突里），运行 \`git merge --abort\`。`,
    `   - HEAD 是提交信息为"${mergeMessage}"、第一个父提交为 \`${pre}\` 的合并提交：它没有经过主干 gate，回退：` +
      `\`git reset --keep ${pre}\`（不会覆盖未提交改动与未跟踪文件；被拒绝时先把它列出的文件挪走再运行）。`,
    '   - 该合并提交之后又有别的提交：不要 reset，用 `git revert -m 1 <合并提交 sha>` 撤掉合并。',
    `3. 处理完后重新运行 \`bun run merge ${r.track}\`（会覆盖这份回执）。`,
    '',
    ...stepsSection(r),
    ...outputSections(r, tailN),
  ];
  return finishReceipt(lines);
}

/** 回执 Markdown（中文）。 */
export function renderReceipt(r: MergeReport, tailN: number = RECEIPT_TAIL_LINES): string {
  const root = r.mainRoot;
  const trackDir = r.trackPath && root ? relative(root, r.trackPath) : r.trackPath;
  const lines: string[] = [
    `# 合并回执：${r.track}`,
    '',
    '由 `bun run merge` 生成（计划 4.2）。',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 结论 | **${OUTCOME_TEXT[r.outcome]}**（退出码 ${r.exitCode}） |`,
    `| 说明 | ${(r.reason.split('\n')[0] ?? '').replace(/\|/g, '\\|')} |`,
    `| 轨道 | ${r.track}（工作树 ${code(trackDir)}） |`,
    `| 分支 | ${code(r.branch)} @ ${code(r.branchSha)} |`,
    `| 主干 | ${code(r.mainBranch)} |`,
    `| 合并前 sha | ${code(r.preSha)} |`,
    `| 合并后 sha | ${r.mergeSha ? `${code(r.mergeSha)}（合并提交${mergeShaNote(r)}）` : '—（没有产生合并提交）'} |`,
    `| 结束时主干 sha | ${code(r.finalSha)} |`,
    `| 开始 | ${formatTime(r.startedAt)} |`,
    `| 结束 | ${formatTime(r.endedAt)}（${formatDuration(r.endedAt.getTime() - r.startedAt.getTime())}） |`,
    `| 工作树 gate | ${gateCell(r.worktreeGate)} |`,
    `| 主干 gate | ${gateCell(r.mainGate)} |`,
    '',
    ...stepsSection(r),
  ];
  if (r.conflicts.length > 0) {
    lines.push('## 冲突文件', '', ...r.conflicts.map((f) => `- \`${f}\``), '');
  }
  if (r.warnings.length > 0) {
    lines.push('## 警告', '');
    for (const w of r.warnings) {
      const [first, ...rest] = w.split('\n');
      lines.push(`- ${first}`, ...rest.map((l) => `  ${l}`));
    }
    lines.push('');
  }
  lines.push(...outputSections(r, tailN));
  return finishReceipt(lines);
}

export const USAGE = [
  '用法：bun run merge <轨> [--quiet]',
  '',
  '  <轨>         轨道名，如 t1 → 工作树 .worktrees/task-t1',
  '  --quiet, -q  不实时转发 gate 输出（回执里照样有）',
  '',
  '在主工作树里运行：轨道工作树 gate → git merge --no-ff → 主干 gate → 红了回退；回执写到 review/receipt-<轨>.md。',
  'Ctrl-C / SIGTERM / SIGHUP（关终端）：等当前步骤结束后收尾（不再合并；已合并则回退）并写回执。',
  'git merge 之前先写"进行中"回执；merge 被 kill -9 等强行中断时留下的就是它，其中有检查与手工回退命令。',
  '退出码：0 已合并；1 未合并（工作树 gate 红）；2 拒绝执行；3 冲突已中止；4 已回退（主干 gate 红）；5 git merge 失败；',
  '        6 已中断（未合并）；7 主干 gate 红但未能自动回退（需手工处理）。',
].join('\n');

/** 命令行入口拦截的信号：收到后不立即退出，而是收尾（不再合并；已合并则回退）并写回执。 */
export const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export async function main(argv: readonly string[]): Promise<number> {
  const quiet = argv.includes('--quiet') || argv.includes('-q');
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  const rest = argv.filter((a) => a !== '--quiet' && a !== '-q');
  const unknown = rest.filter((a) => a.startsWith('-'));
  if (unknown.length > 0 || rest.length !== 1) {
    console.error(`[merge] ${unknown.length > 0 ? `未知参数 ${unknown.join(' ')}` : '需要且只需要一个轨道名'}\n\n${USAGE}`);
    return 2;
  }
  // Ctrl-C（SIGINT）与关终端 / SSH 断线（SIGHUP）都会发给整个前台进程组：gate 子进程随之退出（非 0），本进程
  // 不退出，而是按"工作树 gate 未过 / 主干 gate 红"收尾——不合并或回退，并写回执。否则主干可能停在一个没跑完
  // gate 的合并提交上，且没有回执。SIGHUP 之后终端已经没了，写 stdout / stderr 会出错（EIO / EPIPE），
  // 所以输出一律尽力而为：同步异常 try/catch，异步的 'error' 事件吞掉，都不影响收尾。吞错的监听器不移除：
  // 收尾之后到 process.exit 之间仍可能冒出写失败事件，没有监听器时 bun 会以退出码 1 结束，盖掉真正的退出码。
  const swallow = () => {};
  process.stdout.on('error', swallow);
  process.stderr.on('error', swallow);
  const safeWrite = (stream: NodeJS.WriteStream) => (s: string) => {
    try {
      stream.write(s);
    } catch {
      // 终端可能已关闭
    }
  };
  const out = safeWrite(process.stdout);
  const err = safeWrite(process.stderr);
  let interrupted: string | null = null;
  const onSignal = (sig: NodeJS.Signals) => {
    if (interrupted !== null) return;
    interrupted = sig;
    err(`\n[merge] 收到 ${sig}：等当前步骤结束后收尾（不再合并；已合并则回退）并写回执……\n`);
  };
  for (const sig of INTERRUPT_SIGNALS) process.on(sig, onSignal);
  try {
    const report = await runMerge({ track: rest[0]!, echo: !quiet, write: out, interrupted: () => interrupted });
    return report.exitCode;
  } finally {
    for (const sig of INTERRUPT_SIGNALS) process.off(sig, onSignal);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`[merge] 意外错误：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.exit(2);
    },
  );
}

