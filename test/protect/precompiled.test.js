import fs from 'fs';
import path from 'path';
import JSZip from '@turbowarp/jszip';
import VM from 'scratch-vm';

import {compileProject, verifyIndex} from '../../src/packager/protect/compile';
import {stripProjectBlocks} from '../../src/packager/protect/skeleton';
import {
  ensurePrecompiledExtensions,
  installPrecompiledScripts,
  applyPrecompiled,
  verifyRuntimeRefs
} from '../../src/scaffolding/precompiled';

const FIXTURES = path.join(__dirname, '..', '..', 'node_modules', 'scratch-vm', 'test', 'fixtures');

const readFixture = (relative) => fs.readFileSync(path.join(FIXTURES, relative));

const newVm = async (buffer) => {
  const vm = new VM();
  vm.setCompilerOptions({enabled: true, warpTimer: false});
  await vm.loadProject(buffer);
  return vm;
};

const readProjectJSON = async (buffer) => {
  const zip = await JSZip.loadAsync(buffer);
  return JSON.parse(await zip.file('project.json').async('string'));
};

const stripArchive = async (buffer, index) => {
  const zip = await JSZip.loadAsync(buffer);
  const projectJSON = JSON.parse(await zip.file('project.json').async('string'));
  const report = stripProjectBlocks(projectJSON, index);
  const out = await JSZip.loadAsync(buffer);
  out.file('project.json', JSON.stringify(projectJSON));
  return {
    buffer: await out.generateAsync({type: 'nodebuffer'}),
    stats: report.stats
  };
};

const snapshot = (vm) => {
  const state = {};
  for (const target of vm.runtime.targets) {
    const variables = {};
    for (const variable of Object.values(target.variables || {})) {
      variables[variable.name] = `${variable.value}`;
    }
    const lists = {};
    for (const list of Object.values(target._lists || {})) {
      lists[list.name] = JSON.stringify(list.value);
    }
    state[`${target.getName()}#${target.isStage ? 'stage' : 'sprite'}`] = {
      variables,
      lists,
      x: Math.round(target.x * 1000) / 1000,
      y: Math.round(target.y * 1000) / 1000,
      costume: target.currentCostume
    };
  }
  return state;
};

