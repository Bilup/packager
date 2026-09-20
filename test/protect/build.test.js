/*
 * build.js 的端到端回归测试（真实 scratch-vm）。
 *
 * 这里盯的是几个踩过的坑：
 *
 *  1. 「内建扩展必须能在构建期编译」
 *     回归来源：tw-forkphorus-515 那个工程，编译出的代码里引用了
 *     `runtime.getOpcodeFunction("music_restForBeats")`，但因为积木被摘掉后
 *     opcode 扫描的触发点没了，music 扩展没装，运行时报 `blockFunction is not a function`。
 *     所以索引里必须记下依赖的扩展（index.x），并且这些扩展在构建期就得装好。
 *
 *  2. 「terser 必须真的跑起来」
 *     回归来源：terser 4 的选项键名是 `output` 而不是 `format`。
 *     传 `format` 不报语法错，而是每个源码都压缩失败、静默退回未压缩版本
 *     （stats.minified 恒为 0，体积也压不下去）。
 *
 *  3. 「工程引用的扩展拿不到 URL 时要优雅放弃」
 *     不能抛异常，也不能打一个半残的包；要退回原始产物并点名是哪个扩展。
 *
 * 注意：这里只用**内建**扩展（music / pen 这类，能同步加载）。
 * 非沙箱自定义扩展的加载依赖 DOM（`document.head.appendChild`），在 Node 里必然失败，
 * 那条路径放在 build-order.test.js 里用替身 VM 验证调用顺序。
 */
import JSZip from '@turbowarp/jszip';

import {buildPrecompiledProject} from '../../src/packager/protect/build';

const CUSTOM_EXTENSION_ID = 'protecttest';

/**
 * 造一个最小的 sb3。
 * @param {object} [options]
 * @param {boolean} [options.withExtension] 是否加入一摞调用 music 扩展的脚本
 * @param {boolean} [options.withPen] 是否加入一摞调用 pen 扩展的脚本
 * @param {boolean} [options.withUnknownExtension] 是否加入一摞调用未知扩展的脚本
 */
const makeProject = async (options = {}) => {
  const {withExtension = false, withPen = false, withUnknownExtension = false} = options;

  const spriteBlocks = {
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
    },
    // 普通积木的第二摞，用来确认「多个脚本」都被编译
    plain: {
      opcode: 'event_whenflagclicked',
      next: 'change',
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 200
    },
    change: {
      opcode: 'data_changevariableby',
      next: null,
      parent: 'plain',
      inputs: {VALUE: [1, [4, '1']]},
      fields: {VARIABLE: ['score', null]},
      shadow: false,
      topLevel: false
    }
  };

  const extensions = [];

  if (withExtension) {
    extensions.push('music');
    spriteBlocks.musicHat = {
      opcode: 'event_whenflagclicked',
      next: 'rest',
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 400
    };
    spriteBlocks.rest = {
      opcode: 'music_restForBeats',
      next: null,
      parent: 'musicHat',
      inputs: {BEATS: [1, [4, '1']]},
      fields: {},
      shadow: false,
      topLevel: false
    };
  }

  if (withPen) {
    extensions.push('pen');
    spriteBlocks.penHat = {
      opcode: 'event_whenflagclicked',
      next: 'setPenColor',
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 800
    };
    // pen 的这块积木被编译成 runtime.ext_pen._setPenColorToColor(…)
    // —— 编译器硬编码直呼扩展对象，不经过 getOpcodeFunction
    spriteBlocks.setPenColor = {
      opcode: 'pen_setPenColorToColor',
      next: null,
      parent: 'penHat',
      inputs: {COLOR: [1, [9, '#ff0000']]},
      fields: {},
      shadow: false,
      topLevel: false
    };
  }

  if (withUnknownExtension) {
    extensions.push(CUSTOM_EXTENSION_ID);
    spriteBlocks.unknownHat = {
      opcode: 'event_whenflagclicked',
      next: 'unknownCall',
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 600
    };
    spriteBlocks.unknownCall = {
      opcode: `${CUSTOM_EXTENSION_ID}_answer`,
      next: null,
      parent: 'unknownHat',
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: false
    };
  }

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
        blocks: spriteBlocks,
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
    extensions,
    extensionURLs: {},
    meta: {semver: '3.0.0', vm: '0.2.0', agent: 'protect-test'}
  };

  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(projectJSON));
  return {
    buffer: await zip.generateAsync({type: 'nodebuffer'}),
    projectJSON,
    scriptCount: 2 + (withExtension ? 1 : 0) + (withPen ? 1 : 0) + (withUnknownExtension ? 1 : 0)
  };
};

const build = (params) => buildPrecompiledProject({
  JSZip,
  stripBlocks: false,
  compilerOptions: {warpTimer: false},
  ...params
});

