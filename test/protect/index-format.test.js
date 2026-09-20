import {
  ENTRY_KEY,
  FORMAT_VERSION,
  parseIndex,
  parseIndexKeys,
  parseExtensions,
  parseAddonCodes,
  collectRuntimeRefs,
  collectIndexSources,
  serializeIndex,
  deserializeIndex,
  indexStats
} from '../../src/protect/index-format';

const sampleIndex = () => ({
  v: FORMAT_VERSION,
  t: [
    {
      n: 'Stage',
      st: 1,
      s: {}
    },
    {
      n: 'Sprite1',
      st: 0,
      s: {
        top1: {e: '(function factory0(thread) { return function* () {}; })', p: {Zfoo: 'proc-src'}, h: true},
        top2: {e: '(function factory1(thread) { return function* () {}; })', h: false}
      }
    }
  ],
  x: {music: '', custom: 'https://example.com/ext.js'},
  a: ['addon code']
});

test('parseIndex 按角色名索引，并保留 isStage', () => {
  const parsed = parseIndex(sampleIndex());
  expect(Array.from(parsed.keys())).toEqual(['Stage', 'Sprite1']);
  expect(parsed.get('Sprite1').isStage).toBe(false);
  expect(parsed.get('Stage').isStage).toBe(true);
  expect(Array.from(parsed.get('Sprite1').scripts.keys())).toEqual(['top1', 'top2']);
  const first = parsed.get('Sprite1').scripts.get('top1');
  expect(first.entry).toBe('(function factory0(thread) { return function* () {}; })');
  expect(first.procedures).toEqual({Zfoo: 'proc-src'});
  expect(first.executableHat).toBe(true);
  expect(parsed.get('Sprite1').scripts.get('top2').procedures).toEqual({});
  expect(parsed.get('Sprite1').scripts.get('top2').executableHat).toBe(false);
});

test('parseIndexKeys 返回顶层积木 id 集合', () => {
  const keys = parseIndexKeys(sampleIndex());
  expect(Array.from(keys.get('Sprite1'))).toEqual(['top1', 'top2']);
  expect(Array.from(keys.get('Stage'))).toEqual([]);
});

test('parseExtensions 把空 URL 保留为内置扩展标记', () => {
  expect(parseExtensions(sampleIndex())).toEqual([
    {id: 'music', url: ''},
    {id: 'custom', url: 'https://example.com/ext.js'}
  ]);
});

test('parseExtensions / parseAddonCodes 对缺失字段容忍', () => {
  expect(parseExtensions({t: []})).toEqual([]);
  expect(parseAddonCodes({t: []})).toEqual([]);
  expect(parseAddonCodes(null)).toEqual([]);
});

test('collectRuntimeRefs 找出扩展 opcode 与 addon 代号', () => {
  const sources = [
    'const b0 = runtime.getOpcodeFunction("music_restForBeats");',
    'const b1 = runtime.getOpcodeFunction("sound_setvolumeto");',
    'yield* executeInCompatibilityLayer({}, b0, true, false, "m", null);',
    'const a0 = runtime.getAddonBlock("block 1").callback;',
    'const a1 = runtime.getAddonBlock("block \\"quoted\\"").callback;'
  ];
  const {opcodes, addonCodes} = collectRuntimeRefs(sources);
  expect(Array.from(opcodes).sort()).toEqual(['music_restForBeats', 'sound_setvolumeto']);
  expect(Array.from(addonCodes).sort()).toEqual(['block "quoted"', 'block 1']);
});

test('collectRuntimeRefs 对非字符串输入安全', () => {
  const {opcodes, addonCodes} = collectRuntimeRefs([null, undefined, 42, 'no refs here']);
  expect(opcodes.size).toBe(0);
  expect(addonCodes.size).toBe(0);
});

test('collectIndexSources 收集入口与过程变体源码', () => {
  const sources = collectIndexSources(sampleIndex());
  expect(sources).toEqual([
    '(function factory0(thread) { return function* () {}; })',
    'proc-src',
    '(function factory1(thread) { return function* () {}; })'
  ]);
});

test('serialize/deserialize 往返一致', () => {
  const index = sampleIndex();
  expect(deserializeIndex(serializeIndex(index))).toEqual(index);
  expect(deserializeIndex(index)).toBe(index);
});

test('indexStats 统计脚本数与源码字节数', () => {
  const stats = indexStats(sampleIndex());
  expect(stats.scripts).toBe(2);
  expect(stats.extensions).toBe(2);
  expect(stats.bytes).toBeGreaterThan(0);
});

test('ENTRY_KEY 是空串（与 jsexecute 的变体名约定保持一致）', () => {
  expect(ENTRY_KEY).toBe('');
});
