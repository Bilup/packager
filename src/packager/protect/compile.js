/*
 * 打包期脚本预编译。
 *
 * 目的：把整个作品的积木在「打包时」编译成 JavaScript，并把生成源码带出来，
 * 这样产物里就不需要再保留积木本体（blocks），运行时也不用再编译 ——
 * 一举解决「逻辑可被逆向」和「启动时要编译一遍」两个问题。
 *
 * 实现方式：复刻 scratch-vm 的 `src/compiler/compile.js` 流程（IRGenerator -> IROptimizer -> JSGenerator），
 * 但用 JSGenerator 自带的 testingApparatus 钩子把生成好的 factory 源码文本取出并保存。
 * 运行时只要用同样的 jsexecute.scopedEval 把源码重新求值，就能拿到一模一样可执行的脚本，
 * 从而可以安全地把 blocks 丢掉。
 *
 * 注意：本文件用 CommonJS 写，方便在 Node 里直接 require 出来做回归测试（不需要 babel）。
 */

const {
  ENTRY_KEY,
  FORMAT_VERSION,
  collectRuntimeRefs,
  encodeScriptExtensions,
  extensionIdFromCompilerPackageName
} = require('../../protect/index-format');

// 只引用函数，模块本身不加载 terser（terser 是在 createScriptMinifier 里懒加载的）
const {hardenScript, scrambleStrings, resolveHelperNames} = require('./minify-script');

/** 懒加载 scratch-vm 的内部模块：只有真正用预编译时才需要它们。 */
const loadCompiler = () => {
  const {IRGenerator} = require('scratch-vm/src/compiler/irgen');
  const {IROptimizer} = require('scratch-vm/src/compiler/iroptimizer');
  const JSGenerator = require('scratch-vm/src/compiler/jsgen');
  const jsexecute = require('scratch-vm/src/compiler/jsexecute');
  const Thread = require('scratch-vm/src/engine/thread');
  const sb3 = require('scratch-vm/src/serialization/sb3');
  return {IRGenerator, IROptimizer, JSGenerator, jsexecute, Thread, sb3};
};

/**
 * 判断一个扩展在运行时能否被加载，并给出它的 URL。
 *
 * 三种情况：
 *   - VM 内置扩展（music / pen / video / text2speech …）：同步加载，url 记为 ''
 *   - 自定义扩展（有 URL）：运行时按 URL 异步加载
 *   - 已经加载过的：说明宿主会在启动时装载（打包器的 extensions 选项走这条路）
 * @returns {{id: string, url: string, resolvable: boolean}}
 */
const resolveExtension = (vm, id, extensionURLs) => {
  if (extensionURLs && Object.prototype.hasOwnProperty.call(extensionURLs, id) && extensionURLs[id]) {
    return {id, url: `${extensionURLs[id]}`, resolvable: true};
  }
  const manager = vm.extensionManager;
  if (manager) {
    if (typeof manager.isBuiltinExtension === 'function' && manager.isBuiltinExtension(id)) {
      return {id, url: '', resolvable: true};
    }
    if (typeof manager.isExtensionLoaded === 'function' && manager.isExtensionLoaded(id)) {
      // 宿主已经装好了它（例如打包器的 extensions 选项），产物启动时同样会装
      return {id, url: '', resolvable: true};
    }
    if (typeof manager.getExtensionURLs === 'function') {
      const urls = manager.getExtensionURLs();
      if (urls && urls[id]) return {id, url: `${urls[id]}`, resolvable: true};
    }
  }
  return {id, url: '', resolvable: false};
};

