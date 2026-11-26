/*
 * 构建期的「渲染器替身」。
 *
 * 为什么需要它：
 *   TurboWarp 生态里有一批扩展在**加载时**（顶层代码，不是运行时）就去摸渲染器 ——
 *   `const gl = Scratch.vm.renderer.gl`、`const canvas = Scratch.renderer.canvas`。
 *   构建 VM 没有渲染器（无头 Node 里也没有 WebGL），于是这些扩展的顶层代码直接抛
 *   `Cannot read properties of undefined (reading 'gl')`，`<script>` 的 onerror 触发，
 *   runner 报 `Failed to load extension script from <url>`。
 *
 *   后果不是「扩展功能缺失」，而是**引用它的脚本全部编译不了、退回保留积木**：
 *   实测 PvZ·争鸣（832 段脚本）里 text.js + cursor.js 让 12 段脚本退回解释器，
 *   多留下 171 块明文积木 —— 保护在这一点上直接破口。
 *
 * 替身的边界（很重要）：
 *   - 只在**加载扩展**这一段窗口里挂上去，装完立刻摘掉。
 *     不能让它活到 `loadProject` —— 一旦 `runtime.renderer` 有值，反序列化就会真去调
 *     `createSVGSkin` / `updateDrawable` 之类，替身只会把素材加载搅坏。
 *   - 它**不参与任何运算**：扩展的积木函数在产物里由浏览器中的真渲染器执行，
 *     构建期只要 `getInfo()` 能跑通、opcode 能注册上就够了。
 *   - 认不出来的成员一律返回空函数、全大写名字返回数字（WebGL 常量都是数字），
 *     这样 `gl.CLAMP_TO_EDGE` 之类的**读取**不会炸；真拿去做运算只会得到无意义结果，
 *     而这条路径在构建期根本不会被执行。
 *
 * 本文件用 CommonJS 写，方便 Node 直接 require 做回归测试。
 */

const noop = () => {};

/** WebGL 常量名形如 `TEXTURE_2D` / `MAX_TEXTURE_SIZE`：一律是数字 */
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * 造一个「什么都有、但什么都不做」的对象。
 *
 * @param {object} [specials] 需要特殊处理的成员（会被拷进底层对象，读取时优先命中）
 * @param {object} [options]
 * @param {number} [options.constantBase] 自动生成的常量起始值（同类对象要各用一段，
 *        避免不同上下文里同名常量拿到同一个值而被误判相等）
 */
const createObjectStub = (specials = {}, options = {}) => {
  const store = Object.assign({}, specials);
  let nextConstant = options.constantBase || 0x1000;
  return new Proxy(store, {
    get (target, property) {
      // 别让替身变成 thenable：任何 `await stub` 都会卡住（能 await 的对象必须没有 then，
      // 或者 then 是函数；这里两者都不给）
      if (property === 'then') return undefined;
      if (property in target) return target[property];
      if (typeof property !== 'string') return undefined;
      if (CONSTANT_NAME.test(property)) {
        const value = nextConstant++;
        target[property] = value;
        return value;
      }
      target[property] = noop;
      return noop;
    },
    set (target, property, value) {
      target[property] = value;
      return true;
    },
    has () {
      return true;
    }
  });
};

/** 2D 画布上下文替身：只有测量类方法给出**形状正确**的返回值（其余一律空实现） */
const createContext2dStub = (canvas) => createObjectStub({
  canvas,
  measureText: () => ({
    width: 0,
    actualBoundingBoxAscent: 0,
    actualBoundingBoxDescent: 0,
    fontBoundingBoxAscent: 0,
    fontBoundingBoxDescent: 0
  }),
  getImageData: () => ({data: new Uint8ClampedArray(4), width: 1, height: 1}),
  createImageData: () => ({data: new Uint8ClampedArray(4), width: 1, height: 1}),
  createLinearGradient: () => createObjectStub({addColorStop: noop}),
  createRadialGradient: () => createObjectStub({addColorStop: noop}),
  createPattern: () => ({})
});

/** WebGL 上下文替身（只为「读得到、不炸」） */
const createGLStub = (canvas) => createObjectStub({
  canvas,
  drawingBufferWidth: 0,
  drawingBufferHeight: 0,
  getParameter: () => 0,
  getExtension: () => null,
  getSupportedExtensions: () => [],
  getShaderParameter: () => true,
  getProgramParameter: () => true,
  getShaderInfoLog: () => '',
  getProgramInfoLog: () => '',
  getAttribLocation: () => 0,
  getUniformLocation: () => ({}),
  createShader: () => ({}),
  createProgram: () => ({}),
  createTexture: () => ({}),
  createBuffer: () => ({}),
  createFramebuffer: () => ({}),
  createRenderbuffer: () => ({}),
  checkFramebufferStatus: () => 0,
  isContextLost: () => false
});

