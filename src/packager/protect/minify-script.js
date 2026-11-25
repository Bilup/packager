/*
 * 打包期脚本「结构硬化」。
 *
 * 这一步同时服务两个目标：
 *   1. 体积 —— 生成的代码是产物里最大的一块「逻辑」，压缩后普遍能省 30%~60%；
 *   2. 保护 —— 原始生成码里满是 `runtime.ext_scratch3_looks._say("plan 1", target)`
 *      这种自解释的调用。但**光靠压缩/改名是没用的**：现成的解包器不靠名字认东西，
 *      它靠「代码形状」+ 别名推断（`const t = r.runtime` 能被自动认回 runtime）。
 *      所以这里做的是**改形状**，四件事：
 *
 *        a. 字符串抽表        —— 让字面量（变量 id / 文案 / 广播名）不再可搜索
 *        b. 属性名查表化      —— `X.ext_scratch3_looks._say` → `X[__s[a]][__s[b]]`
 *                                （解包器的 getPropName 对计算成员返回 null，一招收掉
 *                                 decompileExtCall / decompileTargetCall / decompileMember）
 *        c. helper 别名化     —— `retire()` → `_q3()`
 *                                （decompileCall 是按**自由变量名**硬匹配的）
 *        d. 切断 return 链    —— `return function*(){…}` → `return [function*(){…}][0]`
 *                                （解包器的 extractFunctionInfo 只认「return 一个函数」；
 *                                  改完之后脚本连占位块都不产生，是「从有到无」的质变）
 *
 * ⚠️ 几个坑（都是踩过的）：
 *   - 源码是「一个括号包起来、求值为函数」的表达式。terser 的 `side_effects` 优化会
 *     把它当无副作用语句整条删掉，结果 code 为空 —— 必须关掉 `side_effects`。
 *   - 生成的代码里会引用一批来自 jsexecute「运行时光明」的自由变量
 *     （executeInCompatibilityLayer / compareEqual / isStuck / timer / retire …）。
 *     terser 不会给它们改名（toplevel 混淆默认关闭），所以别名化必须我们自己做。
 *   - **别名化不能把原名字从源码里抹干净**：`jsexecute.js` 的 `insertRuntime()` 是靠
 *     `source.includes(functionName)` 决定注入哪些 helper 的。所以前奏里保留
 *     `const _q0 = executeInCompatibilityLayer` 这一句 —— 原名字还在，注入照旧，
 *     但函数体里所有调用点都变成了 `_q0(...)`。
 *   - 变换后必须在调用方重新求值自检（scopedEval 出来还是不是函数），
 *     坏掉就退回上一版（compile.js 的 minifyWithFallback 已经这么做了）。
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

/** 字符串表 / 属性名表在生成码里用的变量名（没什么含义，也不是关键字） */
const TABLE_NAME = '__s';

/** helper 别名的前缀（terser 的 mangle 不会产生这种形状，不会撞名） */
const ALIAS_PREFIX = '_q';

/**
 * jsexecute 注入的运行时 helper（自由变量）。
 *
 * 来源：`scratch-vm/src/compiler/jsexecute.js` 的 `runtimeFunctions` 键
 *       + `baseRuntime` 里声明的 `isStuck` / `compareEqual` / `listIndex`。
 * 这几个名字是解包器 `decompileCall` 用来「认出这是哪种积木」的全部线索，
 * 所以改掉它们等于把这块的识别能力整体废掉。
 *
 * ⚠️ 只对**源码里真的出现过、且没有被本函数声明过**的名字做别名 ——
 *    给一个不存在的名字写 `const _q0 = xxx` 会直接 ReferenceError。
 */
const HELPER_NAMES = [
  'startHats', 'waitThreads', 'executeInCompatibilityLayer', 'createBranchInfo',
  'retire', 'toNotNaN', 'toBoolean', 'limitPrecision',
  'compareGreaterThan', 'compareLessThan', 'compareEqual',
  'randomInt', 'randomFloat', 'timer', 'isStuck', 'daysSince2000', 'distance',
  'listGet', 'listReplace', 'listInsert', 'listDelete', 'listContains',
  'listIndexOf', 'listContents', 'listLength', 'listAdd', 'listSet',
  'listShow', 'listHide', 'listClear', 'listIndex',
  'repeatString', 'replaceString', 'colorToList',
  'mod', 'modP2', 'tan',
  'yieldThenCall', 'yieldThenCallGenerator',
  'getListContents', 'getListIndex', 'hasResumedFromPromise'
];

