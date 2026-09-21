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
  extensionIdFromCompilerPackageName
} = require('../../protect/index-format');

// 只引用函数，模块本身不加载 terser（terser 是在 createScriptMinifier 里懒加载的）
const {scrambleStrings} = require('./minify-script');

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
 * 编译单个脚本（或过程），同时把生成的 factory 源码文本取出来。
 *
 * 如果提供了 minifier，会对源码做压缩/改名；压完立刻用它自己求值一次做自检，
 * 一旦压坏了（求值不出函数）就自动退回未压缩的源码。
 *
 * @param {object} script 中间表示里的脚本对象（ir.entry 或 ir.procedures[变体]）
 * @param {object} ir 中间表示
 * @param {object} target 目标（角色/舞台）
 * @param {object} deps loadCompiler() 的结果
 * @param {object} [context] {minifier, minifyStats}
 * @returns {{fn: Function, source: string, rawSource: string}}
 *          source 是**要内嵌进索引**的源码（压缩过就是压缩版）；
 *          rawSource 一定是未压缩版 —— 依赖扫描必须用它，见下面的注释。
 */
const compileOne = (script, ir, target, deps, context) => {
  const {JSGenerator, jsexecute} = deps;
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

  // ⚠️ 压缩会把工厂函数的形参 `runtime` 改名（terser 的 mangle 会重命名参数），
  //    于是 `runtime.getOpcodeFunction("music_xxx")` 变成 `n.getOpcodeFunction("music_xxx")`。
  //    依赖扫描（collectRuntimeRefs）靠这段文本找扩展，所以**必须扫未压缩源码**。
  //    踩过的坑：曾经直接在压缩后的产物上扫，结果扩展需求全空，
  //    运行时报 `blockFunction is not a function`。
  if (context && typeof context.minifier === 'function') {
    const minified = minifyWithFallback(source, jsexecute, context);
    if (typeof minified === 'string') return {fn, source: minified, rawSource: source};
  }

  return {fn, source, rawSource: source};
};

/**
 * 压缩 → 字符串表混淆 → 自检。任何一步出问题都退回上一个能用的版本
 * —— 保护可以打折，产物不能打不开。
 *
 * 两级都是「先做、再求值自检、坏了就退」：
 *   1. terser 压缩（体积）
 *   2. 字符串表（可读性）—— 失败就退回压缩版，压缩版也失败就退回原源码
 *
 * @returns {string|null} 可直接内嵌进索引的源码；全失败时返回 null（调用方用原源码）
 */
const minifyWithFallback = (source, jsexecute, context) => {
  const {minifier, minifyStats, scramble = true} = context;  try {
    const minified = minifier(source);
    if (typeof minified !== 'string' || minified.length === 0) return null;
    // 压缩后必须仍然求值出函数，否则说明优化动坏了语义
    if (typeof jsexecute.scopedEval(minified) !== 'function') return null;

    let finalSource = minified;
    if (scramble) {
      try {
        const scrambled = scrambleStrings(minified);
        // 字符串表变换同样要自检：坏掉就保留压缩版，不要连压缩一起丢掉
        if (typeof scrambled === 'string' && scrambled.length > 0 &&
            typeof jsexecute.scopedEval(scrambled) === 'function') {
          finalSource = scrambled;
        }
      } catch (e) {
        // 混淆失败不影响正确性，静默用压缩版
      }
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
 * 编译一个脚本线程（与该脚本同属一个目标的所有自定义积木也会一起编译）。
 */
const compileThread = (thread, deps, context) => {
  const {IRGenerator, IROptimizer} = deps;
  const ir = new IRGenerator(thread).generate();
  new IROptimizer(ir).optimize();

  const target = thread.target;
  const entry = compileOne(ir.entry, ir, target, deps, context);

  const sources = {[ENTRY_KEY]: entry.source};
  // 未压缩的一份，只给依赖扫描用（压缩会改掉形参名，见 compileOne 里的说明）
  const rawSources = {[ENTRY_KEY]: entry.rawSource};
  for (const variant of Object.keys(ir.procedures)) {
    // 变体名形如 Z<proccode>（非跳帧）/ W<proccode>（跳帧），与 jsexecute 的约定一致
    const compiled = compileOne(ir.procedures[variant], ir, target, deps, context);
    sources[variant] = compiled.source;
    rawSources[variant] = compiled.rawSource;
  }

  return {
    sources,
    rawSources,
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
    ? {count: 0, failed: 0, originalBytes: 0, minifiedBytes: 0, firstError: null}
    : null;
  // scramble: 在压缩之外再做一层「字符串抽表」，让生成码里的文案/变量 id 不再可读
  const context = activeMinifier
    ? {minifier: activeMinifier, minifyStats, scramble}
    : null;

  const targets = [];
  const failures = [];
  const extensionCache = new Map();
  /** @type {Map<string, string>} 扩展 id -> URL（'' 表示内置扩展） */
  const extensionRequirements = new Map();
  const addonCodes = new Set();
  let scriptCount = 0;
  let compiledCount = 0;
  let sourceBytes = 0;

  for (const target of vm.runtime.targets) {
    const scripts = {};
    const targetScripts = target.blocks.getScripts();
    for (const topBlockId of targetScripts) {
      scriptCount += 1;
      const thread = new Thread(topBlockId);
      thread.target = target;
      thread.blockContainer = target.blocks;
      try {
        const {sources, rawSources, executableHat} = compileThread(thread, deps, context);
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

        const packed = {e: sources[ENTRY_KEY], h: executableHat};
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
      targets.push({n: target.getName(), st: target.isStage ? 1 : 0, s: scripts});
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
    stats: {
      targets: targets.length,
      scripts: scriptCount,
      compiled: compiledCount,
      failed: failures.length,
      sourceBytes,
      indexBytes: indexText.length,
      extensions: extensionMap,
      addonCodes: Array.from(addonCodes),
      minified: minifyStats ? minifyStats.count : 0,
      minifyFailed: minifyStats ? minifyStats.failed : 0,
      minifyError: minifyStats ? minifyStats.firstError : null,
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
