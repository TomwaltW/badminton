/**
 * gate 与 merge 共用的小工具：跑子进程（实时转发 + 完整捕获）、去 ANSI、取尾部、计时与中文表格排版。
 * 只依赖 node 内置模块，bun 与 node 下都能用。
 */
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

export interface RunOptions {
  cwd: string;
  /** 子进程环境；省略则继承当前进程的环境。 */
  env?: NodeJS.ProcessEnv;
  /** 每收到一块输出（stdout 与 stderr 按到达顺序合并）就回调一次；用于实时打印。 */
  onOutput?: (chunk: string) => void;
  /** 超时（毫秒）；到时先 SIGTERM，5 秒后仍未退出再 SIGKILL。省略 = 不限时。 */
  timeoutMs?: number;
}

export interface RunResult {
  /** 退出码：正常退出取进程退出码；被信号杀死取 128 + 信号值；无法启动取 127。 */
  exitCode: number;
  signal: string | null;
  /** stdout 与 stderr 按到达顺序合并的完整输出。 */
  output: string;
  durationMs: number;
  timedOut: boolean;
  /** 无法启动等错误的说明（同时也追加在 output 末尾）。 */
  error: string | null;
}

/** 跑一条命令（不经 shell），stdin 关闭，stdout/stderr 合并捕获。永不抛错。 */
export function runCommand(cmd: readonly string[], opts: RunOptions): Promise<RunResult> {
  const t0 = performance.now();
  return new Promise((resolvePromise) => {
    const chunks: string[] = [];
    let settled = false;
    let timedOut = false;
    let error: string | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let hardKillTimer: ReturnType<typeof setTimeout> | null = null;

    const push = (s: string) => {
      if (s.length === 0) return;
      chunks.push(s);
      opts.onOutput?.(s);
    };
    const finish = (exitCode: number, signal: string | null) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      resolvePromise({
        exitCode,
        signal,
        output: chunks.join(''),
        durationMs: performance.now() - t0,
        timedOut,
        error,
      });
    };

    if (cmd.length === 0) {
      error = '命令为空';
      push(`[run] ${error}\n`);
      finish(127, null);
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd[0]!, cmd.slice(1), {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      error = `无法启动 ${cmd[0]}：${(e as Error).message}`;
      push(`[run] ${error}\n`);
      finish(127, null);
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (s: string) => push(s));
    child.stderr?.on('data', (s: string) => push(s));

    child.on('error', (e: NodeJS.ErrnoException) => {
      error = e.code === 'ENOENT' ? `找不到可执行文件 ${cmd[0]}（ENOENT）` : `无法启动 ${cmd[0]}：${e.message}`;
      push(`[run] ${error}\n`);
      finish(127, null);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== null) finish(code, null);
      else if (signal !== null) {
        const num = (osConstants.signals as Record<string, number>)[signal] ?? 0;
        finish(128 + num, signal);
      } else finish(1, null);
    });

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        push(`\n[run] 超时（${formatDuration(opts.timeoutMs!)}），终止进程\n`);
        child.kill('SIGTERM');
        hardKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }, opts.timeoutMs);
    }
  });
}

// ESC 用 fromCharCode 拼出来，正则字面量里不出现控制字符。
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/** 去掉 ANSI 颜色与光标控制序列，并把 \r\n 统一成 \n。 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r\n/g, '\n');
}

/** 取最后 n 行；返回 { text, total, truncated }。末尾换行不算一行。 */
export function tailLines(s: string, n: number): { text: string; total: number; truncated: boolean } {
  const body = s.endsWith('\n') ? s.slice(0, -1) : s;
  if (body.length === 0) return { text: '', total: 0, truncated: false };
  const lines = body.split('\n');
  if (lines.length <= n) return { text: body, total: lines.length, truncated: false };
  return { text: lines.slice(lines.length - n).join('\n'), total: lines.length, truncated: true };
}

/** 中文耗时：0.4 秒、12.3 秒、2 分 5.0 秒。 */
export function formatDuration(ms: number): string {
  // 先舍入到 0.1 秒再分分钟，免得 59.96 秒显示成"60.0 秒"
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} 秒`;
  const m = Math.floor(tenths / 600);
  return `${m} 分 ${((tenths - m * 600) / 10).toFixed(1)} 秒`;
}

/** 终端显示宽度：CJK 与全角字符算 2 列，其余算 1 列。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function padTo(s: string, width: number, right: boolean): string {
  const pad = ' '.repeat(Math.max(0, width - displayWidth(s)));
  return right ? pad + s : s + pad;
}

/**
 * 把二维表格排成等宽文本（第一行是表头，下面画一条分隔线）。
 * rightAlign 里的列号右对齐（数字列）。
 */
export function renderTable(rows: readonly (readonly string[])[], rightAlign: ReadonlySet<number> = new Set()): string[] {
  if (rows.length === 0) return [];
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) widths.push(Math.max(...rows.map((r) => displayWidth(r[c] ?? ''))));
  const line = (r: readonly string[]) =>
    widths
      .map((w, c) => padTo(r[c] ?? '', w, rightAlign.has(c)))
      .join('  ')
      .replace(/\s+$/, '');
  const out = [line(rows[0]!), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const r of rows.slice(1)) out.push(line(r));
  return out;
}

/** 当前的 bun 可执行文件：在 bun 里运行时就是 process.execPath，否则从 PATH 找 bun。 */
export function bunBin(): string {
  return process.versions.bun ? process.execPath : 'bun';
}

/** 把命令行拼成便于阅读的字符串（含空格或特殊字符的参数加单引号；当前的 bun 可执行文件显示为 bun）。 */
export function formatCmd(cmd: readonly string[]): string {
  return cmd
    .map((a, i) => (i === 0 && process.versions.bun && a === process.execPath ? 'bun' : a))
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}