/** 解包器靠这些**属性名**认积木（decompileExtCall / decompileTargetCall / decompileMember / ioDevice） */
const SENSITIVE_PROPS = new Set([
  // 运行时的入口属性
  'runtime', 'target', 'stage', 'thread', 'threads', 'sprite',
  'procedures', 'getOpcodeFunction', 'getAddonBlock', 'getTargetForStage',
  'extensionManager', 'targets', 'sequencer', 'renderer', 'requestRedraw',
  'disposeTarget', 'startHats', 'stopForTarget', 'createClone',
  'lookupVariableById', 'lookupOrCreateList',
  'ioDevices', 'mouse', 'keyboard', 'clock', 'video',
  'stageWidth', 'stageHeight', 'emit', 'requestRedraw',
  // 目标状态（decompileMember 直接读这些）
  'effects', 'currentCostume', 'costumes', 'sounds', 'variables', 'lists',
  'blocks', 'monitors', 'monitorBlocks', 'draggable', 'rotationStyle',
  'x', 'y', 'direction', 'size', 'visible',
  // 目标方法（decompileTargetCall 直接认这些）
  'setEffect', 'setXY', 'setX', 'setY', 'setDirection', 'setSize',
  'setVisible', 'setCostume', 'setRotationStyle',
  'goToFront', 'goToBack', 'goForwardLayers', 'goBackwardLayers',
  'clearEffects', 'clampEffect', 'setPenState', 'getPenState',
  'isTouchingColor', 'colorIsTouchingColor', 'isTouchingObject',
  'getScratchX', 'getScratchY', 'getKeyIsDown', 'getIsDown',
  'getLastKeyPressed', 'getUsername',
  'timer', 'daysSince2000'
]);

/** 属性名里凡是这两个前缀的一律查表化（`ext_scratch3_looks` / `_say` / `_moveSteps` …） */
const SENSITIVE_PREFIXES = ['ext_', '_'];

/**
 * 字符串进表的最小长度。
 *
 * `"abcd"`（6 字符）换成 `__s[0]`（6 字符）不赚；更短的（`"x"` / `"say"`）反而亏。
 * 而真正有信息量、真正需要藏起来的（变量 id、广播名、造型名、对白文案）基本都远长于这个阈值。
 * 所以短串留原样：既省体积，也不影响我们要保护的东西。
 */
const MIN_TABLE_STRING_LENGTH = 5;

/** 非 ASCII（中文文案、emoji…）一律进表：它们才是最能暴露作品内容的字面量 */
const NON_ASCII_RE = /[^\x00-\x7f]/;

const isSensitiveProp = (name) =>
  typeof name === 'string' &&
  (SENSITIVE_PROPS.has(name) || SENSITIVE_PREFIXES.some((prefix) => name.startsWith(prefix)));

/** 把一个子节点在父节点上就地换掉（terser 这个版本没带 TreeTransformer，只能自己来） */
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

/** 造一个 `TABLE[index]` 节点 */
const makeTableRef = (terser, tableName, index) => new terser.AST_Sub({
  expression: new terser.AST_SymbolRef({name: tableName}),
  property: new terser.AST_Number({value: index})
});

/** 源码里所有被声明过的名字（用来判断某个 helper 名是不是「自由变量」） */
const collectDeclaredNames = (terser, ast) => {
  const declared = new Set();
  ast.walk(new terser.TreeWalker(function (node) {
    if (node instanceof terser.AST_SymbolDeclaration) {
      declared.add(node.name);
      return;
    }
    // 具名函数表达式的名字也是声明
    if (node instanceof terser.AST_Lambda && node.name && node.name.name) {
      declared.add(node.name.name);
    }
  }));
  return declared;
};

