/*
 * 打包期驱动：加载工程 → 预编译全部脚本 → （可选）摘掉积木 → 产出新的 project.json。
 *
 * 这是「保护」与「提速」两条诉求的公共入口：
 *   - stripBlocks = true  → 产物里不再有积木逻辑，无法用官方 Unpackager 之类工具还原（保护）
 *   - 两种模式都会把编译好的 JS 内嵌进产物，运行时跳过编译（提速）
 *
 * ⚠️ 代码生成受 compilerOptions.warpTimer 影响（irgen.js 把 runtime.compilerOptions.warpTimer
 *    写进 IR，jsgen 再据此决定「warp 模式下是否让出」），所以打包期用的 warpTimer 必须和
 *    产物里设置的完全一致，否则行为会漂移。
 *
 * ⚠️ 千万不能在生成索引之后再次跑 ID 优化器（minify/sb3）：索引是按顶层积木 id 索引的，
 *    重排 id 会让索引全部失配。
 *
 * 本文件用 CommonJS 写，方便 Node 直接 require 做回归测试；
 * 在浏览器侧它只通过动态 import 加载，避免把 scratch-vm 塞进主包。
 */

const {compileProject, verifyIndex} = require('./compile');
const {stripProjectBlocks} = require('./skeleton');

const PROGRESS = {
  load: 0.15,
  compile: 0.55,
  verify: 0.8,
  strip: 0.9
};

const toIndexText = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

/**
 * 放开扩展的安全限制。
 *
 * ⚠️ 这里必须直接改 `vm.extensionManager.securityManager` 上的方法：
 *    scratch-vm 只在 VirtualMachine 上暴露 `securityManager` 属性，
 *    并没有 `vm.setExtensionSecurityManager()` 这个方法
 *    （那个名字是 Scaffolding 包装类上的，见 scaffolding.js）。
 *
 * 放开的内容与产物运行时的行为对齐（packager.js 里对 scaffold 也是这么设的）：
 *   - canLoadExtensionFromProject → true：工程内嵌的自定义扩展允许加载
 *   - getSandboxMode → 'unsandboxed'：构建期没有 worker/iframe 可用，
 *     而且产物本身就是按 unsandboxed 加载的，两边必须一致
 */
const openExtensionSecurity = (vm) => {
  const securityManager = vm.extensionManager && vm.extensionManager.securityManager;
  if (!securityManager) return;
  securityManager.canLoadExtensionFromProject = () => true;
  securityManager.getSandboxMode = () => 'unsandboxed';
  // vm.securityManager 是构造时对上面那个对象的引用拷贝，一起兜住
  if (vm.securityManager) {
    vm.securityManager.canLoadExtensionFromProject = () => true;
    vm.securityManager.getSandboxMode = () => 'unsandboxed';
  }
};

/** 造一个「无渲染器、无存储」的构建 VM（编译只需要积木和扩展，不需要素材） */
const makeBuildVm = (compilerOptions) => {
  // 只有走到这个模块（异步 chunk）时才会把 scratch-vm 拉进来
  const VM = require('scratch-vm');
  const vm = new VM();
  vm.setCompilerOptions({
    enabled: true,
    warpTimer: !!(compilerOptions && compilerOptions.warpTimer)
  });
  return vm;
};

/**
 * 加载工程，并尽量让工程引用的扩展就位。
 *
 * ⚠️ 顺序很关键：必须先放开安全策略、再装扩展，最后才 loadProject。
 *    `vm.loadProject()` 内部会在反序列化时就调用 `_loadExtensions()` 处理工程引用的扩展
 *    （virtual-machine.js `_loadExtensions`），插件不在 VM 里、又不在 `extensionURLs`
 *    和 tw-default-extension-urls 里，就会直接抛 `Unknown extension: <id>` ——
 *    也就是说 loadProject 之后再补装载根本来不及。
 *
 * ⚠️ 放开限制后扩展是**真的会去加载**的，而加载可能失败：例如在没有 DOM 的环境里
 *    加载非沙箱扩展会炸在 `appendChild`，失败会让 `Promise.all` 连累 `loadProject` 一起 reject。
 *    所以做两级降级：
 *      一级：放开限制（最理想 —— 扩展都能用，引用它们的脚本都能编译）
 *      二级：用默认策略（拒绝加载工程内嵌扩展）。这样反序列化不会再因扩展而失败，
 *            代价只是引用那些扩展的脚本编译不了、退回「保留积木」，其余脚本照常预编译。
 *            总比整份放弃预编译强。
 */
