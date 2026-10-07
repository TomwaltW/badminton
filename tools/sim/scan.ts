/**
 * bun run sim:scan：确定性禁令的产物扫描（计划 2.2、派单 A 第 5 项）。
 *
 * 用 TypeScript 编译器 API 把文件解析成语法树再遍历，注释、字符串、正则、模板字符串的文字部分
 * 天然不会误报。拒绝：
 * - math-member：Math.<名字>，名字不在 abs/min/max/floor/ceil/trunc/round/sign/imul/fround 里
 *   （Math.random、Math.sqrt、Math.pow 与常量另有专门说明）；
 * - math-computed：Math[...] 计算属性访问（包括 Math['abs']，与 ESLint 禁令一致）；
 * - math-value：Math 不作为成员访问的对象出现（起别名、传参、const {sin} = Math、typeof Math、
 *   从对象里解构出名为 Math 的属性等），以及 x.Math / x['Math'] 后面不接禁用成员的情形（x.Math.floor、x.Math 本身）；
 * - pow / pow-assign：** 与 **=；
 * - date：Date 作为表达式被引用（Date.now()、new Date()、Date 本身、x instanceof Date），
 *   以及名为 Date 的成员访问与解构（x.Date、x?.Date、x['Date']、const { Date: D } = x）。
 *   对象字面量键、类成员声明、类型位置不报。
 * - global-computed：对全局对象做非字面量的计算属性访问（globalThis[k]、(c ? GameGlobal : globalThis)[k]、
 *   const { [k]: v } = globalThis）：成员名无法静态检查。
 * - parse：文件解析失败（扫不了的文件不能当作干净）。
 * 名为 Math / Date 的成员访问（x.Math、x['Math']、x?.Date、import D = ns.Date）不论 x 是什么一律报：
 * 全局对象可以先起别名（const root = …; root.Math.sin）或包在条件 / 逻辑 / 逗号表达式里，对象一侧无法静态判断。
 * 全局对象指 globalThis / self / window / global / GameGlobal、脚本顶层的 this、它们彼此的成员（window.self），
 * 以及条件 / 逻辑 / 逗号 / 赋值表达式包着的它们。
 * 遍历用显式栈，压缩产物里的超长逗号表达式不会爆栈。
 *
 * 用法：
 *   bun run sim:scan                  扫 packages/sim/dist/sim.js（不存在则提示先 bun run sim:build）
 *   bun run sim:scan <文件|目录> …     扫给定文件/目录（目录递归扫 .js/.cjs/.mjs/.ts，跳过 node_modules）
 *   bun run sim:scan --staged         扫 git 暂存区里的 packages/sim/src/**\/*.ts、packages/contracts/src/**\/*.ts
 *                                     （契约运行时代码会被打进 sim.js）与（若被暂存的）dist/sim.js
 * 有违规退出 1；参数错误退出 2。
 *
 * pre-commit 钩子直接 import 本文件的 scanStaged / formatViolation，导出的名字与签名不要改。
 * runCli 是 CLI 的主体（可注入 sim.js 路径、仓库根与输出，供测试调用）。
 */
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { REPO_ROOT, SIM_JS } from './paths';

export interface Violation {
  file: string;
  line: number;
  col: number;
  rule: string;
  message: string;
}

/** Math 上允许的成员（与 eslint.config.js 的 MATH_ALLOWED 一致）。 */
export const MATH_ALLOWED: ReadonlySet<string> = new Set([
  'abs',
  'min',
  'max',
  'floor',
  'ceil',
  'trunc',
  'round',
  'sign',
  'imul',
  'fround',
]);

/** 视为"全局对象"的标识符：经由它们访问 Math / Date 与直接访问同等对待。 */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['globalThis', 'self', 'window', 'global', 'GameGlobal']);

/** 目录递归扫描时收的扩展名。 */
const SCAN_EXTS = ['.js', '.cjs', '.mjs', '.ts'];

/** 暂存区扫描的范围：模拟核心与契约的源码（契约运行时代码会被打进 sim.js）、（若被暂存的）发布产物。 */
const STAGED_SRC_PREFIXES = ['packages/sim/src/', 'packages/contracts/src/'] as const;
const STAGED_DIST_JS = 'packages/sim/dist/sim.js';

const ALLOWED_TEXT = [...MATH_ALLOWED].join('/');

