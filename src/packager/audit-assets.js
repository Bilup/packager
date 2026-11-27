/*
 * 打包期素材体检：核对「工程里引用的素材」与「产物里实际存在的文件」。
 *
 * 为什么需要这一步：
 *   产物里素材缺失在运行时的表现是**造型显示成灰色问号 / 一片空白**（造型的 skinId
 *   被置成 -1，或者 loadCostume 直接抛错），而这个失败**完全静默** —— 打包一句错都没有，
 *   控制台也只有一条 log.error。用户看到的就是「打包后素材丢了」，却拿不到任何线索。
 *
 * 查找规则必须和运行时**逐条对齐**，否则体检会说「都在」而运行时依然找不到：
 *   运行时有两条路径按文件名取素材，规则是同一个套路（先精确、再允许一层子目录）：
 *     - packager 生成的 storage helper（packager.js 里的 findFileInZip）
 *     - scratch-vm：serialization/deserialize-assets.js、util/tw-asset-util.js
 *   所以下面 findZipEntry 也按「精确 -> 一层子目录正则 -> 忽略大小写」的顺序找，
 *   最后那条是**比运行时更宽松**的兜底，只用来避免误报（宁可漏报，不要谎报）。
 *
 * 这里只做「核对 + 报告」，不改任何字节：素材为什么会缺（工程本身没带、下载失败、
 * 名字对不上）是调用方该展示给用户的信息，不是这里该猜的。
 */

/** 转义正则元字符 —— 文件名里出现 `(`、`+` 之类时不能让正则整个跑偏 */
const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 判断一段工程数据是不是 zip（sb3 与 sb2 都是 zip，Scratch 1 的 .sb 不是）。
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {boolean}
 */
const isZipBuffer = (buffer) => {
  if (!buffer) return false;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 4) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  // 0x03 0x04 = 普通条目；0x05 0x06 = 空 zip
  return (bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06);
};

/**
 * 一个素材描述里「运行时用哪个文件名去取它」。
 *
 * 顺序与运行时一致：优先 md5ext，其次 assetId + dataFormat。
 * sb3 里这两个通常等价；老工程（只写了 assetId）也能算出来。
 * @param {{md5ext?: string, md5?: string, assetId?: string, dataFormat?: string}} asset
 * @returns {string|null}
 */
const assetFileName = (asset) => {
  if (!asset) return null;
  if (typeof asset.md5ext === 'string' && asset.md5ext.length > 0) return asset.md5ext;
  if (typeof asset.md5 === 'string' && asset.md5.length > 0) return asset.md5;
  if (typeof asset.assetId === 'string' && asset.assetId.length > 0 && asset.dataFormat) {
    return `${asset.assetId}.${asset.dataFormat}`;
  }
  return null;
};

/**
 * 收集工程里被引用的全部素材文件。
 * @param {object} projectJSON 已解析的 project.json
 * @returns {Array<{kind: string, target: string, name: string, file: string}>}
 */
const collectReferencedAssets = (projectJSON) => {
  const result = [];
  const targets = (projectJSON && projectJSON.targets) || [];
  for (const target of targets) {
    const targetName = target.name || '(未命名)';
    for (const costume of target.costumes || []) {
      const file = assetFileName(costume);
      if (file) result.push({kind: 'costume', target: targetName, name: costume.name || '(未命名造型)', file});
    }
    for (const sound of target.sounds || []) {
      const file = assetFileName(sound);
      if (file) result.push({kind: 'sound', target: targetName, name: sound.name || '(未命名声音)', file});
    }
  }
  return result;
};

/**
 * 在 zip 里找素材，规则与运行时对齐（精确 -> 一层子目录 -> 忽略大小写）。
 * @param {object} zip JSZip 实例
 * @param {string} fileName
 * @returns {object|null} JSZip entry
 */
const findZipEntry = (zip, fileName) => {
  const direct = zip.file(fileName);
  if (direct) return direct;

  const matches = zip.file(new RegExp(`^([^/]*/)?${escapeRegExp(fileName)}$`));
  if (matches && matches.length > 0) return matches[0];

  // 兜底：忽略大小写 + 任意深度的子目录。运行时不做这件事，这里放宽只为少误报 ——
  // 报「缺」而其实能找到，比漏报更难排查。
  const wanted = fileName.toLowerCase();
  const files = zip.files || {};
  for (const name of Object.keys(files)) {
    const entry = files[name];
    if (!entry || entry.dir) continue;
    const lower = name.toLowerCase();
    if (lower === wanted || lower.endsWith(`/${wanted}`)) return entry;
  }
  return null;
};