const createBuildVm = async (projectBuffer, compilerOptions, extraExtensions, warnings) => {
  const vm = makeBuildVm(compilerOptions);
  openExtensionSecurity(vm);
  await loadExtraExtensions(vm, extraExtensions, warnings);
  try {
    await vm.loadProject(projectBuffer);
    return vm;
  } catch (error) {
    const message = (error && error.message) || `${error}`;
    // 工程引用了拿不到 URL 的扩展：二级降级也救不了（还是会抛同样的错），如实抛给上层
    if (/^Unknown extension:/.test(message)) throw error;
    warnings.push(`放开扩展限制后加载工程失败（${message}），改为不加载工程内嵌扩展重试`);
  }

  const fallbackVm = makeBuildVm(compilerOptions);
  await loadExtraExtensions(fallbackVm, extraExtensions, warnings);
  await fallbackVm.loadProject(projectBuffer);
  return fallbackVm;
};

/**
 * @param {object} params
 * @param {ArrayBuffer|Uint8Array} params.projectBuffer sb3 原始字节（必须是「已优化过 ID」的那份，
 *        也就是 packager 的 this.project.arrayBuffer）
 * @param {object} params.projectJSON 与上面同一份字节里的 project.json（会被就地修改）
 * @param {Function} params.JSZip 注入 JSZip 构造器（打包器已经有一份）
 * @param {boolean} params.stripBlocks 是否摘掉积木（= removeProjectData）
 * @param {{warpTimer: boolean}} params.compilerOptions 与产物一致的编译器选项
 * @param {object|Map<string,string>} [params.extensionURLs] project.json 里的 extensionURLs
 * @param {string[]} [params.extraExtensions] 打包器 options.extensions（产物会主动加载的自定义扩展）
 * @param {boolean} [params.minify] 是否压缩生成码（默认 true，terser 不可用时自动跳过）
 * @param {(progress: number, stage: string) => void} [params.onProgress]
 * @returns {Promise<{ok: boolean, index: object, indexText: string, stats: object, failures: Array, warnings: string[], strippedBuffer: (Uint8Array|null)}>}
 */
