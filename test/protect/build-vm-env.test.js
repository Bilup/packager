/*
 * 构建期 VM 的**环境**回归测试。
 *
 * 起因是一个只在真实大工程上才暴露的静默退化（2026-09-23）：
 * 33MB 的 PVZ 工程用 CLI 打包时，8 种保护等级的产物**索引全是空的** ——
 * 也就是「中/高」这几档只拿到了混淆那一层，预编译与摘积木整份没生效，
 * 而 packager 只留了一条警告。
 *
 * 两个独立原因，都必须守住：
 *
 *  1. **构建 VM 必须有 storage。**
 *     新版 scratch-vm 的 `FontManager.deserialize` 会读 `runtime.storage.AssetType.Font`
 *     （engine/tw-font-manager.js + util/tw-asset-util.js 的 getByMd5ext）。
 *     工程只要带自定义字体，`loadProject` 就会抛
 *     `Cannot read properties of undefined (reading 'AssetType')`，
 *     而 createBuildVm 一抛错就是**整份放弃预编译**（不是部分降级）。
 *
 *  2. **Node 里加载非沙箱扩展需要最小 DOM 垫片。**
 *     TurboWarp 的非沙箱扩展是靠「往页面插 <script>」执行的，
 *     Node 没有 document 时一个都装不上，一级降级必然失败
 *     （见 extension-load-shim.js 与它自己的测试）。
 *
 * 字体用的是**注入的假字体**：真实字体字节对这条路径没有意义，
 * VM 只是按 md5ext 从 zip 里取一条数据交给 storage.createAsset，
 * 所以给几十字节的占位数据就足够复现「反序列化会碰到 storage」这件事。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import JSZip from '@turbowarp/jszip';
import ScratchStorage from '@bilup/scratch-storage';

import {buildPrecompiledProject} from '../../src/packager/protect/build';

const FIXTURES = path.join(__dirname, '..', '..', 'node_modules', 'scratch-vm', 'test', 'fixtures');
// 一个干净的、没有扩展依赖的小工程
const BASE_FIXTURE = path.join('execute', 'tw-forkphorus-515-wait-zero-seconds-in-warp-mode.sb3');

/**
 * 往工程里塞一个自定义字体（zip 条目 + project.json.customFonts）。
 * @returns {Promise<{buffer: Buffer, projectJSON: object, md5ext: string}>}
 */
const withCustomFont = async () => {
  const bytes = Buffer.from(new Uint8Array(64).fill(7));
  const md5ext = `${crypto.createHash('md5').update(bytes).digest('hex')}.ttf`;

  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(FIXTURES, BASE_FIXTURE)));
  const projectJSON = JSON.parse(await zip.file('project.json').async('string'));
  // ⚠️ `system: false` 不能省：FontManager.deserialize 会对
  //    `typeof font.system !== 'boolean'` 的条目直接 continue，压根走不到读 storage 那一步，
  //    于是这个测试会「假通过」——不加这一条时我实测过，去掉 storage 挂载它照样绿。
  projectJSON.customFonts = [{system: false, family: 'TestFont', fallback: 'sans-serif', md5ext}];
  zip.file(md5ext, bytes);
  zip.file('project.json', JSON.stringify(projectJSON));

  return {
    buffer: await zip.generateAsync({type: 'nodebuffer'}),
    projectJSON,
    md5ext
  };
};

describe('构建期 VM 的环境要求', () => {
  test('storage 必须提供 AssetType.Font —— 这正是 FontManager 反序列化时读的东西', () => {
    const storage = new ScratchStorage();
    expect(storage.AssetType.Font).toBeTruthy();
    expect(typeof storage.createAsset).toBe('function');
  });

  test('带自定义字体的工程能被预编译（构建 VM 已挂 storage）', async () => {
    const {buffer, projectJSON, md5ext} = await withCustomFont();
    expect(projectJSON.customFonts[0].md5ext).toBe(md5ext);

    const built = await buildPrecompiledProject({
      projectBuffer: buffer,
      projectJSON,
      JSZip,
      stripBlocks: false,
      compilerOptions: {warpTimer: false},
      extensionURLs: projectJSON.extensionURLs || {},
      extraExtensions: [],
      // 关掉压缩：这个测试只关心「能不能编译」，不该受 terser 影响
      minify: false
    });

    expect(built.ok).toBe(true);
    // 一条降级警告都不该有：缺 storage 时会以「放开扩展限制后加载工程失败
    // （Cannot read properties of undefined (reading 'AssetType')），改为不加载…」的形式出现，
    // 而那种情况下 built.ok 就是 false（整份放弃预编译）。
    expect(built.warnings).toEqual([]);
    expect(built.stats.compiled).toBeGreaterThan(0);
    expect(built.stats.failed).toBe(0);
  });
});