/**
 * 从 zip 里读 project.json 文本。
 * @param {object} zip
 * @returns {Promise<string|null>}
 */
const readProjectJSON = async (zip) => {
  const entry = findZipEntry(zip, 'project.json');
  if (!entry) return null;
  return entry.async('string');
};

/**
 * 体检入口。
 *
 * @param {object} params
 * @param {any} params.JSZip JSZip 构造器（打包器已有一份，避免重复打包）
 * @param {ArrayBuffer|Uint8Array} params.projectBuffer 产物里真正会用的那份工程数据
 * @param {object} [params.projectJSON] 已知的 project.json；不给就从 buffer 里读
 * @returns {Promise<{available: boolean, total: number, missing: Array, duplicates: Array, reason: (string|null)}>}
 *   available=false 表示这份产物不是 zip（例如 Scratch 1 的 .sb），没法用文件名核对；
 *   reason 说明为什么不核对（给调用方展示用）。
 */
const auditAssets = async ({JSZip, projectBuffer, projectJSON}) => {
  const empty = (reason) => ({available: false, total: 0, missing: [], duplicates: [], reason});

  if (!isZipBuffer(projectBuffer)) {
    return empty('工程数据不是 zip（Scratch 1 项目没有独立素材文件），跳过素材核对');
  }
  if (!JSZip) return empty('缺少 JSZip，跳过素材核对');

  let zip;
  try {
    zip = await JSZip.loadAsync(projectBuffer);
  } catch (error) {
    return empty(`工程数据无法按 zip 解析：${(error && error.message) || error}`);
  }

  let json = projectJSON;
  if (!json) {
    try {
      const text = await readProjectJSON(zip);
      json = text ? JSON.parse(text) : null;
    } catch (error) {
      return empty(`工程里的 project.json 无法解析：${(error && error.message) || error}`);
    }
  }
  if (!json) return empty('工程里没有 project.json，跳过素材核对');
  if (!Array.isArray(json.targets)) {
    // Scratch 1/2 的 project.json 是另一套结构（objName + 数字文件名的素材），
    // 按 md5ext 核对没有意义 —— 报「核对通过」比不核对更误导人。
    return empty('工程不是 sb3 结构（Scratch 1/2），素材用数字文件名，跳过核对');
  }

  const referenced = collectReferencedAssets(json);
  const missing = [];
  const seen = new Set();
  const duplicateFiles = new Set();

  for (const item of referenced) {
    const key = `${item.kind}\0${item.file}`;
    if (seen.has(key)) {
      // 同一个文件被多个造型/声音引用是正常的，只核对一次
      continue;
    }
    seen.add(key);
    if (!findZipEntry(zip, item.file)) {
      missing.push(item);
    }
  }

  // 同一份文件名出现在多个目录里：运行时只取第一个匹配，结果取决于 zip 内部顺序。
  // 不是错误，但排障时非常值得知道。
  const names = new Map();
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (!entry || entry.dir) continue;
    const base = name.slice(name.lastIndexOf('/') + 1);
    if (!names.has(base)) names.set(base, []);
    names.get(base).push(name);
  }
  for (const [base, paths] of names) {
    if (paths.length > 1) duplicateFiles.add(base);
  }

  return {
    available: true,
    total: seen.size,
    missing,
    duplicates: Array.from(duplicateFiles),
    reason: null
  };
};

/**
 * 把体检结果整理成一句给用户看的话（没有问题就返回 null）。
 * @param {object} report auditAssets() 的返回值
 * @param {number} [limit] 最多列几个文件名
 * @returns {string|null}
 */
const describeAssetAudit = (report, limit = 3) => {
  if (!report || !report.available) return null;
  if (report.missing.length === 0) return null;
  const head = report.missing
    .slice(0, limit)
    .map((item) => `${item.file}（${item.kind === 'sound' ? '声音' : '造型'}「${item.name}」/ ${item.target}）`)
    .join('、');
  const rest = report.missing.length > limit ? ` 等 ${report.missing.length} 个` : '';
  return `有 ${report.missing.length} 个素材在产物里找不到：${head}${rest}。` +
    '它们运行时不会显示（造型是灰色问号、声音是静音）。' +
    '常见原因：工程本身没带上这些文件、素材下载失败、或工程里的文件名和压缩包里的对不上。';
};

export {
  auditAssets,
  collectReferencedAssets,
  findZipEntry,
  assetFileName,
  isZipBuffer,
  describeAssetAudit
};