/**
 * 把一个线程源码里用到的扩展解析成需求清单。
 *
 * 两条来源：
 *   1. `runtime.getOpcodeFunction("pen_penDown")` —— 按 opcode 反推扩展 id
 *   2. `runtime.ext_pen._setPenColorToColor(…)`   —— 编译器硬编码直呼的扩展对象，
 *      只能从包名反推（pen 就是这么漏掉的，漏了运行时直接
 *      `Cannot read properties of undefined (reading '_setPenColorToColor')`）
 *
 * @param {object} vm
 * @param {string[]} sources 必须是**未压缩**源码
 * @param {Map<string, string>|object} extensionURLs 工程里记录的「扩展 id -> URL」
 * @param {Map<string, object>} cache 扩展 id -> 解析结果（跨脚本复用）
 * @param {object} sb3 scratch-vm 的 sb3 序列化模块
 * @returns {{required: Array<{id: string, url: string}>, unresolved: string[]}}
 */
const describeExtensions = (vm, sources, extensionURLs, cache, sb3) => {
  const {opcodes, extensionNames} = collectRuntimeRefs(sources);
  const required = [];
  const unresolved = [];

  const manager = vm.extensionManager;
  /** 核心积木（motion/looks/sound/control…）不属于扩展，运行时永远就位 */
  const isCore = (id) => {
    if (manager && typeof manager.isCoreExtension === 'function' && manager.isCoreExtension(id)) {
      return true;
    }
    // 兜底：编译器对核心积木不给扩展前缀，getExtensionIdForOpcode 会返回 undefined
    return !sb3.getExtensionIdForOpcode(`${id}_probe`);
  };

  const consider = (id) => {
    if (!id) return;
    let resolved = cache.get(id);
    if (!resolved) {
      resolved = resolveExtension(vm, id, extensionURLs);
      cache.set(id, resolved);
    }
    if (!resolved.resolvable) {
      if (unresolved.indexOf(id) === -1) unresolved.push(id);
      return;
    }
    if (!required.some((item) => item.id === id)) required.push({id, url: resolved.url});
  };

  for (const opcode of opcodes) {
    consider(sb3.getExtensionIdForOpcode(opcode));
  }
  for (const name of extensionNames) {
    const id = extensionIdFromCompilerPackageName(name);
    if (isCore(id)) continue;
    consider(id);
  }

  return {required, unresolved};
};

/**
 * 编译单个脚本（或过程），**只拿未压缩的源码**，不做任何压缩/混淆。
 *
 * 为什么把压缩拆出去：自定义积木的变体名（`Z<proccode>` / `W<proccode>`）里带着
 * proccode 原文 —— 也就是「自定义积木的名字和参数形状」。它既出现在 `packed.p` 的键上，
 * 也出现在生成码的 `thread.procedures["Z..."]` 里。要把它换成无意义代号，
 * 必须**在压缩之前**同时改掉键和源码里的字面量（压缩之后字符串已经进表了，改不动）。
 * 所以这里只产出原源码，改名和压缩都在 compileThread 里按顺序做。
 *
 * @param {object} script 中间表示里的脚本对象（ir.entry 或 ir.procedures[变体]）
 * @param {object} ir 中间表示
 * @param {object} target 目标（角色/舞台）
 * @param {object} deps loadCompiler() 的结果
 * @returns {{fn: Function, rawSource: string}}
 */
const compileOneRaw = (script, ir, target, deps) => {
  const {JSGenerator} = deps;
  const generator = new JSGenerator(script, ir, target);
  let source = null;
  const previousApparatus = JSGenerator.testingApparatus;
  // 这是 TurboWarp 自己用于快照测试的钩子，compile() 会把生成好的源码交给它
  JSGenerator.testingApparatus = {
    report: (_generator, factory) => {
      source = factory;
    }
  };
  let fn;
  try {
    // compile() 内部会 scopedEval(源码) 得到可执行函数；
    // 这一步同时也是源码有效性的自检（打包期能求值，运行时必然也能）
    fn = generator.compile();
    if (typeof source !== 'string') {
      throw new Error('编译器没有交出生成源码');
    }
  } finally {
    JSGenerator.testingApparatus = previousApparatus;
  }
  return {fn, rawSource: source};
};

/** 与 jsgen 里 `sanitize()` 完全一致的转义（`JSON.stringify(s).slice(1,-1)`） */
const sanitizeSourceString = (value) => JSON.stringify(value).slice(1, -1);

