/*
 * 预编译索引的内嵌格式（打包期与运行时共用）。
 *
 * 关键点：**不能用 target.id 做键** —— scratch-vm 里的目标 id 是每次加载时随机生成的
 * （实测两次加载同一个 sb3，Stage/Sprite1 的 id 完全不同），而角色名在一个作品里唯一且稳定，
 * 所以索引按「角色名 + 是否舞台」索引。
 *
 * 紧凑字段命名是为了减小产物体积（这份索引会原样内嵌到输出的 HTML/zip 里）：
 *   {
 *     v: 3,
 *     t: [ { n: 角色名, st: 0|1,
 *            s: { 顶层积木id: { e: 入口源码, p: { 变体: 源码 }, h: 是否可执行帽子,
 *                              x: 这个脚本依赖的扩展在 t[].x 里的下标（base36 字符，可缺省） } },
 *            k: { 积木id: 积木对象 },   // 「脚本骨架」：提取模式下才有，见 parseSkeletons
 *            x: [ 本目标脚本用到的扩展 id ]   // 上面 s[].x 里的字符就是这里的下标
 *          } ],
 *     x: { 扩展id: 扩展URL或"" },   // 编译源码里用到的扩展（全量，v1/v2 时代就有）
 *     a: [ addon积木代号 ]          // 编译源码里用到的 addon 积木（由宿主 App 注册，本包无法自行加载）
 *   }
 *
 * 为什么必须有 x：
 *   scratch-vm 是在反序列化 sb3 时「扫描积木 opcode」来决定加载哪些内置扩展的
 *   （virtual-machine.js 的 _loadExtensions）。积木被摘掉之后这条线索就断了，
 *   而编译产物里 `runtime.getOpcodeFunction("music_restForBeats")` 这类调用
 *   会在工厂函数求值时就把函数引用固化下来，所以扩展必须**在求值之前**就位。
 *
 * 为什么还要「按脚本」记（v3 新增的 t[].x + s[].x）：
 *   原来只知道「这个工程一共需要哪些扩展」，于是运行时只能做**全有或全无**的判断 ——
 *   只要有一个扩展没加载上，就一条脚本都不装。而剥离模式下积木已经没了，
 *   结果是**整个作品直接变成死的**：能打开、但按绿旗什么都不会发生。
 *   有了按脚本的依赖，就可以只跳过真正用到那个扩展的脚本，其余照常装、照常跑，
 *   并把跳过了哪些如实地报出来。
 *
 * 本文件用 CommonJS 写，方便 Node 直接 require（打包器和脚手架两侧都会用到）。
 */

const ENTRY_KEY = '';
const FORMAT_VERSION = 3;

/**
 * 解一个目标里「按脚本记录的扩展依赖」。
 *
 * 存储形态：`target.x` 是扩展 id 数组，脚本上的 `packed.x` 是一串 base36 字符，
 * 每个字符是数组下标。这样多个脚本共用的扩展 id 只存一份。
 *
 * @param {object} target 索引里的目标条目
 * @param {object} packed 索引里的脚本条目
 * @param {boolean} hasPerScriptInfo 整份索引是否具备「按脚本依赖」这份信息（v3+）
 * @returns {string[]|null} 扩展 id 列表；`null` 表示**索引里没有这份信息**
 *   （v1/v2 的旧索引），调用方应当退回「全局要求」的严格判断，而不是当成「无依赖」。
 */