const runFor = async (vm, steps) => {
  vm.runtime.currentStepTime = 1000 / 30;
  vm.greenFlag();
  for (let i = 0; i < steps; i++) {
    vm.runtime._step();
    if (i % 20 === 19) await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const countBlocks = async (buffer) => {
  const json = await readProjectJSON(buffer);
  let total = 0;
  for (const target of json.targets) total += Object.keys(target.blocks || {}).length;
  return total;
};

const buildIndex = async (buffer) => {
  const vm = await newVm(buffer);
  const json = await readProjectJSON(buffer);
  const {index, failures, stats} = compileProject(vm, {extensionURLs: json.extensionURLs || {}});
  return {index, failures, stats};
};

/* ------------------------------------------------------------------ */

test('预编译 + 剥离积木后行为与原始工程一致（无扩展工程）', async () => {
  const buffer = readFixture(path.join('execute', 'tw-comparison-matrix-runtime.sb3'));
  const {index, failures, stats} = await buildIndex(buffer);
  expect(failures).toEqual([]);
  expect(stats.compiled).toBe(stats.scripts);
  expect(verifyIndex(index).ok).toBe(true);

  const stripped = await stripArchive(buffer, index);
  expect(await countBlocks(stripped.buffer)).toBeLessThan(await countBlocks(buffer));

  const original = await newVm(buffer);
  await runFor(original, 120);

  const protectedVm = await newVm(stripped.buffer);
  const applied = await applyPrecompiled(protectedVm, index);
  expect(applied.ok).toBe(true);
  expect(applied.install.installed).toBe(stats.compiled);
  expect(applied.install.failed).toEqual([]);
  expect(applied.install.missing).toEqual([]);
  expect(verifyRuntimeRefs(protectedVm, index).ok).toBe(true);
  await runFor(protectedVm, 120);

  expect(snapshot(protectedVm)).toEqual(snapshot(original));
}, 60000);

test('剥离积木后不注入缓存就完全跑不起来（对照组，证明逻辑确实被摘掉了）', async () => {
  const buffer = readFixture(path.join('execute', 'tw-comparison-matrix-runtime.sb3'));
  const {index} = await buildIndex(buffer);
  const stripped = await stripArchive(buffer, index);

  const original = await newVm(buffer);
  await runFor(original, 120);

  const bare = await newVm(stripped.buffer);
  await runFor(bare, 120);

  expect(snapshot(bare)).not.toEqual(snapshot(original));
}, 60000);

test('依赖扩展的工程：先加载扩展再装缓存，行为一致', async () => {
  const buffer = readFixture(path.join('execute', 'tw-forkphorus-515-wait-zero-seconds-in-warp-mode.sb3'));
  const {index, failures, stats} = await buildIndex(buffer);
  expect(failures).toEqual([]);

  // music 是内置扩展：积木被摘掉后必须靠索引里的声明把它装回来
  expect(index.x).toEqual({music: ''});

  const stripped = await stripArchive(buffer, index);
  const original = await newVm(buffer);
  await runFor(original, 120);

  const protectedVm = await newVm(stripped.buffer);
  const extensionReport = await ensurePrecompiledExtensions(protectedVm, index);
  expect(extensionReport.loaded).toEqual(['music']);
  expect(extensionReport.failed).toEqual([]);

  const report = installPrecompiledScripts(protectedVm, index);
  expect(report.failed).toEqual([]);
  expect(report.installed).toBe(stats.compiled);
  expect(verifyRuntimeRefs(protectedVm, index).ok).toBe(true);

  await runFor(protectedVm, 120);
  expect(snapshot(protectedVm)).toEqual(snapshot(original));
}, 60000);

test('扩展没加载时按脚本降级：只跳过用到它的脚本，不再整体拒绝（回归：曾经一个扩展加载失败整个作品就是死的）', async () => {
  const buffer = readFixture(path.join('execute', 'tw-forkphorus-515-wait-zero-seconds-in-warp-mode.sb3'));
  const {index} = await buildIndex(buffer);
  const stripped = await stripArchive(buffer, index);

  const vm = await newVm(stripped.buffer);
  const report = installPrecompiledScripts(vm, index);

  // 这个工程的脚本都用了 music，所以会被跳过 —— 但这是「跳过」，不是「硬失败」
  expect(report.unknownDependencies).toBe(false);
  expect(report.skippedByExtension.length).toBeGreaterThan(0);
  expect(report.skippedByExtension[0].extensions).toEqual(['music']);
  expect(report.failed).toEqual([]);
  expect(report.unavailableExtensions).toEqual(['music']);
});

test('部分降级：不依赖缺失扩展的脚本照常装进去', async () => {
  const buffer = readFixture(path.join('execute', 'tw-forkphorus-515-wait-zero-seconds-in-warp-mode.sb3'));
  const {index, stats} = await buildIndex(buffer);
  const stripped = await stripArchive(buffer, index);

  // 按索引自己的记录算期望值，不写死数字
  const withExt = [];
  const withoutExt = [];
  for (const target of index.t) {
    for (const [topBlockId, packed] of Object.entries(target.s)) {
      (packed.x ? withExt : withoutExt).push({target, topBlockId, packed});
    }
  }
  expect(withExt.length).toBeGreaterThan(0);
  expect(index.x.music).toBe('');

  // 把其中一个「依赖 music」的脚本改成「不依赖」，模拟这个脚本本来就只用了核心积木
  const victim = withExt[0];
  delete victim.packed.x;
  const keepId = victim.topBlockId;

  const vm = await newVm(stripped.buffer);
  const report = installPrecompiledScripts(vm, index);

  // music 没装：依赖它的脚本被跳过，其余（含刚改成不依赖的那个）照常装上 ——
  // 作品不再整体变死，只是少了用到 music 的那部分行为
  expect(report.unknownDependencies).toBe(false);
  expect(report.installed).toBe(withoutExt.length + 1);
  expect(report.skippedByExtension.length).toBe(withExt.length - 1);
  expect(report.failed).toEqual([]);
  expect(report.unavailableExtensions).toEqual(['music']);
  expect(vm.runtime.targets.some((t) => t.blocks.getCachedCompileResult(keepId))).toBe(true);
  expect(stats.compiled).toBe(withExt.length + withoutExt.length);
});

test('旧索引（没有按脚本依赖信息）仍然整体拒绝，不会误判成「无依赖」', async () => {
  const buffer = readFixture(path.join('execute', 'tw-forkphorus-515-wait-zero-seconds-in-warp-mode.sb3'));
  const {index} = await buildIndex(buffer);
  const stripped = await stripArchive(buffer, index);

  // 退回 v2 形态：版本号降级 + 抹掉 t[].x 与 s[].x
  index.v = 2;
  for (const target of index.t) {
    delete target.x;
    for (const packed of Object.values(target.s)) delete packed.x;
  }

  const vm = await newVm(stripped.buffer);
  const report = installPrecompiledScripts(vm, index);

  expect(report.unknownDependencies).toBe(true);
  expect(report.installed).toBe(0);
  expect(report.failed.length).toBe(1);
  expect(report.failed[0].message).toContain('music');
});

test('ensurePrecompiledExtensions 会等在途的扩展加载落地（回归：发射即忘的竞态）', async () => {
  // 造一个假 manager：一开始「正在加载」，一个 tick 后才有扩展注册进来
  const loaded = new Set();
  let pending = 1;
  const manager = {
    _loadedExtensions: loaded,
    loadingAsyncExtensions: 1,
    isExtensionLoaded: (id) => loaded.has(id),
    isBuiltinExtension: () => false,
    loadExtensionURL: () => Promise.resolve()
  };
  const vm = {runtime: {extensionManager: manager}, extensionManager: manager};
  const index = {v: 3, t: [], x: {music: ''}};

  setTimeout(() => {
    loaded.add('music');
    pending = 0;
    manager.loadingAsyncExtensions = 0;
  }, 60);

  const report = await ensurePrecompiledExtensions(vm, index, {waitForPendingMs: 2000});

  expect(report.failed).toEqual([]);
  expect(report.skipped).toEqual(['music']);
  expect(report.waitedMs).toBeGreaterThan(0);
  expect(pending).toBe(0);
});

test('扩展加载失败时会重试，并把失败的 URL 形态报出来', async () => {
  let attempts = 0;
  const loaded = new Set();
  const manager = {
    _loadedExtensions: loaded,
    loadingAsyncExtensions: 0,
    isExtensionLoaded: (id) => loaded.has(id),
    isBuiltinExtension: () => false,
    loadExtensionURL: () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error('boom'));
      loaded.add('tweening');
      return Promise.resolve();
    }
  };
  const vm = {runtime: {extensionManager: manager}, extensionManager: manager};
  const index = {v: 3, t: [], x: {tweening: 'https://example.com/tween.js'}};

  const retried = await ensurePrecompiledExtensions(vm, index, {retries: 1});
  expect(attempts).toBe(2);
  expect(retried.failed).toEqual([]);
  expect(retried.loaded).toEqual(['tweening']);

  // 一直失败的话：报出 id + URL 形态，别静默
  const alwaysFail = {
    ...manager,
    isExtensionLoaded: () => false,
    loadExtensionURL: () => Promise.reject(new Error('nope'))
  };
  const vm2 = {runtime: {extensionManager: alwaysFail}, extensionManager: alwaysFail};
  const failed = await ensurePrecompiledExtensions(vm2, index, {retries: 0});
  expect(failed.failed).toEqual([{
    id: 'tweening',
    url: 'https://example.com/tween.js',
    kind: 'remote',
    message: 'nope'
  }]);
});