/** 结构硬化的强度预设 */
const HARDEN_LEVEL = {
  /** 只做字符串抽表（历史行为，`scrambleStrings` 用它） */
  strings: {strings: true, props: false, helpers: false, returnChain: false},
  /** 全套 */
  full: {strings: true, props: true, helpers: true, returnChain: true}
};

/**
 * 把脚本工厂「改形状」，让它不再是编译器产物的那个形状。
 *
 * 具体做四件事（见文件头注释）：字符串抽表、属性名查表化、helper 别名化、切断 return 链。
 * 全部在**同一次 AST 遍历 + 一次代码生成**里完成 —— 多跑几遍会把体积和可读性都搞坏。
 *
 * @param {string} source 已经压缩过的源码（必须是「求值为函数」的表达式）
 * @param {object} [options]
 * @param {boolean} [options.strings=true] 字符串抽表
 * @param {boolean} [options.props=true] 敏感属性名查表化
 * @param {boolean} [options.helpers=true] 运行时 helper 别名化
 * @param {boolean} [options.returnChain=true] 切断 `return <函数>` 链
 * @param {string[]} [options.helperNames] 可别名化的运行时 helper 名（默认 HELPER_NAMES；
 *        调用方最好从 jsexecute 现算，见 `resolveHelperNames`，这样不会把不存在的名字别名化）
 * @returns {string|null} 变换后的源码；什么都不用做时返回 null
 */