function mathMemberMessage(name: string): string {
  if (name === 'random') return 'Math.random 不确定：随机数一律用 rng.ts 的 xorshift32 流（rngNextU32 / rngNextUnit / rngNextRange）。';
  if (name === 'sqrt') return 'Math.sqrt 与 dsqrt 在约 25% 的输入上差 1 ulp，两者只能选一个：模拟核心一律用 dsqrt（计划 1.1、9.2 #4）。';
  if (name === 'pow') return 'Math.pow 在各引擎上不逐位一致：用连乘。';
  if (/^[A-Z][A-Z0-9_]*$/.test(name)) return `Math.${name} 不在允许清单里：常量请在源码里写成字面量。`;
  return `Math.${name} 不在允许清单（${ALLOWED_TEXT}）里：超越函数在 V8 与 JSC、arm64 与 x64 之间不逐位一致。`;
}

const MSG_COMPUTED = '禁止以计算属性访问 Math 成员（Math[...]）：成员名无法静态检查。';
const MSG_VALUE = '禁止把 Math 当作值使用（起别名、传参、解构等）：只许 Math.<允许的函数> 的直接成员访问。';
const MSG_DESTRUCTURE = '禁止从对象里解构出 Math：只许 Math.<允许的函数> 的直接成员访问。';
const MSG_POW = '禁止 **（实现相关的 pow）：用连乘。';
const MSG_POW_ASSIGN = '禁止 **=（实现相关的 pow）：用连乘。';
const MSG_DATE = '禁止 Date：时钟不确定，模拟核心只用 tick 计时。';
const MSG_MEMBER_MATH =
  "模拟核心里不应有名为 Math 的成员访问（x.Math、x['Math']，不论 x 是什么）：x 可能是全局对象的别名；只许直接写 Math.<允许的函数>。";
const MSG_MEMBER_DATE =
  "模拟核心里不应有名为 Date 的成员访问或解构（x.Date、x['Date']、const { Date: D } = x，不论 x 是什么）：x 可能是全局对象的别名；时钟不确定，模拟核心只用 tick 计时。";
const MSG_GLOBAL_COMPUTED = '禁止以非字面量的计算属性访问全局对象（globalThis[k] 等）：成员名无法静态检查。';

/** 按扩展名选 ScriptKind；未知扩展名按 JS 解析（构建产物多半是 .js）。 */
function scriptKindOf(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return ts.ScriptKind.TS;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/** 去掉不改变运行时值的外壳：括号、as、!、<T>x、satisfies。 */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isTypeAssertionExpression(n) ||
      ts.isSatisfiesExpression(n)
    ) {
      n = n.expression;
    } else {
      return n;
    }
  }
}

/** 从 node 往上越过外壳，返回最外层的那个表达式。 */
function outermost(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n.parent) ||
    ts.isAsExpression(n.parent) ||
    ts.isNonNullExpression(n.parent) ||
    ts.isTypeAssertionExpression(n.parent) ||
    ts.isSatisfiesExpression(n.parent)
  ) {
    n = n.parent;
  }
  return n;
}

/** 字面量表达式（字符串、无替换模板、数字）的值；标识符等非字面量返回 undefined（obj[k] 的 k 不是名字）。 */
function literalValue(node: ts.Expression): string | undefined {
  const n = unwrap(node);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return undefined;
}

/** 字面量形式的属性名（标识符、字符串、无替换模板、数字、[字面量]）；计算出来的名字返回 undefined。 */
function literalName(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return literalValue(node.expression);
  return undefined;
}

/**
 * this 是否取自脚本顶层（顶层 this 在脚本里就是全局对象）：从 this 往上直到源文件，只穿过箭头函数，
 * 不进入普通函数、方法、访问器、构造器的函数体，也不进入类字段初始化式与静态块（那里的 this 是实例或类）。
 * ES 模块顶层的 this 是 undefined，这里仍按全局对象处理（宁可误报）。
 */
function isTopLevelThis(node: ts.Node): boolean {
  let prev: ts.Node = node;
  for (let n = node.parent; !ts.isSourceFile(n); prev = n, n = n.parent) {
    if (ts.isFunctionLike(n) && !ts.isArrowFunction(n) && n.name !== prev) return false;
    if (ts.isClassStaticBlockDeclaration(n)) return false;
    if (ts.isPropertyDeclaration(n) && n.initializer === prev) return false;
  }
  return true;
}