test('requireExtensions=false 时允许强行装载（给特殊场景留口子）', async () => {
  const buffer = readFixture(path.join('execute', 'tw-forkphorus-515-wait-zero-seconds-in-warp-mode.sb3'));
  const {index} = await buildIndex(buffer);
  const stripped = await stripArchive(buffer, index);

  const vm = await newVm(stripped.buffer);
  const report = installPrecompiledScripts(vm, index, {requireExtensions: false});
  expect(report.installed).toBeGreaterThan(0);
  expect(report.failed).toEqual([]);
});

test('编译不过的脚本会保留整棵积木，运行时仍走解释器', async () => {
  // tw-project-with-extensions 用的是测试专用扩展，构建 VM 里没有 -> 必然编译失败
  const buffer = readFixture('tw-project-with-extensions.sb3');
  const {index, stats, failures} = await buildIndex(buffer);
  expect(stats.compiled).toBe(0);
  expect(failures.length).toBeGreaterThan(0);

  const stripped = await stripArchive(buffer, index);
  expect(stripped.stats.keptScripts).toBeGreaterThan(0);
  expect(stripped.stats.keptTargets).toContain('Sprite1');
  // 一个脚本都没编译成功 -> 积木一块都不该少
  expect(await countBlocks(stripped.buffer)).toBe(await countBlocks(buffer));
});

