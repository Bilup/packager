/*
 * 压缩打包期生成的那份 JS。
 *
 * 这一步同时服务两个目标：
 *   1. 体积 —— 生成的代码是产物里最大的一块「逻辑」，压缩后普遍能省 30%~60%；
 *   2. 保护 —— 原始生成码里满是 `runtime.ext_scratch3_looks._say("plan 1", target)`
 *      这种自解释的调用，压缩 + 变量改名之后可读性大幅下降。
 *
 * ⚠️ 几个坑：
 *   - 源码是「一个括号包起来、求值为函数」的表达式。terser 的 `side_effects` 优化会
 *     把它当无副作用语句整条删掉，结果 code 为空 —— 必须关掉 `side_effects`。
 *   - 生成的代码里会引用一批来自 jsexecute「运行时光明」的自由变量
 *     （executeInCompatibilityLayer / compareEqual / isStuck / timer / retire …），
 *     它们是外部作用域的引用，terser 不会改名（toplevel 混淆默认关闭），所以安全。
 *   - 压完必须重新求值自检（compile.js 里做），万一真被压坏了就退回未压缩源码。
 *
 * 本文件用 CommonJS 写，便于 Node 直接 require 做回归测试。
 */

const DEFAULT_OPTIONS = {
  ecma: 2018,
  compress: {
    passes: 2,
    // 关键：不这么写整条表达式会被当成死代码删掉
    side_effects: false
  },
  mangle: true,
  // ⚠️ terser 4 的键名是 `output`，不是 `format`。
  //    传 `format` 不会报语法错，而是被当作未知选项塞进 result.error
  //    （DefaultsError: `format` is not a supported option），
  //    于是每次压缩都失败、静默退回未压缩源码。terser 5 才改名为 format。
  output: {
    comments: false,
    semicolons: true
  }
};

let cachedTerser = null;
let terserLoadFailed = null;

/** 懒加载 terser（它只在打包这些脚本时才需要） */
const getTerser = () => {
  if (cachedTerser) return cachedTerser;
  if (terserLoadFailed) throw terserLoadFailed;
  try {
    cachedTerser = require('terser');
  } catch (error) {
    terserLoadFailed = new Error(`找不到 terser，无法压缩预编译脚本：${(error && error.message) || error}`);
    throw terserLoadFailed;
  }
  return cachedTerser;
};

/** terser 是否可用（供打包器提前判断要不要提示用户） */
const isMinifierAvailable = () => {
  try {
    getTerser();
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * 造一个压缩函数。
 * @param {object} [options] 覆盖 DEFAULT_OPTIONS 中的字段（会做浅合并）
 * @returns {(source: string) => string}
 */
const createScriptMinifier = (options = {}) => (source) => {
  const terser = getTerser();
  // 调用方可能写 `format`（terser 5 的键名），统一归一化成 terser 4 的 `output`
  const outputOptions = {
    ...DEFAULT_OPTIONS.output,
    ...(options.output || {}),
    ...(options.format || {})
  };
  const merged = {
    ...DEFAULT_OPTIONS,
    ...options,
    compress: {...DEFAULT_OPTIONS.compress, ...(options.compress || {})},
    output: outputOptions
  };
  delete merged.format;
  const result = terser.minify(source, merged);
  if (result && result.error) throw result.error;
  const code = result && result.code;
  if (typeof code !== 'string' || code.length === 0) {
    throw new Error('压缩结果为空（表达式可能被当成死代码删除了）');
  }
  return code;
};

/** 字符串表在生成码里用的变量名（没什么含义，也不是关键字） */
const TABLE_NAME = '__s';

/** 把一个子节点在父节点上就地换掉（terser 这个打包版没带 TreeTransformer，只能自己来） */
const replaceChild = (parent, child, replacement) => {
  for (const key of Object.keys(parent)) {
    const value = parent[key];
    if (value === child) {
      try {
        parent[key] = replacement;
        return true;
      } catch (e) {
        return false;
      }
    }
    if (Array.isArray(value)) {
      const index = value.indexOf(child);
      if (index !== -1) {
        value[index] = replacement;
        return true;
      }
    }
  }
  return false;
};

/**
 * 把源码里的字符串字面量抽成一张表，代码里只留查表。
 *
 * 为什么值得做：编译产物里那些字面量恰恰是最有信息量的东西 ——
 * 变量 id（`N.variables["W\`0wtcC4n…"]`）、广播名、按键名、造型名、`说` 的文案。
 * 抽表之后逻辑体里只剩 `__s[1]`，一眼看不出在干什么。
 *
 * 表本身再做一层「反序存储 + 运行时翻回来」，这样在产物文件里
 * grep 作品文案/角色名也搜不到 —— 挡掉最常见的那种顺手一搜。
 *
 * ⚠️ `insertRuntime()` 是按「源码里有没有出现某个 helper 名」来决定注入哪些运行时函数的，
 *    所以前奏里用到的方法名（split/reverse/join/map）不能和 helper 撞名
 *    —— 实测这 36 个 helper 里没有这几个，是安全的。
 *
 * ⚠️ 变换后必须在调用方重新求值自检（scopedEval 出来还是不是函数），
 *    压坏了就退回压缩版源码。这里只负责变换，不负责验证。
 *
 * @param {string} minifiedSource 已经压缩过的源码（必须是「求值为函数」的表达式）
 * @returns {string|null} 变换后的源码；没有可抽的字符串时返回 null
 */
const scrambleStrings = (minifiedSource) => {
  const terser = getTerser();
  let ast;
  try {
    ast = terser.parse(minifiedSource);
  } catch (e) {
    return null;
  }

  const pairs = [];
  const strings = [];
  const seen = new Map();
  const walker = new terser.TreeWalker(function (node) {
    if (!(node instanceof terser.AST_String)) return;
    if (node.value === '') return;
    const parent = walker.parent();
    if (!parent) return;
    let index = seen.get(node.value);
    if (index === undefined) {
      index = strings.length;
      strings.push(node.value);
      seen.set(node.value, index);
    }
    pairs.push({node, parent, index});
  });
  ast.walk(walker);

  if (pairs.length === 0) return null;

  // 走完再改，避免边遍历边改结构
  let replaced = 0;
  for (const {node, parent, index} of pairs) {
    const replacement = new terser.AST_Sub({
      expression: new terser.AST_SymbolRef({name: TABLE_NAME}),
      property: new terser.AST_Number({value: index})
    });
    if (replaceChild(parent, node, replacement)) replaced += 1;
  }
  if (replaced === 0) return null;

  // 代码已经压缩过了，这一遍只做代码生成，不再跑 compress/mangle
  const printed = terser.minify(ast, {
    ecma: 2018,
    compress: false,
    mangle: false,
    output: {comments: false}
  });
  if (!printed || printed.error || typeof printed.code !== 'string') return null;
  // minify(ast) 会按「语句」加结尾分号，而我们要的是一个表达式
  const body = printed.code.replace(/;+\s*$/, '');
  if (!body) return null;

  const reversed = strings.map((value) => value.split('').reverse().join(''));
  // 整体仍是一个表达式：IIFE 求值出原来的工厂函数
  return `(()=>{const ${TABLE_NAME}=${JSON.stringify(reversed)}` +
    `.map(s=>s.split("").reverse().join(""));return (${body});})()`;
};

module.exports = {
  DEFAULT_OPTIONS,
  createScriptMinifier,
  scrambleStrings,
  isMinifierAvailable
};