/**
 * 表达式的值是否可能是全局对象：globalThis / self / window / global / GameGlobal、脚本顶层的 this、
 * 它们彼此的成员（window.self …），以及包着它们的条件表达式（任一分支）、|| / ?? / ||= / ??=（任一侧）、
 * && / &&=（右侧）、逗号与 =（右侧）。用显式栈，超长的 || 链不会爆栈。
 */
function isGlobalObject(expr: ts.Expression): boolean {
  const todo: ts.Expression[] = [expr];
  while (todo.length > 0) {
    const n = unwrap(todo.pop()!);
    if (n.kind === ts.SyntaxKind.ThisKeyword) {
      if (isTopLevelThis(n)) return true;
    } else if (ts.isIdentifier(n)) {
      if (GLOBAL_OBJECTS.has(n.text)) return true;
    } else if (ts.isPropertyAccessExpression(n)) {
      if (GLOBAL_OBJECTS.has(n.name.text)) todo.push(n.expression);
    } else if (ts.isElementAccessExpression(n)) {
      const name = literalValue(n.argumentExpression);
      if (name !== undefined && GLOBAL_OBJECTS.has(name)) todo.push(n.expression);
    } else if (ts.isConditionalExpression(n)) {
      todo.push(n.whenTrue, n.whenFalse);
    } else if (ts.isBinaryExpression(n)) {
      switch (n.operatorToken.kind) {
        case ts.SyntaxKind.BarBarToken:
        case ts.SyntaxKind.QuestionQuestionToken:
        case ts.SyntaxKind.BarBarEqualsToken:
        case ts.SyntaxKind.QuestionQuestionEqualsToken:
          todo.push(n.left, n.right);
          break;
        case ts.SyntaxKind.AmpersandAmpersandToken:
        case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
        case ts.SyntaxKind.CommaToken:
        case ts.SyntaxKind.EqualsToken:
          todo.push(n.right);
          break;
        default:
          break;
      }
    }
  }
  return false;
}

/** 成员访问的成员名：x.name → 'name'，x['name'] → 'name'；计算出来的名字返回 undefined。 */
function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  return ts.isPropertyAccessExpression(node) ? node.name.text : literalValue(node.argumentExpression);
}

/** QualifiedName 是否在一条会编译成运行时代码的 import X = a.b 里（import type X = … 不算）。 */
function inValueImportEquals(node: ts.QualifiedName): boolean {
  let n: ts.Node = node;
  while (ts.isQualifiedName(n.parent)) n = n.parent;
  return ts.isImportEqualsDeclaration(n.parent) && !n.parent.isTypeOnly && n.parent.moduleReference === n;
}

/**
 * 标识符是否处在"引用一个变量"的位置。属性名、对象字面量键、各种声明名、标签、导入导出说明符都不是。
 * 类型位置不会走到这里（遍历时整棵类型子树跳过）。
 */
function isReferenceIdentifier(id: ts.Identifier): boolean {
  const p = id.parent;
  switch (p.kind) {
    case ts.SyntaxKind.PropertyAccessExpression:
      return (p as ts.PropertyAccessExpression).name !== id;
    case ts.SyntaxKind.QualifiedName:
      return (p as ts.QualifiedName).left === id;
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.EnumMember:
      return (p as ts.NamedDeclaration).name !== id;
    case ts.SyntaxKind.BindingElement:
      // const { a: Date } = x 里的 a、Date 都是名字；默认值 = Date 是引用
      return (p as ts.BindingElement).initializer === id;
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.Parameter:
      return (p as ts.VariableDeclaration | ts.ParameterDeclaration).initializer === id;
    case ts.SyntaxKind.ImportEqualsDeclaration: {
      // import M = Math：esbuild 把它编成 var M = Math，右边是引用（import type M = … 编译后消失）
      const decl = p as ts.ImportEqualsDeclaration;
      return !decl.isTypeOnly && decl.moduleReference === id;
    }
    case ts.SyntaxKind.ExportSpecifier: {
      // export { Math as M }（没有 from）：本地一侧是引用；export { a as Math }、export { x } from '…'、
      // export type { … } 不是
      const spec = p as ts.ExportSpecifier;
      const decl = spec.parent.parent;
      return !spec.isTypeOnly && !decl.isTypeOnly && decl.moduleSpecifier === undefined && (spec.propertyName ?? spec.name) === id;
    }
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.TypeAliasDeclaration:
    case ts.SyntaxKind.EnumDeclaration:
    case ts.SyntaxKind.ModuleDeclaration:
    case ts.SyntaxKind.TypeParameter:
    case ts.SyntaxKind.ImportClause:
    case ts.SyntaxKind.ImportSpecifier:
    case ts.SyntaxKind.NamespaceImport:
    case ts.SyntaxKind.NamespaceExport:
    case ts.SyntaxKind.NamespaceExportDeclaration:
    case ts.SyntaxKind.LabeledStatement:
    case ts.SyntaxKind.BreakStatement:
    case ts.SyntaxKind.ContinueStatement:
    case ts.SyntaxKind.MetaProperty:
    case ts.SyntaxKind.JsxAttribute:
      return false;
    default:
      return true;
  }
}