/**
 * 把自定义积木的变体名换成无意义代号（`Z我的积木%s` → `#0`）。
 *
 * 变体名会同时出现在两个地方，必须一起改：
 *   1. `packed.p` 的键（运行时 `thread.procedures[键]` 靠它取函数）
 *   2. 生成码里的字符串字面量 `thread.procedures["Z我的积木%s"]`
 * 两边一致才不会挂 —— 而代号本身不带任何语义，proccode 就此消失。
 *
 * 换掉之后 `p` 的键长这样：{ '#0': '…', '#1': '…' }，一眼看不出作品有几个自定义积木、
 * 叫什么名字、参数是什么形状。
 *
 * @param {object} rawSources 变体名 -> 原源码
 * @returns {{sources: object, variants: string[]}} variants 是改名后的代号列表
 */
const obfuscateProcedureVariants = (rawSources) => {
  const variants = Object.keys(rawSources).filter((key) => key !== ENTRY_KEY);
  if (variants.length === 0) return {sources: rawSources, variants: []};

  // 代号不能和源码里已有的字面量撞（极端情况：作品的 proccode 本身就是 "#0"）
  const allSources = Object.values(rawSources).join('\n');
  const tokenOf = new Map();
  const used = new Set();
  variants.forEach((variant, index) => {
    let token = `#${index}`;
    let suffix = 0;
    while (used.has(token) || allSources.indexOf(`"${sanitizeSourceString(token)}"`) !== -1) {
      suffix += 1;
      token = `#${index}_${suffix}`;
    }
    used.add(token);
    tokenOf.set(variant, token);
  });

  const sources = {};
  for (const key of Object.keys(rawSources)) {
    let source = rawSources[key];
    for (const [variant, token] of tokenOf) {
      const needle = `"${sanitizeSourceString(variant)}"`;
      if (source.indexOf(needle) === -1) continue;
      source = source.split(needle).join(`"${sanitizeSourceString(token)}"`);
    }
    sources[key === ENTRY_KEY ? ENTRY_KEY : tokenOf.get(key)] = source;
  }
  return {sources, variants: Array.from(tokenOf.values())};
};

/**
 * 压缩 → 结构硬化 → 自检。任何一步出问题都退回上一个能用的版本
 * —— 保护可以打折，产物不能打不开。
 *
 * 三级都是「先做、再求值自检、坏了就退」：
 *   1. terser 压缩（体积）
 *   2. 全套结构硬化（字符串表 + 属性名查表 + helper 别名 + 切断 return 链）
 *   3. 只做字符串表（历史行为，硬化失败时的中间兜底）
 *
 * @returns {string|null} 可直接内嵌进索引的源码；全失败时返回 null（调用方用原源码）
 */
const minifyWithFallback = (source, jsexecute, context) => {
  const {minifier, minifyStats, scramble = true, helperNames} = context;
  try {
    const minified = minifier(source);
    if (typeof minified !== 'string' || minified.length === 0) return null;
    // 压缩后必须仍然求值出函数，否则说明优化动坏了语义
    if (typeof jsexecute.scopedEval(minified) !== 'function') return null;

    const accept = (candidate) => typeof candidate === 'string' && candidate.length > 0 &&
      typeof jsexecute.scopedEval(candidate) === 'function';

    let finalSource = minified;
    if (scramble) {
      let hardened = null;
      try {
        hardened = hardenScript(minified, {helperNames});
      } catch (e) {
        // 硬化本身抛错（例如 terser 解析失败）：不影响正确性，退回压缩版
        if (minifyStats) minifyStats.hardenFailed += 1;
      }
      if (typeof hardened === 'string' && hardened.length > 0) {
        if (accept(hardened)) {
          finalSource = hardened;
          if (minifyStats) minifyStats.hardened += 1;
        } else {
          // 硬化把语义动坏了：退到「只抽字符串表」，至少别丢掉这层
          if (minifyStats) minifyStats.hardenFailed += 1;
          const partial = scrambleStrings(minified);
          if (accept(partial)) finalSource = partial;
        }
      }
      // hardened === null 且没抛错 = 这份源码里没有可硬化的东西（既没有长字符串、
      // 也没有敏感属性访问和 return 链）。这不是失败，不要计进 hardenFailed。
    }

    if (minifyStats) {
      minifyStats.originalBytes += source.length;
      minifyStats.minifiedBytes += finalSource.length;
      minifyStats.count += 1;
    }
    return finalSource;
  } catch (error) {
    if (minifyStats) {
      minifyStats.failed += 1;
      if (minifyStats.firstError === null) {
        minifyStats.firstError = `${(error && error.message) || error}`;
      }
    }
    return null;
  }
};

