/*
 * extension-load-shim.js 的行为约定。
 *
 * 这个垫片要在 Node 里伪造 `document` / `window` / `location` 来让非沙箱扩展能加载，
 * 所以它最容易出问题的地方不是「能不能用」，而是「会不会污染宿主」：
 *   - 浏览器里（本来就有 document）必须**什么都不做**
 *   - 用完必须能**完全还原**，否则打包器后续代码会以为自己在浏览器里跑
 *     （很多库靠 `typeof window !== 'undefined'` 切分支）
 */
import {
  installExtensionLoadShims
} from '../../src/packager/protect/extension-load-shim';

const GLOBAL_KEYS = ['document', 'location', 'window', 'addEventListener', 'removeEventListener'];

/** 记录当前全局状态，用于比对是否被改动过 */
const snapshotGlobals = () => {
  const snapshot = {};
  for (const key of GLOBAL_KEYS) {
    snapshot[key] = {
      has: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: globalThis[key]
    };
  }
  return snapshot;
};

const globalsMatch = (snapshot) => {
  for (const key of GLOBAL_KEYS) {
    const {has, value} = snapshot[key];
    expect(Object.prototype.hasOwnProperty.call(globalThis, key)).toBe(has);
    if (has) expect(globalThis[key]).toBe(value);
  }
};

describe('installExtensionLoadShims', () => {
  test('已经有 document 时是空操作（浏览器里不能碰宿主）', () => {
    const fakeDocument = {body: {}};
    globalThis.document = fakeDocument;
    try {
      const restore = installExtensionLoadShims();
      expect(globalThis.document).toBe(fakeDocument);
      expect(typeof restore).toBe('function');
      restore();
      // 空操作的 restore 也不该动任何东西
      expect(globalThis.document).toBe(fakeDocument);
    } finally {
      delete globalThis.document;
    }
  });

  test('缺 document 时装出垫片，restore 后全局完全还原', () => {
    const before = snapshotGlobals();
    expect(typeof globalThis.document).toBe('undefined');

    const restore = installExtensionLoadShims();
    expect(typeof globalThis.document).toBe('object');
    expect(typeof globalThis.document.createElement).toBe('function');
    expect(globalThis.location.href).toBeTruthy();
    expect(globalThis.window).toBe(globalThis);

    restore();
    globalsMatch(before);
  });

  test('appendChild(<script>) 真的会执行脚本，然后回调 onload', async () => {
    const before = snapshotGlobals();
    delete globalThis.__shimProbe;

    const restore = installExtensionLoadShims();
    try {
      const script = globalThis.document.createElement('script');
      const loaded = new Promise((resolve, reject) => {
        script.onload = () => resolve('loaded');
        script.onerror = (error) => reject(error);
      });
      // data: URL 无需网络，正好验证「抓源码 → 全局作用域执行」这条链
      script.src = 'data:text/javascript;,globalThis.__shimProbe=(globalThis.__shimProbe||0)+1';
      globalThis.document.body.appendChild(script);

      await expect(loaded).resolves.toBe('loaded');
      expect(globalThis.__shimProbe).toBe(1);
    } finally {
      restore();
      delete globalThis.__shimProbe;
      globalsMatch(before);
    }
  });

  test('脚本取不到时回调 onerror（而不是静默）', async () => {
    const before = snapshotGlobals();

    const restore = installExtensionLoadShims();
    try {
      const script = globalThis.document.createElement('script');
      const failed = new Promise((resolve) => {
        script.onload = () => resolve('loaded');
        script.onerror = (error) => resolve(error);
      });
      // 不可达的地址：必须很快失败（本机 9 端口通常无监听）
      script.src = 'http://127.0.0.1:9/definitely-not-here.js';
      globalThis.document.body.appendChild(script);

      const outcome = await failed;
      expect(outcome).not.toBe('loaded');
      expect(outcome).toBeInstanceOf(Error);
    } finally {
      restore();
      globalsMatch(before);
    }
  });
});
