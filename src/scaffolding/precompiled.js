/*
 * 运行时：把打包期内嵌进来的预编译脚本装进 VM。
 *
 * 装载后的效果：
 *   1. 每个脚本的编译结果直接进 VM 自己的编译缓存（blocks.cacheCompileResult），
 *      于是 Thread.tryCompile 会命中缓存、完全跳过编译 —— 启动和首次运行都更快；
 *   2. 因为不再需要现场编译，作品里的积木骨架即使没有逻辑也能正常跑，
 *      这是「产物里不含积木逻辑」得以成立的前提。
 *
 * ⚠️ 扩展加载顺序很重要：
 *   编译器为扩展积木生成的是 `runtime.getOpcodeFunction("music_restForBeats")`，
 *   这些函数在工厂函数**求值时就固化进闭包**了。所以必须
 *   「先 ensurePrecompiledExtensions() → 再 installPrecompiledScripts()」，
 *   顺序反了就会得到 undefined，运行时炸在 `blockFunction is not a function`。
 *   直接调用 applyPrecompiled() 可以一次性把顺序做对。
 *
 * 本文件用 CommonJS 写，方便 Node 直接 require 做回归测试。
 */

const {
  parseIndex,
  parseExtensions,
  parseAddonCodes,
  collectRuntimeRefs,
  extensionIdFromCompilerPackageName
} = require('../protect/index-format');

let cachedScopedEval = null;
const getScopedEval = () => {
  if (!cachedScopedEval) {
    // 与打包期生成源码时用的是同一个模块、同一份实现
    cachedScopedEval = require('scratch-vm/src/compiler/jsexecute').scopedEval;
  }
  return cachedScopedEval;
};

const toIndexObject = (index) => (typeof index === 'string' ? JSON.parse(index) : index);

/**
 * 按索引声明把扩展装好。
 *
 * 积木被摘掉之后，sb3 反序列化再也扫不到扩展 opcode，内置扩展不会被自动加载，
 * 所以这里要显式补上。
 *
 * @param {object} vm
 * @param {object|string} index
 * @returns {Promise<{loaded: string[], skipped: string[], failed: Array, addons: string[]}>}
 */
const ensurePrecompiledExtensions = async (vm, index) => {
  const parsed = toIndexObject(index);
  const declared = parseExtensions(parsed);
  const report = {loaded: [], skipped: [], failed: [], addons: []};

  const manager = vm.extensionManager || (vm.runtime && vm.runtime.extensionManager);
  if (!manager) {
    report.failed.push({id: '*', message: '这个 VM 没有 extensionManager，无法加载扩展'});
    return report;
  }

  const isLoaded = (id) =>
    typeof manager.isExtensionLoaded === 'function' && manager.isExtensionLoaded(id);

  for (const {id, url} of declared) {
    if (isLoaded(id)) {
      report.skipped.push(id);
      continue;
    }
    try {
      if (!url && typeof manager.isBuiltinExtension === 'function' && manager.isBuiltinExtension(id)) {
        manager.loadExtensionIdSync(id);
        report.loaded.push(id);
        continue;
      }
      // 自定义扩展（有 URL）以及「按 id 兜底」的情况都走这里
      if (typeof manager.loadExtensionURL === 'function') {
        await manager.loadExtensionURL(url || id);
        report.loaded.push(id);
        continue;
      }
      report.failed.push({id, message: '这个 VM 不支持加载扩展'});
    } catch (error) {
      report.failed.push({id, message: `${(error && error.message) || error}`});
    }
  }

  // addon 积木只能由宿主 App 注册；注册不上就是硬故障，必须报出来而不是静默
  for (const code of parseAddonCodes(parsed)) {
    const addon = vm.runtime && typeof vm.runtime.getAddonBlock === 'function'
      ? vm.runtime.getAddonBlock(code)
      : null;
    if (addon && typeof addon.callback === 'function') report.skipped.push(`addon:${code}`);
    else report.addons.push(code);
  }

  return report;
};

/**
 * 把索引里的编译结果装进 VM 的编译缓存。
 *
 * 前置条件：索引声明的扩展已经加载好（见 ensurePrecompiledExtensions）。
 *
 * @param {object} vm 已经加载完作品的 VM
 * @param {object|string} index 预编译索引（compile.js 的产物，或它的 JSON 文本）
 * @param {object} [options]
 * @param {Function} [options.scopedEval] 注入求值实现（测试用）
 * @param {boolean} [options.requireExtensions=true] 扩展没加载好时是否拒绝装载（默认拒绝，早失败好过晚崩）
 * @returns {{installed: number, targets: number, missing: Array, failed: Array, compilerForced: boolean, extensions: string[]}}
 */
