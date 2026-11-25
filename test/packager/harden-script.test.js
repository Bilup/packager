/*
 * 结构硬化（hardenScript）的回归测试。
 *
 * 这一层是「产物里的 JS 还能不能被反编译工具还原成积木」的唯一屏障，
 * 所以每一条变换都要有断言钉住 —— 任何一条被悄悄改坏（或静默退回压缩版），
 * 保护就等于没有，而产物看起来完全正常，没有任何报错可循。
 *
 * 四条变换（详见 minify-script.js 文件头）：
 *   a. 字符串抽表        —— 字面量不再可搜索
 *   b. 属性名查表化      —— `X.ext_scratch3_looks._say` → `X[__s[a]][__s[b]]`
 *   c. helper 别名化     —— `executeInCompatibilityLayer(...)` → `_q0(...)`
 *   d. 切断 return 链    —— `return function*(…)` → `return [function*(…)][0]`
 */
import {createScriptMinifier, hardenScript} from '../../src/packager/protect/minify-script';

/** 与 jsgen 真实产出同形状的工厂（say + move + 循环 + 收尾 retire） */
const RAW = '(function factory0(thread) { const target = thread.target; ' +
  'const runtime = target.runtime; const stage = runtime.getTargetForStage();\n' +
  'const b0 = runtime.getOpcodeFunction("looks_sayforsecs");\n' +
  'return function* gen0 () {\n' +
  'yield* executeInCompatibilityLayer({"MESSAGE":"hello world","SECS":1,}, b0, false, false, "say", null);\n' +
  'runtime.ext_scratch3_motion._moveSteps(10, target);\n' +
  'for (var a0 = 4; a0 > 0; a0--) {\n' +
  'runtime.ext_scratch3_looks._say("x", target);\n' +
  'yield;\n' +
  '}\n' +
  'retire(); return;\n' +
  '}; })';

const minify = createScriptMinifier();
const HELPERS = ['executeInCompatibilityLayer', 'retire', 'startHats', 'toNotNaN'];

const harden = (source) => hardenScript(source, {helperNames: HELPERS});

test('hardening 后不能再从源码里看出任何「Scratch 编译器产物」的特征', () => {
  const out = harden(minify(RAW));
  expect(typeof out).toBe('string');
  // 扩展调用链（decompileExtCall / decompileTargetCall 的入口）
  expect(out).not.toContain('ext_scratch3_');
  expect(out).not.toContain('._say');
  expect(out).not.toContain('._moveSteps');
  // 按 opcode 取函数（decompileCall 的入口）
  expect(out).not.toContain('.getOpcodeFunction(');
  expect(out).not.toContain('.getTargetForStage(');
  // 按名字认自由变量（decompileCall 的另一条入口）
  expect(out).not.toContain('yield*executeInCompatibilityLayer');
  // 「return 一个函数」是 extractFunctionInfo 定位脚本体的唯一强特征
  expect(out).not.toMatch(/return\s+function/);
});

test('hardening 后仍是可求值的函数，且语义完全不变', () => {
  const out = harden(minify(RAW));
  // 源码里引用的 helper 是「运行时光明变量」（jsexecute 的 insertRuntime 负责注入）。
  // 这里在测试作用域里把它们补上 —— 顺便证明别名化之后仍然解析得到正确的外部绑定。
  /* eslint-disable no-unused-vars */
  // 真实现会返回一个 generator（编译产物里是 `yield* executeInCompatibilityLayer(...)`）
  const executeInCompatibilityLayer = function* () {};
  const retire = () => {};
  const startHats = () => {};
  const toNotNaN = (n) => n;
  /* eslint-enable no-unused-vars */
  // eslint-disable-next-line no-eval
  const factory = eval(out);
  expect(typeof factory).toBe('function');

  const calls = [];
  const target = {
    runtime: {
      getTargetForStage: () => ({}),
      getOpcodeFunction: () => () => {},
      ext_scratch3_motion: {_moveSteps: (steps, t) => calls.push(['move', steps, t])},
      ext_scratch3_looks: {_say: (text, t) => calls.push(['say', text, t])}
    }
  };
  const thread = {target};
  const generator = factory(thread)();
  for (const step of generator) void step;

  expect(calls.map((c) => c.slice(0, 2))).toEqual([
    ['move', 10],
    ['say', 'x'], ['say', 'x'], ['say', 'x'], ['say', 'x']
  ]);
});

test('字符串表存的是反序串（产物里 grep 不到文案原文）', () => {
  const out = harden(minify(RAW));
  expect(out).not.toContain('hello world');
  expect(out).toContain('dlrow olleh');
  expect(out).toMatch(/__s\[|__t\[/);
});

test('helper 的原名必须留在源码里（insertRuntime 靠 includes 决定注入哪些 helper）', () => {
  const out = harden(minify(RAW));
  // 名字出现在前奏的别名赋值里，但调用点已经换成了短名
  expect(out).toContain('executeInCompatibilityLayer');
  expect(out).toMatch(/_q\d+=executeInCompatibilityLayer/);
  // 反例：如果原地把名字抹掉，insertRuntime 不会注入 → 运行时 undefined
  expect(out).not.toContain('yield*executeInCompatibilityLayer({');
});

test('顶层是一个数组取值表达式（不是裸的 IIFE 调用）', () => {
  // 解包器 extractFunctionInfo 的第三条兜底专门抓「顶层 = CallExpression、callee = 函数」，
  // 裸 IIFE 正好命中它并产出占位块。套一层 [ … ][0] 之后这条兜底就落空了。
  const out = harden(minify(RAW));
  expect(out.startsWith('[(')).toBe(true);
  expect(out.endsWith('][0]') || out.endsWith('][0];')).toBe(true);
});

test('没有可硬化内容时返回 null（调用方据此保留压缩版，不计为失败）', () => {
  expect(harden('(function(t){return function*(){var x=1;return x}})')).not.toBeNull();
  // 只有短 ASCII 字面量、没有敏感属性访问、return 也不是函数 —— 无事可做
  expect(harden('(function(){return 1+2})')).toBeNull();
});

test('hardening 是幂等的安全网：坏输入返回 null 而不是抛错', () => {
  expect(harden('this is not javascript at all (')).toBeNull();
});
