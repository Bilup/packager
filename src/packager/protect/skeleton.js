/*
 * 把「已被预编译」的脚本从 project.json 里摘掉，只留下能启动它们的骨架。
 *
 * 为什么不能直接删掉 blocks：
 * 1. sb3 校验要求每个 target 必须有 blocks 字段；
 * 2. 运行时需要知道有哪些「帽子积木」（绿旗、接收消息、克隆体启动…）才能启动脚本，
 *    而帽子里的 fields（比如接收的消息名、按键名）必须原样保留才能正确匹配；
 * 3. procedures_definition 的输入指向一个 shadow 原型，删掉会让反序列化出现悬空引用。
 *
 * 所以规则是：
 *   - 编译成功的脚本：只保留顶层积木 + 它引用的 shadow 积木（递归），并断开 next 链；
 *   - 编译失败的脚本：整棵树原样保留（运行时继续走「现场编译 / 解释器兜底」）。
 *
 * 本文件用 CommonJS 写，便于 Node 直接 require 做回归测试。
 */

const {parseIndexKeys} = require('../../protect/index-format');

/** 取某个输入里引用到的积木 id（只取 string 形式，形如 [3,"id",...] / [1,"id"]） */
const collectInputReferences = (block) => {
  const references = [];
  const inputs = block.inputs || {};
  for (const inputName of Object.keys(inputs)) {
    const input = inputs[inputName];
    if (!Array.isArray(input)) continue;
    for (let i = 1; i < input.length; i++) {
      const part = input[i];
      if (typeof part === 'string') references.push({inputName, blockId: part, isShadowSlot: i === 2});
    }
  }
  return references;
};

/**
 * 计算某个脚本需要保留的积木集合。
 * @param {object} blocks target 的 blocks 表
 * @param {string} rootId 顶层积木 id
 * @param {boolean} wholeTree true=保留整棵树（编译失败的脚本），false=只保留 shadow 骨架
 */
const collectKeepSet = (blocks, rootId, wholeTree) => {
  const keep = new Set();
  const stack = [{id: rootId, deep: wholeTree}];
  while (stack.length > 0) {
    const {id, deep} = stack.pop();
    if (!id || keep.has(id)) continue;
    const block = blocks[id];
    if (!block) continue;
    keep.add(id);
    if (deep && block.next) stack.push({id: block.next, deep: true});
    for (const reference of collectInputReferences(block)) {
      const child = blocks[reference.blockId];
      if (!child) continue;
      // 浅模式下只跟着 shadow 走：shadow 是「输入框」本身，不是逻辑
      if (deep || child.shadow) {
        stack.push({id: reference.blockId, deep});
      }
    }
  }
  return keep;
};

/**
 * 按索引把 project.json 里的积木摘掉。
 *
 * 说明：编译成功的脚本只留「顶层积木 + 从它出发能走到的 shadow 积木」。
 * 帽子积木其实不带逻辑（`event_whenflagclicked` 连输入都没有），
 * 之所以要留，是为了让运行时还能：
 *   1. 通过 `blocks.getScripts()` 找到它、用 `startHats` 匹配字段（消息名、按键等）来启动；
 *   2. 用它自己的 id 去 `blocks` 的编译缓存里命中打包期塞进来的函数；
 *   3. 对 `procedures_definition` 而言，留住它的 `procedures_prototype`（mutation 里带着
 *      proccode 与参数表），解释器兜底与 TW 的 spork/frames 才不会失去过程元信息。
 *
 * `extractSkeleton: true`（更彻底的保护）：
 *   连这些骨架也不留在 project.json 里，而是**搬进索引**，由运行时在装载阶段重建。
 *   好处：产物里 `target.blocks` 是空对象，解包工具连「作品用到了哪些积木」都看不到
 *   （实测可把残留 opcode 从 6 种降到 0 种）。代价是运行时多一步重建（见 precompiled.js）。
 *
 * @param {object} projectJSON 已解析的 project.json（会被直接修改并返回）
 * @param {object} index compileProject() 产出的索引
 * @param {object} [options]
 * @param {boolean} [options.extractSkeleton=false] 是否把骨架搬进索引、project.json 里不留积木
 * @returns {{projectJSON: object, skeleton: Map<string, object>|null, stats: object}}
 */
const stripProjectBlocks = (projectJSON, index, options = {}) => {
  const {extractSkeleton = false} = options;
  const parsed = parseIndexKeys(index);
  let strippedScripts = 0;
  let keptScripts = 0;
  let extractedBlocks = 0;
  /** 至少有一个脚本被整棵保留（= 保留逻辑）的目标名 */
  const keptTargets = [];
  /** 主题名 -> {积木id: 积木对象}（仅 extractSkeleton 模式） */
  const skeleton = extractSkeleton ? new Map() : null;

  for (const target of projectJSON.targets || []) {
    const blocks = target.blocks;
    const compiledScripts = parsed.get(target.name);
    if (!blocks) continue;
    if (!compiledScripts || compiledScripts.size === 0) {
      // 这个目标一个脚本都没编译成功：整块保留，运行时继续走解释器
      if (Object.keys(blocks).length > 0) {
        keptScripts += Object.values(blocks).filter((block) => block.topLevel).length;
        keptTargets.push(target.name);
      }
      continue;
    }

    const keep = new Set();
    for (const [blockId, block] of Object.entries(blocks)) {
      if (!block.topLevel) continue;
      const compiled = compiledScripts.has(blockId);
      if (compiled) {
        strippedScripts += 1;
      } else {
        keptScripts += 1;
        // 这个脚本没编译成功，整棵树留下
        if (keptTargets.indexOf(target.name) === -1) keptTargets.push(target.name);
      }
      for (const id of collectKeepSet(blocks, blockId, !compiled)) keep.add(id);
    }

    for (const [blockId, block] of Object.entries(blocks)) {
      if (!keep.has(blockId)) {
        delete blocks[blockId];
        continue;
      }
      // 断掉指向已删除积木的 next
      if (block.next && !keep.has(block.next)) block.next = null;
      // 剪掉指向已删除积木的输入，避免反序列化出现悬空引用
      const inputs = block.inputs || {};
      for (const inputName of Object.keys(inputs)) {
        const input = inputs[inputName];
        if (!Array.isArray(input)) continue;
        for (let i = 1; i < input.length; i++) {
          const part = input[i];
          if (typeof part === 'string' && !keep.has(part)) {
            inputs[inputName] = [];
            break;
          }
        }
      }
    }

    if (extractSkeleton) {
      // 把剩下的骨架整份搬到索引里，然后让 project.json 一个积木都不剩
      const kept = {};
      for (const blockId of keep) {
        if (blocks[blockId]) kept[blockId] = blocks[blockId];
      }
      if (Object.keys(kept).length > 0) skeleton.set(target.name, kept);
      extractedBlocks += Object.keys(kept).length;
      for (const blockId of Object.keys(blocks)) delete blocks[blockId];
    }
  }

  return {
    projectJSON,
    skeleton,
    stats: {
      strippedScripts,
      keptScripts,
      keptTargets,
      extractedBlocks,
      skeletonTargets: skeleton ? skeleton.size : 0
    }
  };
};

module.exports = {
  stripProjectBlocks
};
