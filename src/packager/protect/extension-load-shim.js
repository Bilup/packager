/*
 * Node 环境下的「最小浏览器垫片」—— 让 TurboWarp 的**非沙箱扩展**能在打包期加载。
 *
 * 为什么需要它：
 *   `tw-unsandboxed-extension-runner.js` 执行扩展脚本的方式是
 *   `document.createElement('script')` + `document.body.appendChild(script)`，
 *   而 Node 里没有 `document`。没有垫片时**一个自定义扩展都装不上**，
 *   表现为构建期 `loadProject` 因扩展失败而抛错 → 预编译整份降级
 *   （实测：一个用了 5 个扩展的工程，8 种保护等级的产物索引全是空的）。
 *
 * 垫片只做三件事（够 runner 跑完就行）：
 *   1. `document.createElement('script')` 返回一个可以挂 `src/onload/onerror` 的假元素
 *   2. `document.body.appendChild(script)` 时真的去抓那个 URL、执行源码、再回调 `onload`
 *   3. 顺手补上 `location`（runner 里 `parseURL` 会读 `location.href`）与 `window`
 *
 * ⚠️ 只在**缺 `document` 时**安装 —— 浏览器里本来就有的东西一概不动。
 *    `restore()` 会把全局恢复原样（Node 的 `navigator` 是只读 getter，恢复时要绕开）。
 *
 * ⚠️ 这是在 Node 进程里执行第三方扩展代码（与 GUI 在页面里执行是同一风险等级，
 *    但 Node 有文件系统权限）。垫片只在打包期必需的那一小段窗口内安装。
 */

/** 垫片会碰的全局键 */
const SHIMMED_KEYS = ['document', 'location', 'window', 'addEventListener', 'removeEventListener'];

/**
 * 取一个 fetch 实现。
 *
 * 不用 `globalThis.fetch` 直接调：旧 Node 没有它，而且 jest 的测试环境里也不一定暴露
 * （实测 jest 下全局 fetch 是 undefined，垫片会直接报 ReferenceError）。
 * `cross-fetch` 本来就是本项目的依赖，正好兜住这两种情况。
 */
const getFetch = () => {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch;
  const crossFetch = require('cross-fetch');
  return crossFetch.default || crossFetch;
};

/**
 * 读一段扩展脚本的源码。
 *
 * `data:` 自己解，不走 fetch：`bakeExtensions` 会把扩展源码打成
 * `data:text/javascript;,<encodeURIComponent(...)>`，而 cross-fetch 的底层 node-fetch
 * **不支持 data: 协议** —— 在没有全局 fetch 的环境里那条路会断掉。
 */
const readScriptSource = async (url) => {
  const href = String(url);
  if (href.slice(0, 5).toLowerCase() === 'data:') {
    const comma = href.indexOf(',');
    if (comma === -1) throw new Error(`Malformed data URL: ${href.slice(0, 60)}`);
    const meta = href.slice(5, comma);
    const payload = href.slice(comma + 1);
    if (/;base64/i.test(meta)) return Buffer.from(payload, 'base64').toString('utf8');
    return decodeURIComponent(payload);
  }
  const fetchImpl = getFetch();
  const response = await fetchImpl(href);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
};

/** 抓取并执行一段扩展脚本；成功与否通过 onload/onerror 回调告知调用方 */
const loadScriptInto = (element) => {
  Promise.resolve().then(async () => {
    try {
      const source = await readScriptSource(element.src);
      // 用间接 eval 在**全局作用域**里执行，等价于浏览器插入 <script>：
      // 扩展的 IIFE 靠全局 `Scratch`（runner 自己挂在 global 上）取到 API。
      const globalEval = eval; // eslint-disable-line no-eval
      globalEval(source);
      if (typeof element.onload === 'function') element.onload();
    } catch (error) {
      if (typeof element.onerror === 'function') element.onerror(error);
    }
  });
};

const createElementStub = (tagName) => {
  const noop = () => {};
  const name = String(tagName || '').toLowerCase();
  const element = {
    tagName: name.toUpperCase(),
    nodeName: name.toUpperCase(),
    src: '',
    href: '',
    rel: '',
    as: '',
    style: {},
    onload: null,
    onerror: null,
    setAttribute: noop,
    getAttribute: () => null,
    removeAttribute: noop,
    addEventListener: noop,
    removeEventListener: noop,
    remove: noop,
    // 扩展调用 openLink 时会走到这里；打包期不需要真的打开浏览器
    click: noop,
    appendChild: (child) => child
  };
  return element;
};

/**
 * 安装垫片。
 * @returns {Function} 恢复全局的回调（务必在 finally 里调用）
 */
const installExtensionLoadShims = () => {
  // 浏览器（或已有其它垫片的宿主）里什么都不用做
  if (typeof globalThis.document !== 'undefined') {
    return () => {};
  }

  const noop = () => {};
  const saved = {};
  for (const key of SHIMMED_KEYS) {
    saved[key] = {had: Object.prototype.hasOwnProperty.call(globalThis, key), value: globalThis[key]};
  }

  const body = {
    style: {},
    appendChild: (element) => {
      if (element && element.tagName === 'SCRIPT') loadScriptInto(element);
      return element;
    },
    removeChild: (element) => element,
    addEventListener: noop,
    removeEventListener: noop
  };

  const documentStub = {
    body,
    // head 故意留 undefined：runner 里 `if (document.head)` 会直接跳过 preload <link>，
    // 而 preload 对打包期毫无意义
    head: undefined,
    documentElement: {style: {}},
    createElement: createElementStub,
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: () => null,
    getElementsByTagName: () => [],
    querySelector: () => null,
    querySelectorAll: () => []
  };

  globalThis.document = documentStub;
  globalThis.location = {href: 'http://localhost/', protocol: 'http:', hostname: 'localhost', pathname: '/'};
  // 不少扩展会做 `window.addEventListener(...)` 或读 `window.location`
  globalThis.window = globalThis;
  if (typeof globalThis.addEventListener !== 'function') {
    globalThis.addEventListener = noop;
    globalThis.removeEventListener = noop;
  }

  return () => {
    for (const key of SHIMMED_KEYS) {
      const {had, value} = saved[key];
      try {
        if (had) globalThis[key] = value;
        else delete globalThis[key];
      } catch (error) {
        // Node 里有些全局是只读 getter（例如 navigator），删不掉也改不了 —— 忽略即可
      }
    }
  };
};

module.exports = {
  installExtensionLoadShims
};