/** 解构模式的来源表达式（const {…} = src / 参数默认值 / ({…} = src)）；拿不到返回 undefined。 */
function patternSource(pattern: ts.Node): ts.Expression | undefined {
  const p = pattern.parent;
  if (ts.isVariableDeclaration(p) || ts.isParameter(p)) return p.initializer;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === pattern) return p.right;
  return undefined;
}

/**
 * 对象字面量是否是解构赋值的目标：({ a } = x)、for ({ a } of xs)，以及嵌在目标里的
 * [{ a }] = xs、({ k: { a } } = x)、[...{ a }] = xs。
 */
function isAssignmentPattern(obj: ts.ObjectLiteralExpression): boolean {
  let n: ts.Expression = obj;
  for (;;) {
    n = outermost(n);
    const p = n.parent;
    if (ts.isBinaryExpression(p)) return p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === n;
    if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === n;
    if (ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p)) {
      n = p;
    } else if (ts.isPropertyAssignment(p) && p.initializer === n && ts.isObjectLiteralExpression(p.parent)) {
      n = p.parent;
    } else {
      return false;
    }
  }
}

/**
 * 解构模式（ObjectBindingPattern，或作解构赋值目标的对象字面量的最外层表达式）的值是否来自全局对象：
 * 直接来源是全局对象，或它嵌在以全局对象名为键、本身来自全局对象的外层模式里
 * （const { self: { Date: D } } = globalThis）。
 */
function patternFromGlobal(pattern: ts.Node): boolean {
  const src = patternSource(pattern);
  if (src !== undefined) return isGlobalObject(src);
  const p = pattern.parent;
  if (ts.isBindingElement(p) && p.name === pattern && ts.isObjectBindingPattern(p.parent)) {
    const key = literalName(p.propertyName);
    return key !== undefined && GLOBAL_OBJECTS.has(key) && patternFromGlobal(p.parent);
  }
  if (ts.isPropertyAssignment(p) && p.initializer === pattern && ts.isObjectLiteralExpression(p.parent)) {
    const key = literalName(p.name);
    return key !== undefined && GLOBAL_OBJECTS.has(key) && patternFromGlobal(outermost(p.parent));
  }
  return false;
}