const hardenScript = (source, options = {}) => {
  const flags = {...HARDEN_LEVEL.full, ...options};
  const helperNames = Array.isArray(options.helperNames) && options.helperNames.length > 0
    ? options.helperNames
    : HELPER_NAMES;
  const helperSet = new Set(helperNames);
  const terser = getTerser();
  let ast;
  try {
    ast = terser.parse(source);
  } catch (e) {
    return null;
  }

  const declared = flags.helpers ? collectDeclaredNames(terser, ast) : new Set();
  // 表名/别名前缀不能和源码里已有的名字撞（撞了就是静默改坏语义）
  let tableName = TABLE_NAME;
  let aliasPrefix = ALIAS_PREFIX;
  if (declared.has(tableName) || source.includes(`${tableName}[`)) {
    tableName = '__t';
  }
  for (let i = 0; i < 40 && [...declared].some((name) => name.startsWith(aliasPrefix)); i++) {
    aliasPrefix = `${aliasPrefix}q`;
  }

  /** @type {Array<{node: object, parent: object|null}>} */
  const stringNodes = [];
  /** @type {Array<{node: object, parent: object|null}>} */
  const dotNodes = [];
  /** @type {Array<{node: object, name: string}>} */
  const helperRefs = [];
  /** @type {Array<{node: object, parent: object|null}>} */
  const returnNodes = [];

  const walker = new terser.TreeWalker(function (node) {
    const parent = walker.parent();
    if (flags.strings && node instanceof terser.AST_String) {
      if (node.value.length >= MIN_TABLE_STRING_LENGTH || NON_ASCII_RE.test(node.value)) {
        stringNodes.push({node, parent});
      }
      return;
    }
    if (flags.props && node instanceof terser.AST_Dot && !node.optional) {
      // `.prop` 的 property 是**普通字符串**（`a["b"]` 才是 AST_String），所以要单独处理
      if (isSensitiveProp(node.property)) dotNodes.push({node, parent});
      return;
    }
    if (flags.helpers && node instanceof terser.AST_SymbolRef) {
      if (!declared.has(node.name) && helperSet.has(node.name)) {
        helperRefs.push({node, name: node.name});
      }
      return;
    }
    if (flags.returnChain && node instanceof terser.AST_Return && node.value) {
      const value = node.value;
      if (value instanceof terser.AST_Lambda) returnNodes.push({node, parent});
    }
  });
  ast.walk(walker);

  const nothingToDo = stringNodes.length === 0 && dotNodes.length === 0 &&
    helperRefs.length === 0 && returnNodes.length === 0;
  if (nothingToDo) return null;

  // ── 1. 建字符串表（字面量 + 要查表化的属性名共用一张表，同值同下标）
  const strings = [];
  const seen = new Map();
  const indexOf = (value) => {
    let index = seen.get(value);
    if (index === undefined) {
      index = strings.length;
      strings.push(value);
      seen.set(value, index);
    }
    return index;
  };

  // ── 2. 字面量换成查表（先做这一步：后面处理 `.prop` 时拿到的 expression 已经是替换过的）
  let replaced = 0;
  for (const {node, parent} of stringNodes) {
    if (!parent) continue;
    if (replaceChild(parent, node, makeTableRef(terser, tableName, indexOf(node.value)))) replaced += 1;
  }

  // ── 3. 敏感属性名换成查表。必须**从内到外**处理（walker 是自顶向下，倒着走就是自底向上），
  //      否则 `a.b.c` 里的 `a.b` 会被替换进一个已经离开语法树的旧节点里。
  for (let i = dotNodes.length - 1; i >= 0; i--) {
    const {node, parent} = dotNodes[i];
    if (!parent) continue;
    const replacement = new terser.AST_Sub({
      expression: node.expression,
      property: makeTableRef(terser, tableName, indexOf(node.property))
    });
    if (replaceChild(parent, node, replacement)) replaced += 1;
  }

  // ── 4. helper 改名（只改调用点；原名字仍留在下面拼的前奏里，保证 insertRuntime 照旧注入）
  //
  // 这里**不做长度门槛**：别名前奏（`const _q0=xxx,`）每个脚本各一份，看起来是白付的字节，
  // 但实测（三个真实工程）全量别名化只让索引多 0.3%，而收益是把 decompileCall
  // 按名字硬匹配的那一整类积木（timer / mod / listGet / compareEqual …）全部废掉。
  // 之前设过 `name.length >= 8` 的门槛，被实测数据否掉了。
  const aliasByName = new Map();
  for (const {node, name} of helperRefs) {
    let alias = aliasByName.get(name);
    if (!alias) {
      alias = `${aliasPrefix}${aliasByName.size}`;
      aliasByName.set(name, alias);
    }
    node.name = alias;
  }

  // ── 5. 切断 return 链。三种形状随机选，避免「一种形状一套适配器」通吃
  //
  // ⚠️ 新建的节点必须带上 `start` / `end`：terser 4 的 AST_Return 打印时会读
  //    `this.value.start.comments_before`，没有 start 就直接
  //    `TypeError: Cannot read properties of undefined (reading 'comments_before')`
  //    —— 这个错误被 minify 吞进 `result.error`，表现是「静默什么都没做」。
  for (const {node} of returnNodes) {
    const fn = node.value;
    const shape = Math.floor(Math.random() * 3);
    let replacement;
    if (shape === 0) {
      replacement = new terser.AST_Sub({
        expression: new terser.AST_Array({elements: [fn]}),
        property: new terser.AST_Number({value: 0})
      });
    } else if (shape === 1) {
      replacement = new terser.AST_Sub({
        expression: new terser.AST_Array({
          elements: [new terser.AST_Number({value: 0}), fn]
        }),
        property: new terser.AST_Number({value: 1})
      });
    } else {
      replacement = new terser.AST_Sequence({
        expressions: [new terser.AST_Number({value: 0}), fn]
      });
    }
    replacement.start = fn.start;
    replacement.end = fn.end;
    node.value = replacement;
  }

  if (replaced === 0 && aliasByName.size === 0 && returnNodes.length === 0) return null;

  // 打印（只在最后做一次：compress/mangle 都关掉，避免把刚切断的 return 链又折回去）
  const body = printAst(terser, ast);
  if (typeof body !== 'string' || body.length === 0) return null;

  // ── 6. 前奏：字符串表（反序存放，产物里 grep 不到明文）+ helper 别名
  const prologueSource = [];
  if (strings.length > 0) {
    const reversed = strings.map((value) => value.split('').reverse().join(''));
    prologueSource.push(`const ${tableName}=${JSON.stringify(reversed)}` +
      '.map(s=>s.split("").reverse().join(""));');
  }
  if (aliasByName.size > 0) {
    const pairs = [];
    for (const [name, alias] of aliasByName) pairs.push(`${alias}=${name}`);
    prologueSource.push(`const ${pairs.join(',')};`);
  }
  if (prologueSource.length === 0) return body;
  const prologueText = prologueSource.join('');

  // ⚠️ 外层为什么要再套一层 `[ … ][0]`：
  //    解包器 extractFunctionInfo 的第三条兜底是「顶层 ExpressionStatement 是 CallExpression、
  //    callee 是函数 → 直接把那个函数当脚本体」（decompile.js:600 附近）。
  //    裸的 `(()=>{…})()` 正好命中它，于是虽然拿不到语义，仍会把前奏里的 `const __s=…`
  //    当成 `[unresolved]` 产出 1~2 个占位块。套一层数组取值之后顶层变成
  //    MemberExpression，三条兜底全部落空 —— 一个块都不产生。
  //
  // ⚠️ 也**不能**把前奏内联进工厂函数体：那样 `const __s=…reverse()` 会在**每次线程启动**
  //    时重算一遍（克隆密集的作品里就是几千次），而 IIFE 只在 scopedEval 时跑一次。
  return `[(()=>{${prologueText}return [${body}][0];})()][0]`;
};

