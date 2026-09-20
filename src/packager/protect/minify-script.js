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

module.exports = {
  DEFAULT_OPTIONS,
  createScriptMinifier,
  isMinifierAvailable
};