/** 扫一段源码。fileName 只用来选解析方式（按扩展名）和填进 Violation.file。 */
export function scanSource(text: string, fileName: string): Violation[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  const out: Violation[] = [];

  const report = (node: ts.Node, rule: string, message: string): void => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file: fileName, line: pos.line + 1, col: pos.character + 1, rule, message });
  };

  // 解析失败：语法树可能缺块，不能当作干净。parseDiagnostics 是 TS 的内部字段，取不到就跳过。
  const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diags && diags.length > 0) {
    const d = diags[0]!;
    const pos = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    out.push({
      file: fileName,
      line: pos.line + 1,
      col: pos.character + 1,
      rule: 'parse',
      message: `解析失败（共 ${diags.length} 处）：${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
    });
  }

  /**
   * node 是一个 Math 引用（Math 标识符，或 x.Math、x['Math'] 这类名为 Math 的成员访问）：按它出现的位置判
   * member / computed / value。viaMember：经由成员访问拿到的 Math，即使后面是允许清单里的函数也报。
   */
  const checkMathRef = (node: ts.Expression, viaMember: boolean): void => {
    const outer = outermost(node);
    const p = outer.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === outer) {
      const name = p.name.text;
      if (!MATH_ALLOWED.has(name)) report(node, 'math-member', mathMemberMessage(name));
      else if (viaMember) report(node, 'math-value', MSG_MEMBER_MATH);
    } else if (ts.isElementAccessExpression(p) && p.expression === outer) {
      const name = literalValue(p.argumentExpression);
      report(node, 'math-computed', name === undefined ? MSG_COMPUTED : `${MSG_COMPUTED}（Math['${name}']）`);
    } else {
      report(node, 'math-value', viaMember ? MSG_MEMBER_MATH : MSG_VALUE);
    }
  };

  /**
   * 解构出的属性：名为 Math / Date 的不论来源一律报（来源可能是全局对象的别名）；
   * 计算出来的键（{ [k]: v }）在来源是全局对象时报 global-computed。
   */
  const checkDestructuredKey = (keyNode: ts.Node, pattern: ts.Node): void => {
    const key = literalName(keyNode);
    if (key === 'Math') report(keyNode, 'math-value', MSG_DESTRUCTURE);
    else if (key === 'Date') report(keyNode, 'date', MSG_MEMBER_DATE);
    else if (key === undefined && ts.isComputedPropertyName(keyNode) && patternFromGlobal(pattern)) {
      report(keyNode, 'global-computed', MSG_GLOBAL_COMPUTED);
    }
  };

  // 用显式栈遍历而不是递归：压缩产物里上万项的逗号表达式 / 连加是左深树，递归会爆栈。
  // 遍历顺序不影响结果（最后按位置排序）。
  const stack: ts.Node[] = [sf];
  const push = (child: ts.Node): void => {
    stack.push(child);
  };
  while (stack.length > 0) {
    const node = stack.pop()!;

    // 类型位置没有运行时语义，整棵跳过；唯一例外是 class … extends X 的 X（运行时表达式）。
    if (ts.isExpressionWithTypeArguments(node)) {
      const clause = node.parent;
      const isTypeOnly =
        ts.isHeritageClause(clause) &&
        (clause.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(clause.parent));
      if (!isTypeOnly) stack.push(node.expression);
      continue;
    }
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) continue;

    if (ts.isIdentifier(node)) {
      if ((node.text === 'Math' || node.text === 'Date') && isReferenceIdentifier(node)) {
        if (node.text === 'Math') checkMathRef(node, false);
        else report(node, 'date', MSG_DATE);
      }
      continue;
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      // 名为 Math / Date 的成员访问不论对象一律报；对全局对象的非字面量计算属性访问报 global-computed。
      const name = memberName(node);
      if (name === 'Math') checkMathRef(node, true);
      else if (name === 'Date') report(node, 'date', MSG_MEMBER_DATE);
      else if (name === undefined && ts.isElementAccessExpression(node) && isGlobalObject(node.expression)) {
        report(node, 'global-computed', MSG_GLOBAL_COMPUTED);
      }
    } else if (ts.isQualifiedName(node)) {
      // import D = ns.Date / import M = ns.Math：esbuild 编成 var D = ns.Date（类型位置的 QualifiedName 已整棵跳过）
      if ((node.right.text === 'Math' || node.right.text === 'Date') && inValueImportEquals(node)) {
        if (node.right.text === 'Math') report(node, 'math-value', MSG_MEMBER_MATH);
        else report(node, 'date', MSG_MEMBER_DATE);
      }
    } else if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken) report(node.operatorToken, 'pow', MSG_POW);
      else if (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken) {
        report(node.operatorToken, 'pow-assign', MSG_POW_ASSIGN);
      }
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      checkDestructuredKey(node.propertyName ?? node.name, node.parent);
    } else if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent) && isAssignmentPattern(node.parent)) {
      checkDestructuredKey(node.name, outermost(node.parent));
    }

    ts.forEachChild(node, push);
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  return out;
}

/** 递归收集目录下要扫的文件（按名字排序，跳过 node_modules 与 .git，不跟随目录符号链接以防成环）。 */
function collectDir(dir: string, out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      collectDir(p, out);
    } else if (e.isFile() || (e.isSymbolicLink() && statSync(p, { throwIfNoEntry: false })?.isFile() === true)) {
      if (SCAN_EXTS.some((ext) => e.name.endsWith(ext))) out.push(p);
    }
  }
}

/**
 * 扫给定的文件与目录。显式给出的文件不论扩展名都扫（构建产物可能改名）；目录递归扫 .js/.cjs/.mjs/.ts。
 * 路径不存在时抛错。Violation.file 用调用方给的路径拼出来的形式。
 */
export function scanFiles(paths: string[]): { files: number; violations: Violation[] } {
  const files: string[] = [];
  for (const p of paths) {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) throw new Error(`路径不存在：${p}`);
    if (st.isDirectory()) collectDir(p, files);
    else files.push(p);
  }
  const seen = new Set<string>();
  const violations: Violation[] = [];
  let count = 0;
  for (const f of files) {
    const key = resolve(f);
    if (seen.has(key)) continue;
    seen.add(key);
    count++;
    violations.push(...scanSource(readFileSync(f, 'utf8'), f));
  }
  return { files: count, violations };
}

function git(repoRoot: string, args: string[]): Buffer {
  // 不清理环境变量：pre-commit 里 git 会设 GIT_INDEX_FILE（例如 git commit -a），必须读它指向的索引。
  const r = spawnSync('git', args, { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`无法运行 git：${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr.toString('utf8').trim()}`);
  return r.stdout;
}

/** 暂存区里是否属于扫描范围。 */
function isStagedTarget(path: string): boolean {
  return (STAGED_SRC_PREFIXES.some((prefix) => path.startsWith(prefix)) && path.endsWith('.ts')) || path === STAGED_DIST_JS;
}

/**
 * 扫 git 暂存区（索引）里的内容，而不是工作树：只 git add 了一半的文件按暂存的那一半判。
 * 范围：git diff --cached --name-only --diff-filter=ACMR -z 列出的 packages/sim/src/**\/*.ts、
 * packages/contracts/src/**\/*.ts（契约运行时代码会被打进 sim.js），以及（若被暂存的）packages/sim/dist/sim.js。
 * Violation.file 是仓库内的相对路径。
 */
export function scanStaged(repoRoot: string): { files: number; violations: Violation[] } {
  const listed = git(repoRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0 && isStagedTarget(p))
    .sort();
  const violations: Violation[] = [];
  for (const path of listed) {
    const text = git(repoRoot, ['show', `:${path}`]).toString('utf8');
    violations.push(...scanSource(text, path));
  }
  return { files: listed.length, violations };
}

/** "path:line:col [rule] 说明"。 */
export function formatViolation(v: Violation): string {
  return `${v.file}:${v.line}:${v.col} [${v.rule}] ${v.message}`;
}

const USAGE = '用法：bun run sim:scan [--staged | <文件或目录> …]';

/** CLI 打印用的路径：在当前目录下的用相对路径，否则保持原样。 */
function displayPath(p: string): string {
  if (!isAbsolute(p)) return p;
  const rel = relative(process.cwd(), p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p;
}

export interface CliOptions {
  /** 无参数时扫的文件，默认 packages/sim/dist/sim.js（测试注入临时路径）。 */
  simJs?: string;
  /** --staged 用的仓库根，默认 scan.ts 所在的仓库（或工作树）根。 */
  repoRoot?: string;
  /** 标准输出 / 标准错误的一行（不含换行），默认 console.log / console.error。 */
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** CLI 主体；返回退出码：0 无违规，1 有违规或运行失败，2 参数错误。 */
export function runCli(argv: string[], opts: CliOptions = {}): number {
  const simJs = opts.simJs ?? SIM_JS;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const out = opts.out ?? ((s: string) => console.log(s));
  const err = opts.err ?? ((s: string) => console.error(s));
  if (argv.includes('-h') || argv.includes('--help')) {
    out(USAGE);
    return 0;
  }
  const staged = argv.includes('--staged');
  const rest = argv.filter((a) => a !== '--staged');
  const unknown = rest.filter((a) => a.startsWith('-'));
  if (unknown.length > 0 || (staged && rest.length > 0)) {
    err(`[sim:scan] 参数错误：${unknown.length > 0 ? `未知选项 ${unknown.join(' ')}` : '--staged 不能与路径同用'}`);
    err(USAGE);
    return 2;
  }

  let result: { files: number; violations: Violation[] };
  try {
    if (staged) {
      result = scanStaged(repoRoot);
    } else if (rest.length === 0) {
      if (!existsSync(simJs)) {
        err(`[sim:scan] 找不到 ${displayPath(simJs)}：先运行 bun run sim:build`);
        return 1;
      }
      result = scanFiles([simJs]);
    } else {
      result = scanFiles(rest);
    }
  } catch (e) {
    err(`[sim:scan] 失败：${(e as Error).message}`);
    return 1;
  }

  for (const v of result.violations) out(formatViolation({ ...v, file: displayPath(v.file) }));
  out(`[sim:scan] ${result.files} 个文件，${result.violations.length} 处违规`);
  return result.violations.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2)));
}