const createCanvasStub = () => {
  const canvas = createObjectStub({
    width: 0,
    height: 0,
    style: {},
    clientWidth: 0,
    clientHeight: 0,
    toDataURL: () => 'data:image/png;base64,',
    toBlob: noop,
    getBoundingClientRect: () => ({x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0})
  });
  // getContext 要按类型分派：2D 与 WebGL 是两套方法表
  canvas.getContext = (type) => {
    const name = String(type || '').toLowerCase();
    return name.indexOf('webgl') === 0 ? createGLStub(canvas) : createContext2dStub(canvas);
  };
  return canvas;
};

/** scratch-render 的 `Skin` 基类替身：扩展只是 `class X extends Skin` + `super(id, renderer)` */
class SkinStub {
  constructor (id, renderer) {
    this.id = id;
    this.renderer = renderer;
    this._size = [0, 0];
  }

  get size () {
    return this._size;
  }

  // Part of Skin API
  dispose () {}

  useNearest () {
    return false;
  }

  setTexture () {}

  setRotationCenter () {}
}

/** scratch-render 的文字测量器替身（`new CanvasMeasurementProvider(ctx)`） */
class CanvasMeasurementProviderStub {
  constructor (context) {
    this._context = context;
  }

  measureTextSize () {
    return {width: 0, height: 0};
  }
}

/**
 * 造一个渲染器替身。
 *
 * 字段对齐真实 `RenderWebGL` 里扩展实际会碰的那几处：
 *   `renderer.gl` / `renderer.canvas` / `renderer.exports.{Skin, CanvasMeasurementProvider, twgl}`
 */
const createRendererStub = () => {
  const canvas = createCanvasStub();
  return {
    gl: createGLStub(canvas),
    canvas,
    exports: {
      Skin: SkinStub,
      CanvasMeasurementProvider: CanvasMeasurementProviderStub,
      twgl: createObjectStub({
        createTexture: () => ({}),
        createBufferInfoFromArrays: () => ({attribs: {}, numElements: 0}),
        createFramebufferInfo: () => ({framebuffer: {}}),
        resizeCanvasToDisplaySize: () => false,
        drawBufferInfo: noop,
        setBuffersAndAttributes: noop,
        setUniforms: noop
      })
    },
    width: 480,
    height: 360,
    // 少数扩展会直接问渲染器要尺寸/图层/拾取信息
    setStageSize: noop,
    setLayerGroupOrdering: noop,
    draw: noop,
    pick: () => -1,
    getBounds: () => ({left: 0, right: 0, top: 0, bottom: 0}),
    getFencedPositionOfDrawable: () => [0, 0],
    isTouchingDrawables: () => false,
    extractDrawableScreenSpace: () => ({x: 0, y: 0}),
    createSVGSkin: () => 0,
    createBitmapSkin: () => 0,
    createDrawable: () => 0,
    updateDrawableSkinId: noop,
    updateDrawableVisible: noop,
    updateDrawablePosition: noop,
    destroyDrawable: noop,
    setDrawableOrder: noop
  };
};

/**
 * 在「挂了渲染器替身」的状态下执行一段异步逻辑，结束后原样恢复。
 *
 * - 已经有真渲染器时（浏览器宿主）什么都不做，直接执行 —— 真的永远比替身好；
 * - 恢复时连「有没有这个属性」都还原：构建 VM 的 `runtime.renderer` 本来就没有/是 null，
 *   留着替身会让 `loadProject` 误以为有渲染器。
 *
 * @param {object} vm 构建 VM
 * @param {Function} fn 要执行的逻辑（通常是「加载扩展」）
 */
const withRendererStub = async (vm, fn) => {
  const runtime = vm && vm.runtime;
  if (!runtime || runtime.renderer) return fn();

  const had = Object.prototype.hasOwnProperty.call(runtime, 'renderer');
  const previous = runtime.renderer;
  runtime.renderer = createRendererStub();
  try {
    return await fn();
  } finally {
    if (had) runtime.renderer = previous;
    else delete runtime.renderer;
  }
};

module.exports = {
  createRendererStub,
  withRendererStub
};