test('索引是可序列化的纯 JSON，且体积可控', async () => {
  const buffer = readFixture(path.join('execute', 'tw-comparison-matrix-runtime.sb3'));
  const {index, stats} = await buildIndex(buffer);
  const text = JSON.stringify(index);
  expect(() => JSON.parse(text)).not.toThrow();
  expect(text.length).toBe(stats.indexBytes);

  const parsed = JSON.parse(text);
  expect(parsed.t.length).toBeGreaterThan(0);
  for (const target of parsed.t) {
    for (const packed of Object.values(target.s)) {
      expect(typeof packed.e).toBe('string');
      expect(typeof packed.h).toBe('boolean');
    }
  }
});

test('索引里的角色名能对应上加载后的目标（目标 id 每次加载都变，所以只能用名字）', async () => {
  const buffer = readFixture(path.join('execute', 'order-library.sb3'));
  const {index} = await buildIndex(buffer);
  const indexedNames = index.t.map((target) => target.n).sort();
  expect(indexedNames.length).toBeGreaterThan(0);
  // 没有脚本的目标不进索引（Stage 通常就是这样）
  expect(indexedNames).not.toContain('Stage');

  const vmA = await newVm(buffer);
  const vmB = await newVm(buffer);
  const namesA = vmA.runtime.targets.map((target) => target.getName());
  const namesB = vmB.runtime.targets.map((target) => target.getName());
  for (const name of indexedNames) {
    expect(namesA).toContain(name);
    expect(namesB).toContain(name);
  }

  // 顺带确认 id 真的不稳定，说明「按名字索引」不是多此一举
  const idsA = vmA.runtime.targets.map((target) => target.id).sort();
  const idsB = vmB.runtime.targets.map((target) => target.id).sort();
  expect(idsA).not.toEqual(idsB);
});

/* ------------------------- 压缩（terser）相关 ------------------------- */

test('terser 压缩后源码仍能求值出函数，且确实变小', () => {
  const {createScriptMinifier} = require('../../src/packager/protect/minify-script');
  const jsexecute = require('scratch-vm/src/compiler/jsexecute');
  const minifier = createScriptMinifier();
  const source = '(function factory0(thread) { const target = thread.target; const runtime = target.runtime; ' +
    'const b0 = runtime.getOpcodeFunction("music_restForBeats"); ' +
    'return function* gen0 () { yield* executeInCompatibilityLayer({"BEATS": 0,}, b0, true, false, "m", null); ' +
    'runtime.ext_scratch3_looks._say("hello world", target); }; })';

  const minified = minifier(source);
  expect(minified.length).toBeGreaterThan(0);
  expect(minified.length).toBeLessThan(source.length);
  expect(typeof jsexecute.scopedEval(minified)).toBe('function');
  // 自解释的调用名会被保留（是外部引用，不该被改名），但局部变量会被压掉
  expect(minified).toContain('executeInCompatibilityLayer');
  expect(minified).not.toContain('factory0');
});

test('压缩版与未压缩版的预编译产物行为一致', async () => {
  const buffer = readFixture(path.join('execute', 'tw-comparison-matrix-runtime.sb3'));

  const vmPlain = await newVm(buffer);
  const json = await readProjectJSON(buffer);
  const plain = compileProject(vmPlain, {extensionURLs: json.extensionURLs || {}});

  const vmMin = await newVm(buffer);
  const minified = compileProject(vmMin, {extensionURLs: json.extensionURLs || {}, minify: true});
  expect(minified.stats.minified).toBeGreaterThan(0);
  expect(minified.stats.minifyFailed).toBe(0);
  expect(minified.stats.indexBytes).toBeLessThan(plain.stats.indexBytes);

  const original = await newVm(buffer);
  await runFor(original, 120);

  const stripped = await stripArchive(buffer, minified.index);
  const protectedVm = await newVm(stripped.buffer);
  const applied = await applyPrecompiled(protectedVm, minified.index);
  expect(applied.ok).toBe(true);
  expect(verifyRuntimeRefs(protectedVm, minified.index).ok).toBe(true);
  await runFor(protectedVm, 120);

  expect(snapshot(protectedVm)).toEqual(snapshot(original));
}, 60000);