describe('buildPrecompiledProject', () => {
  test('普通工程：编译出索引、压缩生效、自检通过', async () => {
    const {buffer, projectJSON, scriptCount} = await makeProject();

    const built = await build({projectBuffer: buffer, projectJSON});

    expect(built.ok).toBe(true);
    expect(built.warnings).toEqual([]);
    expect(built.index).toBeTruthy();
    expect(built.stats.scripts).toBe(scriptCount);
    expect(built.stats.compiled).toBe(scriptCount);
    expect(built.stats.failed).toBe(0);
    // terser 必须真的跑起来（曾经因为把选项写成 format 而不是 output，压缩全程静默失效）
    expect(built.stats.minified).toBe(scriptCount);
    expect(built.stats.minifyFailed).toBe(0);
    expect(built.stats.sourceBytes).toBeLessThan(built.stats.originalSourceBytes);
  });

  test('引用内建扩展（music）的脚本也能编译，并记进索引的扩展表', async () => {
    const {buffer, projectJSON, scriptCount} = await makeProject({withExtension: true});

    const built = await build({projectBuffer: buffer, projectJSON});

    expect(built.ok).toBe(true);
    expect(built.stats.compiled).toBe(scriptCount);
    // stats.extensions / index.x 都是「扩展 id -> URL」的表（'' 表示 VM 内置扩展）
    expect(Object.keys(built.stats.extensions)).toEqual(['music']);
    // 索引里要带上扩展清单，运行时才能按它把扩展补齐
    expect(built.index.x).toHaveProperty('music');
    expect(built.index.x.music).toBe('');
  });

  test('引用内建扩展（pen）的脚本也能编译，pen 走的是 runtime.ext_pen 直呼路径', async () => {
    // 回归来源：地表最强抛出窗口.sb3 的 pen 积木被编译成
    // runtime.ext_pen._setPenColorToColor(…)，但扩展表里没记 pen（getOpcodeFunction 扫不到它），
    // 剥离积木后 pen 不会被自动加载 → 运行时
    // `Cannot read properties of undefined (reading '_setPenColorToColor')`
    const {buffer, projectJSON, scriptCount} = await makeProject({withPen: true});

    const built = await build({projectBuffer: buffer, projectJSON});

    expect(built.ok).toBe(true);
    expect(built.stats.compiled).toBe(scriptCount);
    expect(built.stats.failed).toBe(0);
    expect(Object.keys(built.stats.extensions)).toContain('pen');
    expect(built.index.x).toHaveProperty('pen');
  });

  test('核心扩展（looks / motion）不会被记进扩展表', async () => {
    // 编译源码里有 runtime.ext_scratch3_looks / ext_scratch3_motion，
    // 它们是核心积木，运行时永远就位，不该当成需要加载的扩展
    const {buffer, projectJSON} = await makeProject();

    const built = await build({projectBuffer: buffer, projectJSON});

    expect(built.ok).toBe(true);
    expect(built.index.x || {}).not.toHaveProperty('looks');
    expect(built.index.x || {}).not.toHaveProperty('motion');
    expect(built.index.x || {}).not.toHaveProperty('control');
  });

  test('缺少扩展 URL 时：不抛异常，ok=false 且提示点名扩展', async () => {
    const {buffer, projectJSON} = await makeProject({withUnknownExtension: true});

    const built = await build({projectBuffer: buffer, projectJSON});

    expect(built.ok).toBe(false);
    expect(built.index).toBeNull();
    expect(built.strippedBuffer).toBeNull();
    const text = built.warnings.join('\n');
    expect(text).toContain(CUSTOM_EXTENSION_ID);
    expect(text).toContain('未提供');
  });

  test('stripBlocks=true 时产出剥离后的 sb3，积木逻辑被摘掉但帽子留着', async () => {
    const {buffer, projectJSON} = await makeProject();

    const built = await build({
      projectBuffer: buffer,
      projectJSON,
      stripBlocks: true
    });

    expect(built.ok).toBe(true);
    expect(built.strippedBuffer).toBeTruthy();
    expect(built.stats.strippedBytes).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(built.strippedBuffer);
    const stripped = JSON.parse(await zip.file('project.json').async('string'));
    const sprite = stripped.targets.find((target) => target.name === 'Sprite1');

    // 逻辑积木被摘掉了
    expect(sprite.blocks.set).toBeUndefined();
    expect(sprite.blocks.change).toBeUndefined();
    // 帽子积木留着（startHats / 编译缓存查表都要靠它），但 next 断开了
    expect(sprite.blocks.hat).toBeTruthy();
    expect(sprite.blocks.hat.next).toBeNull();
    expect(sprite.blocks.plain).toBeTruthy();
    expect(sprite.blocks.plain.next).toBeNull();

    // 其它字段没被动坏
    expect(stripped.extensions).toEqual(projectJSON.extensions);
    expect(sprite.variables).toEqual(projectJSON.targets[1].variables);
  });

  test('stripBlocks=false 时不产出剥离结果', async () => {
    const {buffer, projectJSON} = await makeProject();

    const built = await build({
      projectBuffer: buffer,
      projectJSON,
      stripBlocks: false
    });

    expect(built.ok).toBe(true);
    expect(built.strippedBuffer).toBeNull();
  });

  test('minify=false 可以关掉压缩（源码保持原样）', async () => {
    const a = await makeProject();
    const withMinify = await build({projectBuffer: a.buffer, projectJSON: a.projectJSON, minify: true});

    const b = await makeProject();
    const withoutMinify = await build({projectBuffer: b.buffer, projectJSON: b.projectJSON, minify: false});

    expect(withMinify.stats.minified).toBe(a.scriptCount);
    expect(withMinify.stats.sourceBytes).toBeLessThan(withMinify.stats.originalSourceBytes);

    expect(withoutMinify.stats.minified).toBe(0);
    expect(withoutMinify.stats.sourceBytes).toBe(withoutMinify.stats.originalSourceBytes);
  });

  test('有脚本编译失败时：整体仍然可用，但该目标整块保留积木', async () => {
    // music 扩展在构建 VM 里能装，但加一个未知扩展会让整块保留
    const {buffer, projectJSON} = await makeProject({withUnknownExtension: true});

    const built = await build({projectBuffer: buffer, projectJSON, stripBlocks: true});

    // 未知扩展直接让 loadProject 失败 → 整体放弃，不打半残的包
    expect(built.ok).toBe(false);
    expect(built.warnings.join('')).toContain(CUSTOM_EXTENSION_ID);
  });
});