/**
 * 只能出现在「切换」（`control_switch`）内部的积木。
 *
 * 编译器把它们直接生成成 `case x:` / `default:` / `break;` 这样的**标签语句**，
 * 只有嵌在 `switch (...) {` 里才是合法 JS。一旦它们自己成了顶层积木
 * （工程里常见的「跑题积木」：作者把分支拖到画布上忘了删，project.json 里就留着
 * `topLevel: true, parent: null`），生成出来的函数体开头就是 `case`，
 * `scopedEval` 直接 `SyntaxError: Unexpected token 'case'` —— 表现为「这个脚本编译失败」。
 *
 * 这类积木在运行时也**永远不会被执行**（没有帽子启动它），所以正确做法不是「编译它」，
 * 而是「不把它当脚本」。
 */
const SWITCH_CLAUSE_OPCODES = new Set([
  'control_case',
  'control_default',
  'control_case_fallthrough',
  'control_break'
]);

/**
 * 只产出值、不可能启动一个线程的积木类型（scratch-vm 的 BlockType 取值）。
 *
 * ⚠️ `Boolean` 是首字母大写的，别按直觉小写。
 */
const VALUE_ONLY_BLOCK_TYPES = new Set(['reporter', 'Boolean', 'button', 'label', 'xml']);

/**
 * 造一个「opcode -> blockInfo」查询器。
 *
 * 直接读 `runtime._blockInfo`（下划线私有，但 irgen 自己也这么读，是唯一现成的来源）：
 * 它按扩展分组，每组里 `info.opcode` 是**去掉扩展前缀**的短名。
 * 查不到就返回 null —— 未知 opcode 仍然按老路子走「编译失败 → 保留积木」，
 * 不能因为查不到就当成「不是脚本」把整摞积木静默跳过。
 */
const createBlockInfoLookup = (runtime) => {
  const cache = new Map();
  return (opcode) => {
    if (cache.has(opcode)) return cache.get(opcode);
    let found = null;
    const text = `${opcode || ''}`;
    const split = text.indexOf('_');
    if (split > 0 && runtime && Array.isArray(runtime._blockInfo)) {
      const category = text.slice(0, split);
      const shortName = text.slice(split + 1);
      for (const entry of runtime._blockInfo) {
        if (!entry || entry.id !== category || !Array.isArray(entry.blocks)) continue;
        found = entry.blocks.find((item) => item && item.info && item.info.opcode === shortName) || null;
        break;
      }
    }
    cache.set(opcode, found);
    return found;
  };
};

/**
 * 判断一个顶层积木「根本不是一段脚本」。
 *
 * 背景：`target.blocks.getScripts()` 返回的是**所有 topLevel 积木**，其中混着作者
 * 丢在画布上的散块 —— 悬浮的 reporter（例如 `superutilsadvanced_splitText`）、
 * 切换分支的子句（`control_default`）、监视器合成出来的 `data_variable`。
 * 它们既不会被绿旗启动，也没有可执行的语义，但会被当成脚本：
 *   - 悬浮 reporter → 编译器当「堆叠积木」生成 → `Unknown block type: reporter`
 *   - 切换子句     → 生成出裸的 `case` / `default` → `Unexpected token 'case'`
 * 于是每一块都给打包结果贡献一条「编译失败，保留积木」的警告，把**真正的**失败淹掉，
 * 也让 stats.failed 永远降不到 0。
 *
 * @returns {string|null} 不是脚本时返回原因（用于统计），是脚本时返回 null
 */