const parseScriptExtensions = (target, packed, hasPerScriptInfo) => {
  // 整份索引都没有这份信息 → 返回 null 表示「未知」
  if (!hasPerScriptInfo) return null;
  // 有这份信息、但这个脚本没标 x → 它不依赖任何扩展（**不是**未知，可以放心装）
  if (!packed || typeof packed.x !== 'string') return [];
  const ids = [];
  const list = Array.isArray(target && target.x) ? target.x : [];
  for (const char of packed.x) {
    const id = list[parseInt(char, 36)];
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
};

/** 把一串扩展 id 编成 `packed.x` 的形态（打包期用） */
const encodeScriptExtensions = (allIds, usedIds) => {
  let out = '';
  for (const id of usedIds) {
    const index = allIds.indexOf(id);
    if (index >= 0 && index < 36) out += index.toString(36);
  }
  return out;
};

/** 把索引转成 Map：`角色名` -> Map：顶层积木 id -> {entry, procedures, executableHat, extensions} */
const parseIndex = (index) => {
  const byTarget = new Map();
  const targets = (index && index.t) || [];
  // 「按脚本依赖」这份信息从 v3 起才有。任何一处出现 t[].x 也认，容忍版本号没跟上。
  const hasPerScriptInfo = ((index && index.v) || 0) >= 3 ||
    targets.some((target) => Array.isArray(target && target.x));
  for (const target of targets) {
    const scripts = new Map();
    for (const topBlockId of Object.keys(target.s || {})) {
      const packed = target.s[topBlockId];
      scripts.set(topBlockId, {
        entry: packed.e,
        procedures: packed.p || {},
        executableHat: !!packed.h,
        // null = 索引没记录（旧索引），调用方按「未知」处理
        extensions: parseScriptExtensions(target, packed, hasPerScriptInfo)
      });
    }
    byTarget.set(target.n, {isStage: !!target.st, scripts});
  }
  return byTarget;
};

/** 索引覆盖到的顶层积木 id 集合（按角色名） */
const parseIndexKeys = (index) => {
  const byTarget = new Map();
  const targets = (index && index.t) || [];
  for (const target of targets) {
    byTarget.set(target.n, new Set(Object.keys(target.s || {})));
  }
  return byTarget;
};

/**
 * 索引里声明的扩展需求。
 * @returns {Array<{id: string, url: string}>} url 为空串表示「VM 内置扩展」
 */
const parseExtensions = (index) => {
  const result = [];
  const declared = (index && index.x) || {};
  for (const id of Object.keys(declared)) {
    result.push({id, url: declared[id] || ''});
  }
  return result;
};

/** 索引里声明的 addon 积木代号（只能由宿主 App 注册，加载不了就要报出来） */
const parseAddonCodes = (index) => {
  const codes = (index && index.a) || [];
  return Array.isArray(codes) ? codes.slice() : [];
};

/**
 * 索引里携带的「脚本骨架」（提取模式下才有）。
 *
 * 提取模式下 project.json 里一个积木都不留，启动脚本所需的顶层积木（帽子）与它们引用的
 * shadow 全部存在这里，由运行时在装载阶段重建进 `target.blocks`
 * （必须早于灌编译缓存 —— `Blocks.createBlocks()` 内部会 resetCache()）。
 *
 * @returns {Array<{name: string, isStage: boolean, blocks: object}>}
 */
const parseSkeletons = (index) => {
  const result = [];
  for (const target of (index && index.t) || []) {
    if (!target.k) continue;
    result.push({name: target.n, isStage: !!target.st, blocks: target.k});
  }
  return result;
};

const serializeIndex = (index) => JSON.stringify(index);
const deserializeIndex = (text) => (typeof text === 'string' ? JSON.parse(text) : text);

/**
 * 从生成的源码里找出运行时会用到、但可能「没被加载」的外部函数引用。
 *
 * 编译器对扩展积木会生成三种调用（见 scratch-vm/src/compiler/jsgen.js）：
 *   runtime.getOpcodeFunction("music_restForBeats")  —— 走兼容层的扩展积木
 *   runtime.getAddonBlock("xxx").callback            —— addon 积木（由宿主 App 注册）
 *   runtime.ext_pen._setPenColorToColor(…)           —— 少量**被编译器硬编码直呼**的扩展
 *
 * 前两种是在工厂函数**求值时**就被固化进闭包的，所以必须在使用前就位。
 * 第三种更麻烦：它是直接访问 `runtime.ext_<name>` 这个对象属性，
 * 扩展没加载时这个属性就是 undefined，求值阶段立刻炸（踩过的坑：pen 积木
 * 报 `Cannot read properties of undefined (reading '_setPenColorToColor')`）。
 * 而 `runtime.ext_<name>` 里的 name 是编译器里的包名，内置包是 `scratch3_looks` 这种，
 * 而 pen 是 `pen`，所以要统一成「扩展 id」再交给上层去判定是不是核心扩展。
 *
 * 打包期与运行时都要用这份逻辑，所以放在这个两边共用的模块里。
 *
 * ⚠️ 调用方请务必传**未压缩**的源码。
 *    terser 的 mangle 会重命名工厂函数的形参，压缩后 `runtime.getOpcodeFunction(...)`
 *    会变成 `n.getOpcodeFunction(...)`。下面的正则虽然已经放宽成「任意标识符」，
 *    不至于因此彻底扫不到，但放宽只是为了兜底 —— 正常路径应当扫原源码。
 *
 * @param {string[]} sources
 * @returns {{opcodes: Set<string>, addonCodes: Set<string>, extensionNames: Set<string>}}
 */
const collectRuntimeRefs = (sources) => {
  const opcodes = new Set();
  const addonCodes = new Set();
  const extensionNames = new Set();
  // jsgen 的 sanitize() 只做 JSON 转义，所以这里反向解转义即可拿回原始代号
  const scan = (regex, sink) => {
    for (const source of sources) {
      if (typeof source !== 'string') continue;
      regex.lastIndex = 0;
      let match = regex.exec(source);
      while (match) {
        try {
          sink.add(JSON.parse(`"${match[1]}"`));
        } catch (e) {
          sink.add(match[1]);
        }
        match = regex.exec(source);
      }
    }
  };
  // 标识符写成 `[\w$]+` 而不是字面量 `runtime`：万一调用方误传了压缩后的源码，
  // 形参已被改名也能扫得到，不会静默丢掉扩展依赖
  scan(/[\w$]+\.getOpcodeFunction\("((?:[^"\\]|\\.)*)"\)/g, opcodes);
  scan(/[\w$]+\.getAddonBlock\("((?:[^"\\]|\\.)*)"\)/g, addonCodes);
  scan(/[\w$]+\.ext_([\w$]+)/g, extensionNames);
  return {opcodes, addonCodes, extensionNames};
};

