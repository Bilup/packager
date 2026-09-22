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
  parseSkeletons,
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

let cachedSb3 = null;
const getSb3 = () => {
  if (!cachedSb3) {
    cachedSb3 = require('scratch-vm/src/serialization/sb3');
  }
  return cachedSb3;
};

const toIndexObject = (index) => (typeof index === 'string' ? JSON.parse(index) : index);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 按索引声明把扩展装好。
 *
 * 积木被摘掉之后，sb3 反序列化再也扫不到扩展 opcode，内置扩展不会被自动加载，
 * 所以这里要显式补上。
 *
 * ⚠️ 两条来自真实事故的经验：
 *   1. **产物里启动扩展加载的地方是「发射即忘」的**（`loadExtensionURL()` 没有 await，
 *      见 packager.js 生成的 `__BILUP_EXTENSION_LOADS__`）。所以这里不能只看一眼
 *      `isExtensionLoaded()` 就下结论 —— 那会输给竞态，把「正在加载」误判成「加载不了」，
 *      进而让整份预编译脚本被拒绝。所以先等 `loadingAsyncExtensions` 归零（有上限）。
 *   2. 失败要**逐个重试**，并且把失败的 URL 一起报出来 —— 内联的 `data:` URL 失败
 *      和远程 URL 失败完全是两回事，用户需要知道是哪一种。
 *
 * @param {object} vm
 * @param {object|string} index
 * @param {object} [options]
 * @param {number} [options.waitForPendingMs=15000] 等在途扩展加载的上限（毫秒）
 * @param {number} [options.retries=1] 每个扩展失败后的重试次数
 * @returns {Promise<{loaded: string[], skipped: string[], failed: Array, addons: string[], waitedMs: number}>}
 */
