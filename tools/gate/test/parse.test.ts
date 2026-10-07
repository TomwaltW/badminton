/** gate 输出解析器与排版小工具的单测（样本取自 bun 1.4.2、ESLint 10、tsc 5.9 与本仓库工具的真实输出格式）。 */
import { describe, expect, test } from 'bun:test';
import {
  clip,
  formatBunTest,
  parseBunTest,
  parseContractsCheck,
  parseDet,
  parseEslint,
  parseSimBuild,
  parseSimScan,
  parseTsc,
} from '../parse';
import { displayWidth, formatCmd, formatDuration, renderTable, stripAnsi, tailLines } from '../run';

const ESC = String.fromCharCode(27);

describe('parseBunTest', () => {
  test('全部通过', () => {
    const out = ['bun test v1.4.2 (744846f84)', '', ' 4 pass', ' 0 fail', ' 4 expect() calls', 'Ran 4 tests across 4 files. [6.00ms]', ''].join('\n');
    expect(parseBunTest(out)).toEqual({ pass: 4, fail: 0, skip: 0, todo: 0, errors: 0, expectCalls: 4, tests: 4, files: 4 });
  });

  test('有失败、跳过、待办与测试间错误；单数形式', () => {
    const out = [
      'tools/b/test/e.test.ts:',
      '# Unhandled error between tests',
      'error: load boom',
      '(fail) f [0.38ms]',
      '',
      ' 3 pass',
      ' 1 skip',
      ' 1 todo',
      ' 2 fail',
      ' 1 error',
      ' 3 expect() calls',
      'Ran 7 tests across 4 files. [6.00ms]',
    ].join('\n');
    expect(parseBunTest(out)).toEqual({ pass: 3, fail: 2, skip: 1, todo: 1, errors: 1, expectCalls: 3, tests: 7, files: 4 });
    expect(parseBunTest(' 1 pass\n 0 fail\nRan 1 test across 1 file. [3.00ms]\n')).toMatchObject({ pass: 1, tests: 1, files: 1 });
  });

  test('取最后一次出现的摘要（测试自己打印的同形行在前面）；带颜色也能解析', () => {
    const out = ` 99 pass\n 99 fail\n...\n${ESC}[32m 5 pass${ESC}[0m\n${ESC}[31m 1 fail${ESC}[0m\nRan 6 tests across 2 files. [1.00ms]\n`;
    expect(parseBunTest(out)).toMatchObject({ pass: 5, fail: 1, tests: 6, files: 2 });
  });

  test('没有摘要 → null', () => {
    expect(parseBunTest('error: Test filter "./x" had no matches\n')).toBeNull();
  });

  test('formatBunTest', () => {
    expect(formatBunTest({ pass: 120, fail: 0, skip: 0, todo: 0, errors: 0, expectCalls: 500, tests: 120, files: 30 })).toBe(
      '120 通过 / 0 失败（120 条，30 个文件）',
    );
    expect(formatBunTest({ pass: 3, fail: 2, skip: 1, todo: 0, errors: 1, expectCalls: null, tests: 6, files: 2 })).toBe(
      '3 通过 / 2 失败（6 条，2 个文件；1 跳过、1 个测试间错误）',
    );
  });
});