/**
 * 把编译器里的包名（`ext_<name>` 的 name）归一化成扩展 id。
 * 内置包的包名带 `scratch3_` 前缀（`scratch3_looks` → `looks`），pen 这种则是包名=id。
 * @param {string} name
 * @returns {string}
 */
const extensionIdFromCompilerPackageName = (name) => {
  const PREFIX = 'scratch3_';
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
};

/** 取一份索引里所有脚本的源码（入口 + 过程变体） */
const collectIndexSources = (index) => {
  const sources = [];
  for (const target of (index && index.t) || []) {
    for (const topBlockId of Object.keys(target.s || {})) {
      const packed = target.s[topBlockId];
      if (packed.e) sources.push(packed.e);
      for (const variant of Object.keys(packed.p || {})) sources.push(packed.p[variant]);
    }
  }
  return sources;
};

/** 统计索引规模（用于打包时报告） */
const indexStats = (index) => {
  let scripts = 0;
  let bytes = 0;
  for (const target of (index && index.t) || []) {
    for (const topBlockId of Object.keys(target.s || {})) {
      scripts += 1;
      const packed = target.s[topBlockId];
      bytes += (packed.e || '').length;
      for (const variant of Object.keys(packed.p || {})) {
        bytes += packed.p[variant].length;
      }
    }
  }
  return {scripts, bytes, extensions: Object.keys((index && index.x) || {}).length};
};

module.exports = {
  ENTRY_KEY,
  FORMAT_VERSION,
  parseIndex,
  parseIndexKeys,
  parseExtensions,
  parseScriptExtensions,
  encodeScriptExtensions,
  parseAddonCodes,
  parseSkeletons,
  collectRuntimeRefs,
  extensionIdFromCompilerPackageName,
  collectIndexSources,
  serializeIndex,
  deserializeIndex,
  indexStats
};