const buildPrecompiledProject = async (params) => {
  const {
    projectBuffer,
    projectJSON,
    JSZip,
    stripBlocks,
    compilerOptions,
    extensionURLs,
    extraExtensions = [],
    minify: minifyOption,
    onProgress = () => {}
  } = params;
  const options = {minify: minifyOption};

  const warnings = [];
  const report = (progress, stage) => onProgress(progress, stage);

  report(0.05, 'load');
  let vm;
  try {
    vm = await createBuildVm(projectBuffer, compilerOptions, extraExtensions, warnings);
  } catch (error) {
    // 最常见的原因：工程引用了我们拿不到 URL 的第三方扩展（Gandi / CCW / 各类改版 IDE）。
    // 这种情况下没法编译（引用它的脚本只会退回解释器），而且产物本身也跑不起来，
    // 所以直接放弃预编译并如实告诉用户，而不是打一个半残的包。
    const message = (error && error.message) || String(error);
    const unknown = /^Unknown extension:\s*(.+)$/.exec(message);
    return {
      ok: false,
      index: null,
      indexText: null,
      stats: null,
      failures: [],
      warnings: [
        ...warnings,
        unknown
          ? `工程用到了未提供的扩展「${unknown[1]}」，无法在打包期编译，已跳过预编译保护（请先把该扩展加进打包器的扩展列表）`
          : `构建期加载工程失败：${message}`
      ],
      strippedBuffer: null
    };
  }
  report(PROGRESS.load, 'load');

  report(PROGRESS.load, 'compile');
  // 压缩生成码：既减体积，也让「编译后逻辑」更难读 —— 保护和提速两头都受益
  let minify = false;
  if (options.minify !== false) {
    const {isMinifierAvailable} = require('./minify-script');
    if (isMinifierAvailable()) {
      minify = true;
    } else {
      warnings.push('环境里找不到 terser，预编译脚本不会被压缩（体积更大、也更易读）');
    }
  }
  const {index, failures, stats} = compileProject(vm, {extensionURLs, minify});
  if (stats.minifyFailed > 0) {
    warnings.push(`${stats.minifyFailed} 处源码压缩后自检未通过，已退回未压缩版本（首个错误：${stats.minifyError}）`);
  }

  report(PROGRESS.compile, 'verify');
  const verify = verifyIndex(index);

  const result = {
    ok: verify.ok,
    index,
    indexText: toIndexText(index),
    stats,
    failures,
    warnings,
    strippedBuffer: null
  };

  if (!verify.ok) {
    // 打包期都求值不出来的源码，运行时同样不行 —— 直接放弃预编译，退回原始产物
    result.warnings = [
      ...warnings,
      `预编译自检未通过（${verify.broken.length} 个函数无法还原），已放弃预编译保护`,
      ...verify.broken.slice(0, 5).map((item) => `  ${item.topBlockId}/${item.variant || '(entry)'}: ${item.message}`)
    ];
    result.ok = false;
    return result;
  }

  if (!stripBlocks) {
    // 只提速：保留积木，运行时照样能走解释器兜底
    result.ok = true;
    report(1, 'done');
    return result;
  }

  report(PROGRESS.verify, 'strip');
  // extractSkeleton: 连帽子骨架也不留在 project.json 里，搬进索引由运行时重建。
  // 这样解包工具连「作品用了哪些积木」都看不到（残留 opcode 从 6 种降到 0 种）。
  const stripReport = stripProjectBlocks(projectJSON, index, {extractSkeleton: true});
  if (stripReport.skeleton && stripReport.skeleton.size > 0) {
    // 骨架挂在对应目标的 t[i].k 上，运行时按角色名找回
    const byName = new Map();
    for (const entry of index.t || []) byName.set(entry.n, entry);
    for (const [name, blocks] of stripReport.skeleton) {
      const entry = byName.get(name);
      if (entry) entry.k = blocks;
    }
  }
  result.stats = {...stats, ...stripReport.stats};

  const strippedJson = JSON.stringify(projectJSON);
  const zip = await JSZip.loadAsync(projectBuffer);
  zip.file('project.json', strippedJson);
  result.strippedBuffer = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE'
  });

  // 索引是在剥离之后才带上 k，所以这里要重新生成文本
  result.indexText = toIndexText(index);

  const strippedBytes = result.strippedBuffer.length;
  const originalBytes = projectBuffer.byteLength || projectBuffer.length;
  warnings.push(`原始工程数据 ${(originalBytes / 1024).toFixed(0)} KB → 剥离逻辑后 ${(strippedBytes / 1024).toFixed(0)} KB`);
  if (stripReport.stats.scriptsMissingFromProject > 0) {
    // 这些是 VM 合成出来的幽灵积木（典型来源：指向已不存在角色的角色专属监视器），
    // project.json 里没有它们，所以骨架里也装不下，运行时会被报成 missing。
    warnings.push(
      `${stripReport.stats.scriptsMissingFromProject} 个顶层积木只存在于 VM 里（project.json 里没有，` +
      `多半是监视器合成的），无法进骨架，运行时会被跳过`
    );
  }
  result.stats.strippedBytes = strippedBytes;
  result.stats.originalBytes = originalBytes;
  result.stats.projectJsonBytes = strippedJson.length;

  report(1, 'done');
  return result;
};

/**
 * 把打包器要注入产物的自定义扩展也装进构建 VM。
 *
 * 传入的是 `options.extensions`：一组扩展 URL（如果开了 bakeExtensions 则可能是 data: URI）。
 * 失败不致命：只是引用它的脚本会编译不了、退回解释器（积木被保留），产物照旧能开。
 */
const loadExtraExtensions = async (vm, urls, warnings) => {
  if (!urls || urls.length === 0) return;
  for (const url of urls) {
    if (typeof url !== 'string' || url.length === 0) continue;
    // loadExtensionURL 内部会按扩展 id 去重（extension-manager.js isExtensionLoaded），
    // 这里不需要自己判重
    try {
      await vm.extensionManager.loadExtensionURL(url);
    } catch (error) {
      warnings.push(`构建 VM 无法加载扩展 ${url}：${(error && error.message) || error}（引用它的脚本将保留积木）`);
    }
  }
};

module.exports = {
  buildPrecompiledProject
};