describe('其他解析器', () => {
  test('parseEslint', () => {
    expect(parseEslint('')).toEqual({ problems: 0, errors: 0, warnings: 0 });
    expect(parseEslint('/a.ts\n  1:1  error  x  rule\n\n✖ 5 problems (4 errors, 1 warning)\n')).toEqual({
      problems: 5,
      errors: 4,
      warnings: 1,
    });
    expect(parseEslint('✖ 1 problem (1 error, 0 warnings)\n')).toEqual({ problems: 1, errors: 1, warnings: 0 });
  });

  test('parseTsc', () => {
    expect(parseTsc('')).toBe(0);
    expect(
      parseTsc(
        "tools/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
          "tools/b.ts(1,1): error TS6133: 'x' is declared but its value is never read.\n",
      ),
    ).toBe(2);
  });

  test('parseContractsCheck：contracts:gen --check 的一致 / 不一致结论行', () => {
    expect(
      parseContractsCheck('$ bun packages/contracts/scripts/gen-snapshot-offsets.ts --check\ncontracts:gen --check：packages/contracts/src/gen/snapshot-offsets.ts 与 schema 一致（I32 38 槽，F64 96 槽）\n'),
    ).toEqual({ upToDate: true, i32: 38, f64: 96 });
    expect(
      parseContractsCheck('contracts:gen --check：snapshot-offsets.ts 与 snapshot.schema.ts 不一致或缺失；请运行 bun run contracts:gen 并提交生成文件\nerror: script "contracts:gen" exited with code 1\n'),
    ).toEqual({ upToDate: false, i32: null, f64: null });
    expect(parseContractsCheck('error: Script not found "contracts:gen"\n')).toBeNull();
  });

  test('parseSimBuild / parseSimScan', () => {
    expect(parseSimBuild('[sim:build] packages/sim/dist/sim.js  48213 字节  simVer=0a1b2c3d\n[sim:build] packages/sim/dist/sim.d.ts\n')).toEqual({
      simVer: '0a1b2c3d',
      bytes: 48213,
    });
    expect(parseSimBuild('[sim:build] 失败：esbuild 失败\n')).toBeNull();
    expect(parseSimScan('[sim:scan] 1 个文件，0 处违规\n')).toEqual({ files: 1, violations: 0 });
    expect(parseSimScan('x.js:1:1 [math-member] …\n[sim:scan] 1 个文件，3 处违规\n')).toEqual({ files: 1, violations: 3 });
  });

  test('parseDet', () => {
    const out = '[det] …\n\n结论：通过——linux 档 3 个引擎（node、bun、bun-nojit）在 dsqrt 路径与 Math.sqrt 路径上各自逐位一致\nDET efc2c7f7 98311\n';
    expect(parseDet(out)).toEqual({
      conclusion: '通过——linux 档 3 个引擎（node、bun、bun-nojit）在 dsqrt 路径与 Math.sqrt 路径上各自逐位一致',
      hash: 'efc2c7f7',
      steps: '98311',
    });
    expect(parseDet('[det] 找不到 packages/sim/dist/sim.js\n')).toBeNull();
    expect(parseDet('结论：失败——1 个引擎失败（bun）\nDET - -\n')).toMatchObject({ hash: '-', steps: '-' });
  });
});

describe('排版小工具', () => {
  test('stripAnsi 与 \\r\\n', () => {
    expect(stripAnsi(`${ESC}[1m${ESC}[31m红${ESC}[0m\r\n`)).toBe('红\n');
  });

  test('tailLines', () => {
    expect(tailLines('', 3)).toEqual({ text: '', total: 0, truncated: false });
    expect(tailLines('a\nb\n', 3)).toEqual({ text: 'a\nb', total: 2, truncated: false });
    expect(tailLines('1\n2\n3\n4\n5\n', 2)).toEqual({ text: '4\n5', total: 5, truncated: true });
  });

  test('formatDuration', () => {
    expect(formatDuration(432)).toBe('0.4 秒');
    expect(formatDuration(12345)).toBe('12.3 秒');
    expect(formatDuration(125000)).toBe('2 分 5.0 秒');
    expect(formatDuration(59960)).toBe('1 分 0.0 秒');
    expect(formatDuration(119970)).toBe('2 分 0.0 秒');
  });

  test('displayWidth 与 renderTable：中文按 2 列对齐', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('通过')).toBe(4);
    expect(displayWidth('（，）')).toBe(6);
    const lines = renderTable(
      [
        ['步骤', '结果', '耗时'],
        ['tsc -b', '通过', '1.0 秒'],
        ['bun test', '失败', '12.3 秒'],
      ],
      new Set([2]),
    );
    expect(lines).toEqual(['步骤      结果     耗时', '--------  ----  -------', 'tsc -b    通过   1.0 秒', 'bun test  失败  12.3 秒']);
  });

  test('formatCmd 与 clip', () => {
    expect(formatCmd(['bun', 'run', 'det', '--kernel'])).toBe('bun run det --kernel');
    expect(formatCmd([process.execPath, 'run', 'gate'])).toBe('bun run gate');
    expect(formatCmd(['sh', '-c', "echo 'a b'"])).toBe(`sh -c 'echo '\\''a b'\\'''`);
    expect(clip('一二三四五', 10)).toBe('一二三四五');
    expect(clip('一二三四五', 3)).toBe('一二…');
  });
});