const describeNonScript = (block, lookup) => {
  if (!block || !block.opcode) return null;
  if (SWITCH_CLAUSE_OPCODES.has(block.opcode)) {
    return `${block.opcode} 只能嵌在「切换」积木里`;
  }
  const blockInfo = lookup(block.opcode);
  const blockType = blockInfo && blockInfo.info && blockInfo.info.blockType;
  if (blockType && VALUE_ONLY_BLOCK_TYPES.has(blockType)) {
    return `${block.opcode} 是 ${blockType} 积木，不能启动线程`;
  }
  return null;
};

/**
 * 编译一个脚本线程（与该脚本同属一个目标的所有自定义积木也会一起编译）。
 *
 * 顺序不能换：
 *   1. 编译出**未压缩**原源码（依赖扫描必须用它 —— 压缩会把 factory 的形参 `runtime` 改名，
 *      压缩版里再也扫不到 `runtime.getOpcodeFunction(...)`）
 *   2. 把自定义积木变体名换成代号（键 + 源码字面量一起改，必须在压缩之前）
 *   3. 压缩 + 结构硬化（每步都自检，坏了往下退）
 */
const compileThread = (thread, deps, context) => {
  const {IRGenerator, IROptimizer, jsexecute} = deps;
  const ir = new IRGenerator(thread).generate();
  new IROptimizer(ir).optimize();

  const target = thread.target;
  const rawByVariant = {};
  rawByVariant[ENTRY_KEY] = compileOneRaw(ir.entry, ir, target, deps).rawSource;
  for (const variant of Object.keys(ir.procedures)) {
    // 变体名形如 Z<proccode>（非跳帧）/ W<proccode>（跳帧），与 jsexecute 的约定一致
    rawByVariant[variant] = compileOneRaw(ir.procedures[variant], ir, target, deps).rawSource;
  }

  const {sources: rawSources, variants} = obfuscateProcedureVariants(rawByVariant);

  const sources = {};
  for (const key of Object.keys(rawSources)) {
    if (!context) {
      sources[key] = rawSources[key];
      continue;
    }
    const processed = minifyWithFallback(rawSources[key], jsexecute, context);
    sources[key] = typeof processed === 'string' ? processed : rawSources[key];
  }

  return {
    sources,
    rawSources: rawByVariant,
    renamedVariants: variants,
    executableHat: !!ir.entry.executableHat
  };
};

/**
 * 编译整个作品。
 *
 * 关键点：编译器对扩展积木生成的是 `runtime.getOpcodeFunction("music_xxx")`，
 * 而这些函数是在工厂函数**求值时**就固化进闭包的 —— 所以运行时必须「先加载扩展，再 scopedEval」。
 * 由于积木被摘掉后 sb3 反序列化再也扫不到扩展 opcode，这里就把需要的扩展记进索引，
 * 交给运行时显式加载（见 scaffolding/precompiled.js）。
 *
 * @param {object} vm 已加载好作品的 scratch-vm 实例（compiler 是否开启不影响这里）
 * @param {object} [options]
 * @param {object|Map<string,string>} [options.extensionURLs] 工程记录的「扩展 id -> URL」（project.json 的 extensionURLs）
 * @param {boolean} [options.requireAllExtensionsResolved=true]
 *        引用了无法解析的扩展时是否让该脚本退回「保留积木」（默认是，宁可保守也不要产出打不开的包）
 * @returns {{index: object, failures: Array, stats: object}}
 */