const installPrecompiledScripts = (vm, index, options = {}) => {
  const scopedEval = options.scopedEval || getScopedEval();
  const {requireExtensions = true} = options;
  const parsedIndex = toIndexObject(index);
  const parsed = parseIndex(parsedIndex);
  const runtime = vm.runtime;

  const report = {
    installed: 0,
    targets: 0,
    missing: [],
    failed: [],
    compilerForced: false,
    extensions: []
  };

  for (const {id} of parseExtensions(parsedIndex)) report.extensions.push(id);

  // 扩展没就位的话，源码里固化的 getOpcodeFunction(...) 会是 undefined，跑起来必炸。
  // 与其等到运行时崩在某个积木上，不如现在就说清楚。
  if (requireExtensions) {
    const manager = vm.extensionManager || (runtime && runtime.extensionManager);
    const notReady = report.extensions.filter((id) =>
      !(manager && typeof manager.isExtensionLoaded === 'function' && manager.isExtensionLoaded(id)));
    if (notReady.length > 0) {
      report.failed.push({
        target: '*',
        topBlockId: '*',
        message: `这些扩展还没加载，拒绝装载预编译脚本：${notReady.join(', ')}（必须先调用 ensurePrecompiledExtensions）`
      });
      return report;
    }
  }

  // 积木被摘掉了，编译缓存必须生效，否则线程会退回解释器（然后什么都跑不了）
  if (runtime.compilerOptions && !runtime.compilerOptions.enabled) {
    if (vm.setCompilerOptions) {
      vm.setCompilerOptions({enabled: true, warpTimer: runtime.compilerOptions.warpTimer});
    }
    report.compilerForced = true;
  }

  for (const target of runtime.targets) {
    const entry = parsed.get(target.getName());
    if (!entry) continue;
    if (entry.isStage !== !!target.isStage) continue;
    report.targets += 1;

    // 脚本发光需要整条积木链，骨架里没有；提前关掉避免运行时去找不存在的积木
    if (target.blocks) target.blocks.forceNoGlow = true;

    for (const [topBlockId, packed] of entry.scripts) {
      if (!target.blocks || !target.blocks.getBlock(topBlockId)) {
        // 骨架里找不到这个顶层积木：说明打包期剥离逻辑出问题，宁可报出来也不要静默
        report.missing.push({target: target.getName(), topBlockId});
        continue;
      }
      try {
        const procedures = {};
        for (const variant of Object.keys(packed.procedures)) {
          procedures[variant] = scopedEval(packed.procedures[variant]);
        }
        target.blocks.cacheCompileResult(topBlockId, {
          startingFunction: scopedEval(packed.entry),
          procedures,
          executableHat: packed.executableHat
        });
        report.installed += 1;
      } catch (error) {
        report.failed.push({
          target: target.getName(),
          topBlockId,
          message: `${(error && error.message) || error}`
        });
      }
    }
  }

  return report;
};

/**
 * 推荐入口：先加载扩展、再装编译缓存，顺序不会错。
 *
 * @param {object} vm
 * @param {object|string} index
 * @param {object} [options] 透传给 installPrecompiledScripts
 * @returns {Promise<{extensions: object, install: object, ok: boolean}>}
 */
const applyPrecompiled = async (vm, index, options = {}) => {
  const extensions = await ensurePrecompiledExtensions(vm, index);
  const install = installPrecompiledScripts(vm, index, options);
  return {
    extensions,
    install,
    ok: install.failed.length === 0 && extensions.failed.length === 0
  };
};

/**
 * 自检：索引里所有源码引用到的 opcode / 扩展对象，在当前 VM 上都应该就位。
 * 在真正开跑之前调用，可以把「产物打不开」变成一条明确的错误信息。
 *
 * 两类都要查：
 *   - `runtime.getOpcodeFunction(opcode)` 必须能拿到函数
 *   - `runtime.ext_<name>` 指向的扩展必须是已加载（核心扩展除外），
 *     否则求值时就炸在 `Cannot read properties of undefined`
 *
 * @param {object} vm
 * @param {object|string} index
 * @returns {{ok: boolean, missing: Array<{opcode: string, extension: string}>}}
 */
const verifyRuntimeRefs = (vm, index) => {
  const parsedIndex = toIndexObject(index);
  const sources = [];
  for (const target of parsedIndex.t || []) {
    for (const topBlockId of Object.keys(target.s || {})) {
      const packed = target.s[topBlockId];
      if (packed.e) sources.push(packed.e);
      for (const variant of Object.keys(packed.p || {})) sources.push(packed.p[variant]);
    }
  }
  const {opcodes, extensionNames} = collectRuntimeRefs(sources);
  const runtime = vm.runtime;
  const manager = vm.extensionManager || (runtime && runtime.extensionManager);
  const missing = [];
  for (const opcode of opcodes) {
    const fn = runtime && typeof runtime.getOpcodeFunction === 'function'
      ? runtime.getOpcodeFunction(opcode)
      : null;
    if (typeof fn !== 'function') {
      missing.push({opcode, extension: opcode.split('_')[0]});
    }
  }
  for (const name of extensionNames) {
    const id = extensionIdFromCompilerPackageName(name);
    if (manager && typeof manager.isCoreExtension === 'function' && manager.isCoreExtension(id)) continue;
    const loaded = manager && typeof manager.isExtensionLoaded === 'function' && manager.isExtensionLoaded(id);
    if (!loaded) missing.push({opcode: `ext_${name}`, extension: id});
  }
  return {ok: missing.length === 0, missing};
};

module.exports = {
  ensurePrecompiledExtensions,
  installPrecompiledScripts,
  applyPrecompiled,
  verifyRuntimeRefs
};
