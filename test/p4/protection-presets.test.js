/*
 * 「混淆打包」分级预设的单元测试。
 *
 * 这一层的价值只在「界面说法 = 实际开启的开关」时才成立，所以测试盯住三件事：
 *   1. 四个等级必须能**互相区分**（否则界面上选哪一级都一样）；
 *   2. 等级是**单调递增**的（low ⊂ medium ⊂ high）—— 否则从「高」降到「中」
 *      会冒出意外组合，用户根本预期不到；
 *   3. 反推等级（detect）与施加等级（apply）必须**互为逆运算**，
 *      并且落在预设之外的组合要老实报 `custom`，而不是硬贴近似的某一级。
 */
import {
  PROTECTION_FLAGS,
  PROTECTION_LEVELS,
  PROTECTION_LEVEL_IDS,
  CUSTOM_LEVEL,
  detectProtectionLevel,
  applyProtectionLevel,
  protectionLevelFlags
} from '../../src/p4/protection-presets';

const optionsFrom = (flags) => {
  const options = {};
  for (const flag of PROTECTION_FLAGS) options[flag] = !!flags[flag];
  return options;
};

test('关掉一切的等级必须存在（不开启）', () => {
  const off = PROTECTION_LEVELS.find((level) => level.id === 'off');
  expect(off).toBeTruthy();
  for (const flag of PROTECTION_FLAGS) {
    expect(off.flags[flag]).toBe(false);
  }
});

test('每个等级都能与其它等级区分开（没有两个等级开关完全相同）', () => {
  const seen = new Set();
  for (const level of PROTECTION_LEVELS) {
    const key = PROTECTION_FLAGS.map((flag) => (level.flags[flag] ? '1' : '0')).join('');
    expect(seen.has(key)).toBe(false);
    seen.add(key);
  }
});

test('等级单调递增：low ⊂ medium ⊂ high', () => {
  const order = ['low', 'medium', 'high'];
  for (let i = 1; i < order.length; i++) {
    const prev = PROTECTION_LEVELS.find((level) => level.id === order[i - 1]);
    const next = PROTECTION_LEVELS.find((level) => level.id === order[i]);
    for (const flag of PROTECTION_FLAGS) {
      // 上一级开着的，下一级必须也开着（只允许「加上去」，不允许中途关掉）
      if (prev.flags[flag]) expect(next.flags[flag]).toBe(true);
    }
    // 而且必须真的多开了点什么，否则两个等级没区别
    const added = PROTECTION_FLAGS.filter((flag) => next.flags[flag] && !prev.flags[flag]);
    expect(added.length).toBeGreaterThan(0);
  }
});

test('detect：预设组合能反推回自己的等级', () => {
  for (const level of PROTECTION_LEVELS) {
    expect(detectProtectionLevel(optionsFrom(level.flags))).toBe(level.id);
  }
});

test('detect：落在预设之外的组合报 custom', () => {
  // 只开 antiTamper：任何预设里都没有这个组合
  expect(detectProtectionLevel(optionsFrom({antiTamper: true}))).toBe(CUSTOM_LEVEL);
  // 开着 removeProjectData 却没开 precompileScripts（后者是前者的前提）
  expect(detectProtectionLevel(optionsFrom({removeProjectData: true}))).toBe(CUSTOM_LEVEL);
  // 只开 precompileScripts：介于 low 与 medium 之间，不属于任何预设
  expect(detectProtectionLevel(optionsFrom({precompileScripts: true}))).toBe(CUSTOM_LEVEL);
});

test('apply：写进选项对象，且与 detect 互为逆运算', () => {
  const options = optionsFrom({});
  for (const level of PROTECTION_LEVELS) {
    expect(applyProtectionLevel(options, level.id)).toBe(true);
    expect(detectProtectionLevel(options)).toBe(level.id);
    for (const flag of PROTECTION_FLAGS) {
      expect(options[flag]).toBe(level.flags[flag]);
    }
  }
});

test('apply：未知等级 / custom 不做任何改动', () => {
  const options = optionsFrom({obfuscateJS: true});
  const before = JSON.stringify(options);
  expect(applyProtectionLevel(options, CUSTOM_LEVEL)).toBe(false);
  expect(applyProtectionLevel(options, 'nonsense')).toBe(false);
  expect(JSON.stringify(options)).toBe(before);
});

test('level id 清单包含四个等级 + custom，且没有重复', () => {
  expect(PROTECTION_LEVEL_IDS).toEqual(['off', 'low', 'medium', 'high', CUSTOM_LEVEL]);
  expect(new Set(PROTECTION_LEVEL_IDS).size).toBe(PROTECTION_LEVEL_IDS.length);
});

test('protectionLevelFlags 报出该等级开了哪些开关', () => {
  expect(protectionLevelFlags('off')).toEqual([]);
  expect(protectionLevelFlags('low')).toEqual(['obfuscateJS']);
  expect(protectionLevelFlags('high')).toEqual(PROTECTION_FLAGS);
  expect(protectionLevelFlags('custom')).toEqual([]);
});