const ensurePrecompiledExtensions = async (vm, index, options = {}) => {
  const {waitForPendingMs = 15000, retries = 1} = options;
  const parsed = toIndexObject(index);
  const declared = parseExtensions(parsed);
  const report = {loaded: [], skipped: [], failed: [], addons: [], waitedMs: 0};

  const manager = vm.extensionManager || (vm.runtime && vm.runtime.extensionManager);
  if (!manager) {
    report.failed.push({id: '*', message: '这个 VM 没有 extensionManager，无法加载扩展'});
    return report;
  }

  const isLoaded = (id) =>
    typeof manager.isExtensionLoaded === 'function' && manager.isExtensionLoaded(id);

  // 已经在加载中的先等它们落地 —— 否则会把「正在加载」误判成「加载不了」
  const pending = () => (typeof manager.loadingAsyncExtensions === 'number' ? manager.loadingAsyncExtensions : 0);
  if (pending() > 0) {
    const started = Date.now();
    while (pending() > 0 && Date.now() - started < waitForPendingMs) {
      await sleep(50);
    }
    report.waitedMs = Date.now() - started;
  }

  for (const {id, url} of declared) {
    if (isLoaded(id)) {
      report.skipped.push(id);
      continue;
    }

    let lastError = null;
    for (let attempt = 0; attempt <= retries && !isLoaded(id); attempt++) {
      try {
        if (!url && typeof manager.isBuiltinExtension === 'function' && manager.isBuiltinExtension(id)) {
          manager.loadExtensionIdSync(id);
          break;
        }
        // 自定义扩展（有 URL）以及「按 id 兜底」的情况都走这里
        if (typeof manager.loadExtensionURL === 'function') {
          await manager.loadExtensionURL(url || id);
          break;
        }
        lastError = new Error('这个 VM 不支持加载扩展');
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (isLoaded(id)) {
      if (report.loaded.indexOf(id) === -1) report.loaded.push(id);
      continue;
    }
    report.failed.push({
      id,
      url: url || '',
      // 内联的 data: URL 失败和远程 URL 失败是两回事，把 URL 形态也带上
      kind: !url ? 'builtin' : (url.startsWith('data:') ? 'inlined' : 'remote'),
      message: `${(lastError && lastError.message) || '加载后仍未注册到 extensionManager'}`
    });
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
 * 把索引里携带的「脚本骨架」重建进各目标的 blocks 容器。
 *
 * 提取模式下 project.json 里一个积木都没有，而运行时需要：
 *   - 顶层积木存在，`blocks.getScripts()` 才找得到脚本、`startHats` 才能按字段匹配启动；
 *   - 顶层积木的 id 存在，编译缓存才能按 id 命中打包期塞进来的函数。
 * 所以这里把它们回填进去。
 *
 * ⚠️ 必须**先全部重建、再开始灌缓存**：
 *    `Blocks.createBlocks()` 内部会 `resetCache()`，它会把已经灌好的 compiledScripts 一起清掉。
 *    调用方（installPrecompiledScripts）已经按这个顺序分了两阶段。
 *
 * ⚠️ 必须过一遍 `sb3.deserializeBlocks()`：
 *    索引里存的是 project.json 的**原始**形态（fields/inputs 都是数组、积木对象没有 id），
 *    而 VM 内部的 blocks 必须是**已解码**形态 —— `getFields()`/`getInputs()` 都是原样返回，
 *    解码这一步只在反序列化 sb3 时做。省掉它会在运行时炸得很难懂，例如
 *    `Cannot read properties of undefined (reading 'toUpperCase')`
 *    （RuntimeScriptCache 拿 `field.value` 去 toUpperCase，而 fields 还是数组）。
 *
 * @param {object} vm
 * @param {object|string} index
 * @returns {{targets: number, blocks: number, missing: string[]}}
 */
const rebuildSkeletonBlocks = (vm, index) => {
  const parsedIndex = toIndexObject(index);
  const skeletons = parseSkeletons(parsedIndex);
  const report = {targets: 0, blocks: 0, missing: []};
  if (skeletons.length === 0) return report;

  const sb3 = getSb3();
  const runtime = vm.runtime;
  const byName = new Map();
  for (const target of runtime.targets) byName.set(target.getName(), target);

  for (const skeleton of skeletons) {
    const target = byName.get(skeleton.name);
    if (!target || !target.blocks) {
      report.missing.push(skeleton.name);
      continue;
    }
    // 深拷贝再解码：deserializeBlocks 是就地改的，而索引对象可能被复用（多次装载 / 克隆）
    const decoded = JSON.parse(JSON.stringify(skeleton.blocks));
    sb3.deserializeBlocks(decoded);
    const blockList = Object.values(decoded);
    report.blocks += blockList.length;
    report.targets += 1;
    if (typeof target.blocks.createBlocks === 'function') {
      target.blocks.createBlocks(blockList);
    } else {
      for (const block of blockList) target.blocks.createBlock(block);
    }
  }

  return report;
};

/**
 * 把索引里的编译结果装进 VM 的编译缓存。
 *
 * 前置条件：索引声明的扩展已经加载好（见 ensurePrecompiledExtensions）。
 *
 * ⚠️ 扩展没就位时**不要整体拒绝**（那是踩过的坑）：
 *   剥离模式下积木已经没了，整体拒绝等于「整个作品变成死的」—— 能打开、按绿旗什么都没反应。
 *   索引 v3 起给每个脚本记了它依赖哪些扩展（`s[].x` + `t[].x`），所以这里可以做到：
 *   **只跳过真正用到失败扩展的那些脚本**，其余照常装、照常跑，并把跳过了哪些如实报出来。
 *   旧索引（没有按脚本依赖）拿不到这份信息时，才退回原来的严格判断。
 *
 * @param {object} vm 已经加载完作品的 VM
 * @param {object|string} index 预编译索引（compile.js 的产物，或它的 JSON 文本）
 * @param {object} [options]
 * @param {Function} [options.scopedEval] 注入求值实现（测试用）
 * @param {boolean} [options.requireExtensions=true] 扩展没加载好时是否启用降级判断（默认开）
 * @param {string[]} [options.missingExtensions] 已知没加载上的扩展 id（由 ensurePrecompiledExtensions 报出来，避免重复探测）
 * @returns {{installed: number, targets: number, missing: Array, failed: Array, skippedByExtension: Array,
 *            compilerForced: boolean, extensions: string[], unavailableExtensions: string[],
 *            unknownDependencies: boolean, skeleton: object}}
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
    skippedByExtension: [],
    compilerForced: false,
    extensions: [],
    unavailableExtensions: [],
    unknownDependencies: false,
    skeleton: null
  };

  for (const {id} of parseExtensions(parsedIndex)) report.extensions.push(id);

  const manager = vm.extensionManager || (runtime && runtime.extensionManager);
  const isReady = (id) =>
    !!(manager && typeof manager.isExtensionLoaded === 'function' && manager.isExtensionLoaded(id));
  // 索引声明了、但当前没就位的扩展
  const notReady = new Set(
    (options.missingExtensions || report.extensions.filter((id) => !isReady(id)))
  );
  report.unavailableExtensions = Array.from(notReady);

  // 旧索引没有「按脚本依赖」这份信息 → 只能退回严格判断：有一条不齐就整体不装
  if (requireExtensions && notReady.size > 0) {
    let anyKnown = false;
    for (const entry of parsed.values()) {
      for (const packed of entry.scripts.values()) {
        // null = 索引没记（v1/v2）；数组（含空数组）= 记了
        if (packed.extensions !== null && packed.extensions !== undefined) anyKnown = true;
      }
    }
    if (!anyKnown) {
      report.unknownDependencies = true;
      report.failed.push({
        target: '*',
        topBlockId: '*',
        message: '这些扩展还没加载，且索引没有记录按脚本的依赖，无法做降级，拒绝装载预编译脚本：' +
          `${report.unavailableExtensions.join(', ')}`
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

  // 阶段一：重建骨架积木。必须全部做完再进阶段二 —— createBlocks 会 resetCache()
  report.skeleton = rebuildSkeletonBlocks(vm, parsedIndex);

  // 阶段二：灌编译缓存
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

      // 这个脚本依赖的扩展有没有缺的？缺了就跳过它，别拖累别的脚本
      const needs = packed.extensions === undefined ? null : packed.extensions;
      const blockedBy = needs === null ? [] : needs.filter((id) => notReady.has(id));
      if (blockedBy.length > 0) {
        report.skippedByExtension.push({
          target: target.getName(),
          topBlockId,
          extensions: blockedBy
        });
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
 * `ok` 的语义是「这份产物完整可跑」：
 * 扩展全就位、脚本全装上、没有跳过的脚本、没有 addon 缺口。
 * 部分降级时 `ok=false` 但 `install.installed > 0` —— 此时作品大体能跑，
 * 只有依赖失败扩展的那些脚本不会动。调用方**必须把结果报出来**，不要静默。
 *
 * @param {object} vm
 * @param {object|string} index
 * @param {object} [options] `ensure`/`install` 两组子选项：
 *   `{ensure: {...}}` 透传给 ensurePrecompiledExtensions，
 *   `{install: {...}}` 透传给 installPrecompiledScripts，其余字段按 install 处理（向后兼容）
 * @returns {Promise<{extensions: object, install: object, ok: boolean, summary: string}>}
 */
const applyPrecompiled = async (vm, index, options = {}) => {
  const ensureOptions = options.ensure || {};
  const installOptions = options.install || {};
  const extensions = await ensurePrecompiledExtensions(vm, index, ensureOptions);

  const unavailable = extensions.failed.map((item) => item.id);
  const install = installPrecompiledScripts(vm, index, {
    ...options,
    ...installOptions,
    missingExtensions: unavailable
  });

  const ok = install.failed.length === 0 &&
    install.missing.length === 0 &&
    install.skippedByExtension.length === 0 &&
    extensions.failed.length === 0 &&
    extensions.addons.length === 0;

  const bits = [`安装 ${install.installed} 个脚本`];
  if (install.skippedByExtension.length > 0) {
    bits.push(`因扩展没就位跳过 ${install.skippedByExtension.length} 个脚本` +
      `（${Array.from(new Set(install.skippedByExtension.flatMap((item) => item.extensions))).join(', ')}）`);
  }
  if (extensions.failed.length > 0) {
    bits.push(`扩展加载失败：${extensions.failed.map((item) => `${item.id}(${item.kind})`).join(', ')}`);
  }
  if (extensions.addons.length > 0) bits.push(`缺少 addon 积木：${extensions.addons.join(', ')}`);
  if (install.missing.length > 0) bits.push(`骨架里缺 ${install.missing.length} 个顶层积木`);
  if (install.failed.length > 0) bits.push(`${install.failed.length} 个脚本求值失败`);

  return {extensions, install, ok, summary: bits.join('；')};
};

/**
 * 自检：索引里声明的东西在当前 VM 上是不是都就位了。
 * 在真正开跑之前调用，可以把「产物打不开」变成一条明确的错误信息。
 *
 * 检查三件事：
 *   1. `index.x` 里声明的扩展必须都已加载（**这是权威来源** —— 源码做过字符串表混淆之后，
 *      `getOpcodeFunction("…")` 里的字面量会变成查表，没法再靠正则从源码里回捞）
 *   2. 源码里出现过的 `getOpcodeFunction(opcode)` 必须能拿到函数
 *   3. 源码里出现过的 `runtime.ext_<name>` 指向的扩展必须是已加载（核心扩展除外）
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

  const isLoaded = (id) =>
    !!(manager && typeof manager.isExtensionLoaded === 'function' && manager.isExtensionLoaded(id));
  const isCore = (id) =>
    !!(manager && typeof manager.isCoreExtension === 'function' && manager.isCoreExtension(id));

  // 1) 索引声明的扩展（权威）
  for (const {id} of parseExtensions(parsedIndex)) {
    if (isCore(id) || isLoaded(id)) continue;
    missing.push({opcode: 'index.x', extension: id});
  }

  // 2) 源码里的 opcode 引用（混淆后可能捞不到，捞到就顺手验一下）
  for (const opcode of opcodes) {
    const fn = runtime && typeof runtime.getOpcodeFunction === 'function'
      ? runtime.getOpcodeFunction(opcode)
      : null;
    if (typeof fn !== 'function') {
      missing.push({opcode, extension: opcode.split('_')[0]});
    }
  }

  // 3) 源码里直呼的扩展对象
  for (const name of extensionNames) {
    const id = extensionIdFromCompilerPackageName(name);
    if (isCore(id) || isLoaded(id)) continue;
    missing.push({opcode: `ext_${name}`, extension: id});
  }

  return {ok: missing.length === 0, missing};
};

module.exports = {
  ensurePrecompiledExtensions,
  rebuildSkeletonBlocks,
  installPrecompiledScripts,
  applyPrecompiled,
  verifyRuntimeRefs
};
