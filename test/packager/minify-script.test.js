/*
 * 打包期压缩（terser）的可用性回归测试。
 *
 * 冲着一次真实的退化写的：仓库从 npm 迁到 pnpm 之后，pnpm 的严格 node_modules 布局
 * 不再把传递依赖提升到顶层，而 `terser` **从来没写进 package.json** ——
 * 它只是某个包的传递依赖。于是：
 *
 *   - 每次构建都报 `Module not found: Error: Can't resolve 'terser'`（但退出码仍是 0，很容易被忽略）
 *   - `isMinifierAvailable()` 变 false → 预编译脚本**静默不压缩**
 *     （实测索引因此大了 24%，而且编译后的逻辑更易读，等于保护被削了一档）
 *   - 只有在打包时才推一条 `环境里找不到 terser…` 的警告，平时完全看不出来
 *
 * 所以这里钉住「装好依赖之后 terser 必须真的可用、且压缩真的能跑通」，
 * 而不是只断言「代码里写了 isMinifierAvailable」。
 */
import {
  isMinifierAvailable,
  createScriptMinifier,
  scrambleStrings
} from '../../src/packager/protect/minify-script';

// 一个形态与「编译器生成的脚本工厂」一致的样本：外面一层括号、求值为函数
const SAMPLE = '(function factory0(thread) { return function* () { ' +
  'var unusedLocalName = 1; var anotherUnusedOne = 2; return thread.x + 3; }; })';

test('terser 必须真的可用（它是 package.json 的依赖，不是可选能力）', () => {
  // 这条断言很朴素，但正是它本该早点出现：terser 之前在 package.json 里**根本没声明**，
  // 只是某个包的传递依赖；pnpm 的严格布局不会把它提升到顶层，
  // 于是 isMinifierAvailable() 一直悄悄返回 false。
  expect(isMinifierAvailable()).toBe(true);
});

test('压缩真的生效：冗余的局部变量会被消掉', () => {
  const minify = createScriptMinifier();
  const output = minify(SAMPLE);
  expect(typeof output).toBe('string');
  expect(output.length).toBeGreaterThan(0);
  expect(output).not.toContain('unusedLocalName');
  expect(output).not.toContain('anotherUnusedOne');
  expect(output.length).toBeLessThan(SAMPLE.length);
});

test('压缩后仍然求值出函数（包住的那层括号没被 terser 当成死代码删掉）', () => {
  const minify = createScriptMinifier();
  const output = minify(SAMPLE);
  // 与打包期同样的自检方式：压缩结果必须还能求值出一个函数
  // eslint-disable-next-line no-eval
  expect(typeof eval(output)).toBe('function');
});

test('误传 terser 5 的 `format` 键名会被归一化成 terser 4 的 `output`（回归）', () => {
  // 传 `format` 时 terser 4 会把它当未知选项塞进 result.error，导致压缩静默失败
  const minify = createScriptMinifier({format: {comments: false, semicolons: true}});
  const output = minify(SAMPLE);
  expect(typeof output).toBe('string');
  expect(output.length).toBeLessThan(SAMPLE.length);
});

test('字符串表混淆：抽掉字符串表后仍是可求值出函数的表达式', () => {
  // 用真实编译产物那种形态（变量 + 字符串拼接）。
  // 注意：字符串直接写在 `return "x"` 里的形态它抽不动，会返回 null —— 那是既定契约，
  // 调用方会退回压缩版（见下一条用例）。
  const minified = createScriptMinifier()(
    '(function f(thread) { return function* () { return thread.lookup("someName") + "suffix"; }; })'
  );
  const scrambled = scrambleStrings(minified);

  expect(typeof scrambled).toBe('string');
  // 字符串被抽进表里并反转存放，明文里不该还能直接搜到
  expect(scrambled).not.toContain('someName');
  expect(scrambled).not.toContain('suffix');
  // 变换后必须仍能求值出函数（调用方靠这条自检决定要不要接受变换结果）
  // eslint-disable-next-line no-eval
  expect(typeof eval(scrambled)).toBe('function');
});

test('没有可抽的字符串时返回 null（调用方据此退回压缩版，不丢压缩成果）', () => {
  const minified = createScriptMinifier()(
    '(function f() { return function* () { return 1 + 2; }; })'
  );
  expect(scrambleStrings(minified)).toBeNull();
});