/**
 * 把 AST 打印回「求值为一个函数」的表达式源码。
 * ⚠️ 不能再跑 compress —— 那会把 `return [fn][0]` 折叠回 `return fn`，前功尽弃。
 * @returns {string|null}
 */
const printAst = (terser, ast) => {
  const printed = terser.minify(ast, {
    ecma: 2018,
    compress: false,
    mangle: false,
    output: {comments: false}
  });
  if (!printed || printed.error || typeof printed.code !== 'string') return null;
  // minify(ast) 会按「语句」加结尾分号，而我们要的是一个表达式
  const body = printed.code.replace(/;+\s*$/, '');
  return body || null;
};

/**
 * 只做字符串抽表的旧入口（保留给既有测试与调用方）。
 * 新代码请用 `hardenScript`。
 * @param {string} source
 * @returns {string|null}
 */
const scrambleStrings = (source) => hardenScript(source, HARDEN_LEVEL.strings);

/**
 * 一次性做全套结构硬化的入口（compile.js 用的就是这个）。
 * @param {string} source 压缩后的源码
 * @returns {string|null}
 */
const harden = (source) => hardenScript(source, HARDEN_LEVEL.full);

/**
 * 从 jsexecute 现场算出「确实存在」的运行时 helper 名。
 *
 * 为什么要现算而不是用常量表：给一个不存在的名字写 `const _q0 = xxx`
 * 会直接 ReferenceError，整个脚本的硬化就白做了（虽然会退回压缩版，但白白丢掉保护）。
 * 现算的成本只有一次 require + 一次正则扫描。
 *
 * @param {object} jsexecute `scratch-vm/src/compiler/jsexecute`
 * @returns {string[]}
 */
const resolveHelperNames = (jsexecute) => {
  const names = new Set(HELPER_NAMES);
  try {
    if (jsexecute && jsexecute.runtimeFunctions) {
      for (const name of Object.keys(jsexecute.runtimeFunctions)) names.add(name);
    }
    // baseRuntime 里直接声明的（isStuck / compareEqual / listIndex …）不在 runtimeFunctions 里
    if (jsexecute && typeof jsexecute.insertRuntime === 'function') {
      const base = jsexecute.insertRuntime('');
      const re = /(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
      let match = re.exec(base);
      while (match) {
        names.add(match[1]);
        match = re.exec(base);
      }
    }
  } catch (e) {
    // 拿不到就用默认表，宁可少别名几个也不要让构建失败
  }
  return Array.from(names);
};

module.exports = {
  DEFAULT_OPTIONS,
  TABLE_NAME,
  HELPER_NAMES,
  SENSITIVE_PROPS,
  createScriptMinifier,
  hardenScript,
  harden,
  scrambleStrings,
  resolveHelperNames,
  isMinifierAvailable
};
