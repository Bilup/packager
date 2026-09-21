/*
 * preparePrecompiled() 的端到端回归测试（不起 Adapter、不联网）。
 *
 * 这一组用例是冲着一次真实的线上事故写的：
 * packager.js 里把 `built.stats` 误写成了 `stats`，抛 ReferenceError。
 * 因为下面两行之间抛错 ——
 *     this.precompiledIndexText = built.indexText;        ← 先赋值
 *     if (built.strippedBuffer) this.precompiledProjectBuffer = ...   ← 后赋值
 * —— 异常被外层 catch 吞掉后，产物的状态是自相矛盾的：
 *   **内嵌的是原始 project.json，索引却是按剥离后的工程算出来的**。
 * 表面看只是「预编译没生效」，实际产物直接打不开/玩不了。
 *
 * 所以这里盯住两条不变量：
 *   1. removeProjectData 生效时，索引与「剥离后的工程数据」必须同时就位，
 *      而且 getProjectBuffer() 交给产物内嵌的必须是剥离后的那一份；
 *   2. 任何时候都不允许出现「有索引、没有剥离数据」这种半套状态。
 */
import JSZip from '@turbowarp/jszip';

import Packager from '../../src/packager/packager';

/** 造一个最小的 sb3：Stage + 一个精灵，精灵里两摞可编译的脚本 */
const makeProjectBuffer = async () => {
  const projectJSON = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'off',
        textToSpeechLanguage: null
      },
      {
        isStage: false,
        name: 'Sprite1',
        variables: {score: [0, 'score']},
        lists: {},
        broadcasts: {},
        blocks: {
          hat: {
            opcode: 'event_whenflagclicked',
            next: 'set',
            parent: null,
            inputs: {},
            fields: {},
            shadow: false,
            topLevel: true,
            x: 0,
            y: 0
          },
          set: {
            opcode: 'data_setvariableto',
            next: null,
            parent: 'hat',
            inputs: {VALUE: [1, [4, '1']]},
            fields: {VARIABLE: ['score', null]},
            shadow: false,
            topLevel: false
          }
        },
        comments: {},
        currentCostume: 0,
        costumes: [],
        sounds: [],
        volume: 100,
        layerOrder: 1,
        visible: true,
        x: 0,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around'
      }
    ],
    monitors: [],
    extensions: [],
    extensionURLs: {},
    meta: {semver: '3.0.0', vm: '0.2.0', agent: 'prepare-precompiled-test'}
  };

  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(projectJSON));
  return zip.generateAsync({type: 'nodebuffer'});
};

const makePackager = (buffer, options = {}) => {
  const packager = new Packager();
  Object.assign(packager.options, {
    target: 'html',
    precompileScripts: true,
    removeProjectData: true,
    ...options
  });
  packager.options.compiler = {enabled: true, warpTimer: false};
  packager.project = {type: 'sb3', arrayBuffer: buffer, analysis: {}};
  return packager;
};

const readProjectJSON = async (buffer) => {
  const zip = await JSZip.loadAsync(buffer);
  return JSON.parse(await zip.file('project.json').async('string'));
};

/** project.json 里还剩多少「真正的逻辑积木」（既非顶层、也非 shadow） */
const countLogicBlocks = (projectJSON) => {
  let logic = 0;
  let total = 0;
  for (const target of projectJSON.targets || []) {
    for (const block of Object.values(target.blocks || {})) {
      total += 1;
      if (!block.topLevel && !block.shadow) logic += 1;
    }
  }
  return {logic, total};
};

describe('preparePrecompiled', () => {
  test('removeProjectData 生效时：索引与剥离后的工程数据必须同时就位', async () => {
    // 这条用例就是那次事故的回归 —— 修之前它会因为 ReferenceError 而挂掉
    const packager = makePackager(await makeProjectBuffer());

    await packager.preparePrecompiled();

    // 不该有任何警告：警告就意味着悄悄退回原始产物了
    expect(packager.precompileWarning).toBeNull();

    // 索引与剥离数据必须成对出现
    expect(packager.precompiledIndexText).toBeTruthy();
    expect(packager.precompiledProjectBuffer).toBeTruthy();
    expect(packager.precompiledIndex).toBeTruthy();

    // 产物内嵌的必须是剥离后的那一份，不是原始工程
    expect(packager.getProjectBuffer()).toBe(packager.precompiledProjectBuffer);

    // 剥离后的工程里不该再有逻辑积木（骨架也搬进索引了）
    const stripped = await readProjectJSON(packager.precompiledProjectBuffer);
    const {logic, total} = countLogicBlocks(stripped);
    expect(logic).toBe(0);
    expect(total).toBe(0);
  });

  test('索引里带上骨架 k，且与脚本表 s 一一对应', async () => {
    const packager = makePackager(await makeProjectBuffer());

    await packager.preparePrecompiled();

    const entry = packager.precompiledIndex.t.find((item) => item.n === 'Sprite1');
    expect(entry).toBeTruthy();
    expect(Object.keys(entry.s)).toEqual(['hat']);
    expect(entry.k).toBeTruthy();
    expect(entry.k.hat).toBeTruthy();
    expect(entry.k.hat.next).toBeNull();
    // 逻辑积木不该混进骨架
    expect(entry.k.set).toBeUndefined();
  });

  test('只开 precompileScripts 时：有索引但不剥离工程数据', async () => {
    const packager = makePackager(await makeProjectBuffer(), {removeProjectData: false});

    await packager.preparePrecompiled();

    expect(packager.precompileWarning).toBeNull();
    expect(packager.precompiledIndexText).toBeTruthy();
    expect(packager.precompiledProjectBuffer).toBeNull();
    // 没有剥离数据时交给产物的就是原始工程
    expect(packager.getProjectBuffer()).toBe(packager.project.arrayBuffer);
  });

  test('中途抛错时不留下「有索引、没有剥离数据」的半套状态', async () => {
    const packager = makePackager(await makeProjectBuffer());
    const dispatch = packager.dispatchEvent.bind(packager);
    // 模拟「索引已算出、状态还没提交完就炸了」这类情况：
    // 广播警告时抛错。此时必须退成彻底没有预编译状态，而不是留半套。
    packager.dispatchEvent = (event) => {
      if (event.type === 'precompile-warning') {
        throw new Error('boom');
      }
      return dispatch(event);
    };

    await expect(packager.preparePrecompiled()).resolves.toBeUndefined();

    // 四个字段要么都有、要么都没有 —— 这里是都没有
    const states = [
      packager.precompiledIndex,
      packager.precompiledIndexText,
      packager.precompiledStats,
      packager.precompiledProjectBuffer
    ];
    const present = states.filter((value) => value !== null && value !== undefined);
    expect(present.length === 0 || present.length === 4).toBe(true);
    expect(packager.precompiledProjectBuffer).toBeNull();
    // 必须给出警告，不能静默
    expect(packager.precompileWarning).toContain('预编译失败');
  });

  test('工程不是 sb3 时：明确跳过并给出警告', async () => {
    const packager = makePackager(await makeProjectBuffer());
    packager.project.type = 'blob';

    await packager.preparePrecompiled();

    expect(packager.precompileWarning).toContain('sb3');
    expect(packager.precompiledIndexText).toBeNull();
    expect(packager.precompiledProjectBuffer).toBeNull();
  });
});