const compileProject = (vm, options = {}) => {
  const deps = loadCompiler();
  const {Thread, sb3} = deps;
  const {
    extensionURLs,
    requireAllExtensionsResolved = true,
    minifier = null,
    minify = false,
    scramble = true
  } = options;

  // 没显式给 minifier 但要求压缩，就现造一个（terser 不可用时会抛，调用方自行兜底）
  let activeMinifier = minifier;
  if (!activeMinifier && minify) {
    activeMinifier = require('./minify-script').createScriptMinifier();
  }
  const minifyStats = activeMinifier
    ? {count: 0, failed: 0, originalBytes: 0, minifiedBytes: 0, firstError: null,
      hardened: 0, hardenFailed: 0}
    : null;
  // scramble: 在压缩之外再做一层「结构硬化」，让生成码不再是编译器产物的那个形状
  // helperNames: 从 jsexecute 现算，避免把不存在的 helper 名别名化（那会 ReferenceError）
  const context = activeMinifier
    ? {minifier: activeMinifier, minifyStats, scramble, helperNames: resolveHelperNames(deps.jsexecute)}
    : null;

  const targets = [];
  const failures = [];
  /** 「根本不是脚本」的顶层积木（悬浮 reporter / 切换子句 / 监视器幽灵块） */
  const skippedScripts = [];
  const extensionCache = new Map();
  /** @type {Map<string, string>} 扩展 id -> URL（'' 表示内置扩展） */
  const extensionRequirements = new Map();
  const addonCodes = new Set();
  /** 被改成代号的自定义积木变体（`目标名|代号`，跨脚本去重） */
  const renamedVariantsSeen = new Set();
  const blockInfoOf = createBlockInfoLookup(vm.runtime);
  let scriptCount = 0;
  let compiledCount = 0;
  let sourceBytes = 0;

  for (const target of vm.runtime.targets) {
    const scripts = {};
    const targetScripts = target.blocks.getScripts();
    // 本目标的脚本一共用到哪些扩展（按首次出现排序）；脚本上只存下标，省体积
    const targetExtensionIds = [];
    for (const topBlockId of targetScripts) {
      // getScripts() 给的是「所有 topLevel 积木」，里面混着作者丢在画布上的散块。
      // 先筛掉「不可能是脚本」的，否则它们会以「编译失败」的形式污染统计与警告
      const nonScript = describeNonScript(target.blocks.getBlock(topBlockId), blockInfoOf);
      if (nonScript) {
        skippedScripts.push({targetName: target.getName(), topBlockId, reason: nonScript});
        continue;
      }
      scriptCount += 1;
      const thread = new Thread(topBlockId);
      thread.target = target;
      thread.blockContainer = target.blocks;
      try {
        const {sources, rawSources, renamedVariants, executableHat} = compileThread(thread, deps, context);
        const sourceList = Object.values(sources);
        // ⚠️ 依赖扫描用未压缩源码：压缩会把 factory 的形参 `runtime` 改名，
        //    压缩版里再也扫不到 `runtime.getOpcodeFunction(...)`
        const rawSourceList = Object.values(rawSources);

        // 扩展依赖检查：解析不了的扩展会让脚本退回解释器（积木整棵保留）
        const {required, unresolved} = describeExtensions(vm, rawSourceList, extensionURLs, extensionCache, sb3);
        if (requireAllExtensionsResolved && unresolved.length > 0) {
          throw new Error(`引用了无法解析的扩展：${unresolved.join(', ')}`);
        }
        for (const item of required) extensionRequirements.set(item.id, item.url);
        for (const code of collectRuntimeRefs(rawSourceList).addonCodes) addonCodes.add(code);

        // 记录「这个脚本依赖哪些扩展」：运行时据此做**按脚本**的降级
        // （某个扩展加载不上时只跳过用到它的脚本，而不是一条都不装 —— 见 precompiled.js）
        const usedIds = [];
        for (const item of required) {
          if (!targetExtensionIds.includes(item.id)) targetExtensionIds.push(item.id);
          if (!usedIds.includes(item.id)) usedIds.push(item.id);
        }

        const packed = {e: sources[ENTRY_KEY]};
        // 不可执行的帽子是多数情况：只在为真时才写这个字段，
        // 少一个恒为 false 的键，也就少一条「这个脚本是不是帽子」的现成线索
        if (executableHat) packed.h = 1;
        if (usedIds.length > 0) packed.x = encodeScriptExtensions(targetExtensionIds, usedIds);
        const procedures = {};
        let hasProcedures = false;
        for (const variant of Object.keys(sources)) {
          if (variant === ENTRY_KEY) continue;
          procedures[variant] = sources[variant];
          hasProcedures = true;
        }
        if (hasProcedures) packed.p = procedures;
        scripts[topBlockId] = packed;
        compiledCount += 1;
        // 同一目标的每个脚本都带着同一套过程，所以按「目标名 + 代号」去重
        for (const variant of renamedVariants) renamedVariantsSeen.add(`${target.getName()}|${variant}`);
        for (const source of sourceList) sourceBytes += source.length;
      } catch (error) {
        // 编译不了的脚本会被原样保留积木（见 skeleton.js），运行时仍然可以走解释器兜底
        failures.push({
          targetName: target.getName(),
          topBlockId,
          message: `${(error && error.message) || error}`
        });
      }
    }
    if (targetScripts.length > 0) {
      // 按角色名索引：目标 id 每次加载都会变，不能用
      const entry = {n: target.getName(), st: target.isStage ? 1 : 0, s: scripts};
      if (targetExtensionIds.length > 0) entry.x = targetExtensionIds;
      targets.push(entry);
    }
  }

  const extensionMap = {};
  for (const [id, url] of extensionRequirements) extensionMap[id] = url;

  const index = {v: FORMAT_VERSION, t: targets};
  if (Object.keys(extensionMap).length > 0) index.x = extensionMap;
  if (addonCodes.size > 0) index.a = Array.from(addonCodes);
  const indexText = JSON.stringify(index);

  return {
    index,
    failures,
    skippedScripts,
    stats: {
      targets: targets.length,
      scripts: scriptCount,
      compiled: compiledCount,
      failed: failures.length,
      // 散块（悬浮 reporter / 切换子句 / 监视器幽灵块）不是失败，单独计数：
      // 它们的积木仍会留在骨架里，但运行时永远不会启动它们
      skippedNonScripts: skippedScripts.length,
      sourceBytes,
      indexBytes: indexText.length,
      extensions: extensionMap,
      addonCodes: Array.from(addonCodes),
      minified: minifyStats ? minifyStats.count : 0,
      minifyFailed: minifyStats ? minifyStats.failed : 0,
      minifyError: minifyStats ? minifyStats.firstError : null,
      hardened: minifyStats ? minifyStats.hardened : 0,
      hardenFailed: minifyStats ? minifyStats.hardenFailed : 0,
      renamedProcedures: renamedVariantsSeen.size,
      originalSourceBytes: minifyStats ? minifyStats.originalBytes : sourceBytes
    }
  };
};

/**
 * 把索引里的源码逐个重新求值，确认运行时能还原成函数。
 * 打包前跑一遍，避免产出一个「打不开」的包。
 * @param {object} index compileProject() 产出的索引
 * @returns {{ok: boolean, checked: number, broken: Array}}
 */
const verifyIndex = (index) => {
  const {jsexecute} = loadCompiler();
  let checked = 0;
  const broken = [];
  for (const target of index.t) {
    for (const topBlockId of Object.keys(target.s)) {
      const packed = target.s[topBlockId];
      const sources = {[ENTRY_KEY]: packed.e, ...(packed.p || {})};
      for (const variant of Object.keys(sources)) {
        checked += 1;
        try {
          const fn = jsexecute.scopedEval(sources[variant]);
          if (typeof fn !== 'function') {
            broken.push({topBlockId, variant, message: '还原结果不是函数'});
          }
        } catch (error) {
          broken.push({topBlockId, variant, message: `${(error && error.message) || error}`});
        }
      }
    }
  }
  return {ok: broken.length === 0, checked, broken};
};

module.exports = {
  ENTRY_KEY,
  compileProject,
  verifyIndex
};
