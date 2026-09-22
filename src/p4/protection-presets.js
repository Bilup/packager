/*
 * 「混淆打包」的分级预设。
 *
 * 底层仍然是 4 个独立开关（Node API / 命令行继续直接用它，签名不变）：
 *   obfuscateJS        把运行时脚本换成 Base64 分片，运行时再解码
 *   precompileScripts  打包期就把脚本编译好内嵌，运行时不再编译
 *   removeProjectData  在预编译之上，把积木逻辑从 project.json 里摘掉
 *   antiTamper         禁用右键 / F12 / 开发者工具
 *
 * 这里只负责「哪一级开哪些」，集中一份，UI 的选项和解释都读它 ——
 * 免得界面上的说法和真正开启的开关对不上（这类不一致很难被发现）。
 *
 * ⚠️ 顺序是单调递增的：low ⊂ medium ⊂ high。加新等级时请保持这个性质，
 *    否则用户从「高」降到「中」会得到意外的组合。
 *
 * 加密（encryptProjectData）**不在**这张表里：它是独立的一组选项，
 * 对数据做 XOR 而不是对代码做混淆，语义不同，所以界面上单独一块。
 */

/** 受这四个开关控制的选项键（顺序即界面上「自定义」时的展示顺序） */
export const PROTECTION_FLAGS = [
  'obfuscateJS',
  'precompileScripts',
  'removeProjectData',
  'antiTamper'
];

export const PROTECTION_LEVELS = [
  {
    id: 'off',
    flags: {obfuscateJS: false, precompileScripts: false, removeProjectData: false, antiTamper: false}
  },
  {
    id: 'low',
    flags: {obfuscateJS: true, precompileScripts: false, removeProjectData: false, antiTamper: false}
  },
  {
    id: 'medium',
    flags: {obfuscateJS: true, precompileScripts: true, removeProjectData: false, antiTamper: false}
  },
  {
    id: 'high',
    flags: {obfuscateJS: true, precompileScripts: true, removeProjectData: true, antiTamper: true}
  }
];

/** 落在这四组组合之外的（用户自己勾出来的）就叫自定义 */
export const CUSTOM_LEVEL = 'custom';

export const PROTECTION_LEVEL_IDS = PROTECTION_LEVELS
  .map((level) => level.id)
  .concat(CUSTOM_LEVEL);

/**
 * 从当前选项反推等级。
 *
 * 故意做成「推导」而不是「再存一个 level 字段」：level 只是一个视图，
 * 真正生效的永远只有那 4 个开关。存两份必然会不同步（用户改了一处、另一处没跟上）。
 *
 * @param {object} options
 * @returns {string} `off` / `low` / `medium` / `high` / `custom`
 */
export const detectProtectionLevel = (options) => {
  for (const level of PROTECTION_LEVELS) {
    if (PROTECTION_FLAGS.every((flag) => !!options[flag] === level.flags[flag])) {
      return level.id;
    }
  }
  return CUSTOM_LEVEL;
};

/**
 * 把某个等级的开关写进选项对象（就地修改，方便直接作用于 `$options`）。
 * @param {object} options
 * @param {string} id 等级 id；未知 id 或 `custom` 不做任何事
 * @returns {boolean} 是否真的应用了
 */
export const applyProtectionLevel = (options, id) => {
  const level = PROTECTION_LEVELS.find((item) => item.id === id);
  if (!level) return false;
  for (const flag of PROTECTION_FLAGS) {
    options[flag] = level.flags[flag];
  }
  return true;
};

/** 某个等级具体开了哪些开关（用于界面上的「本级别会开启：…」） */
export const protectionLevelFlags = (id) => {
  const level = PROTECTION_LEVELS.find((item) => item.id === id);
  if (!level) return [];
  return PROTECTION_FLAGS.filter((flag) => level.flags[flag]);
};
