/*
 * renderer-stub.js 的回归测试。
 *
 * 为什么值得专门测：
 *   这是「构建期能不能装上有渲染器依赖的扩展」的唯一支点。它一坏，
 *   text.js / cursor.js 就装不上，引用它们的脚本会**静默**退回保留积木 ——
 *   打包照样成功、产物照样能跑，只是保护破了个口子，很难被发现。
 *
 * 这里不加载真扩展（要联网），只钉住替身必须满足的契约：
 *   - `gl.CLAMP_TO_EDGE` 之类常量读出来是数字（WebGL 常量语义）
 *   - `canvas.getContext('2d' | 'webgl')` 两种都拿得到、`canvas.style` 可写
 *   - `exports.Skin` 能被 `class X extends Skin` 继承并 `super(id, renderer)`
 *   - `withRendererStub` 执行完把 `runtime.renderer` 还原（连「有没有这个属性」都还原）
 */

import {createRendererStub, withRendererStub} from '../../src/packager/protect/renderer-stub';

describe('createRendererStub', () => {
  test('扩展在顶层会碰的那几个字段都在', () => {
    const renderer = createRendererStub();

    // text.js: const gl = vm.renderer.gl
    expect(renderer.gl).toBeTruthy();
    // cursor.js: const canvas = Scratch.renderer.canvas
    expect(renderer.canvas).toBeTruthy();
    expect(renderer.canvas.style).toEqual({});
    // text.js: renderer.exports.{Skin, CanvasMeasurementProvider, twgl}
    expect(typeof renderer.exports.Skin).toBe('function');
    expect(typeof renderer.exports.CanvasMeasurementProvider).toBe('function');
    expect(renderer.exports.twgl).toBeTruthy();
  });

  test('WebGL 常量读出来是数字，未知方法读出来是空函数', () => {
    const {gl} = createRendererStub();

    expect(typeof gl.CLAMP_TO_EDGE).toBe('number');
    expect(typeof gl.TEXTURE_2D).toBe('number');
    // 同名常量必须稳定（同一上下文里两次读要相等，否则扩展里的查表会漂）
    expect(gl.TEXTURE_2D).toBe(gl.TEXTURE_2D);
    expect(typeof gl.deleteTexture).toBe('function');
    expect(gl.deleteTexture({})).toBeUndefined();
    // 不能是 thenable：否则 `await renderer.gl` 会永远挂住
    expect(gl.then).toBeUndefined();
  });

  test('canvas.getContext 按类型分派，2D 上下文能测量文本', () => {
    const {canvas} = createRendererStub();

    const ctx = canvas.getContext('2d');
    expect(ctx.measureText('hello').width).toBe(0);

    const gl = canvas.getContext('webgl');
    expect(typeof gl.CLAMP_TO_EDGE).toBe('number');
    expect(canvas.toDataURL()).toMatch(/^data:image\/png/);
    // 扩展会写 canvas.width/height 与 style.cursor
    canvas.width = 64;
    canvas.style.cursor = 'pointer';
    expect(canvas.width).toBe(64);
    expect(canvas.style.cursor).toBe('pointer');
  });

  test('exports.Skin 可以被继承（text.js 是 `class TextCostumeSkin extends Skin`）', () => {
    const renderer = createRendererStub();

    class FakeSkin extends renderer.exports.Skin {
      constructor (id, target) {
        super(id, renderer);
        this.target = target;
      }
    }

    const skin = new FakeSkin('skin-1', {name: 'sprite'});
    expect(skin.id).toBe('skin-1');
    expect(skin.renderer).toBe(renderer);
    expect(skin.size).toEqual([0, 0]);
    expect(() => skin.dispose()).not.toThrow();
    expect(new renderer.exports.CanvasMeasurementProvider({}).measureTextSize()).toEqual({width: 0, height: 0});
  });
});

describe('withRendererStub', () => {
  test('执行期间挂上替身，执行完还原（原本没有这个属性）', async () => {
    const runtime = {};
    const vm = {runtime};

    let seenDuring = null;
    await withRendererStub(vm, async () => {
      seenDuring = runtime.renderer;
      expect(seenDuring.gl).toBeTruthy();
    });

    expect(seenDuring).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(runtime, 'renderer')).toBe(false);
  });

  test('原本是 null 时还原成 null（不是删掉）', async () => {
    const runtime = {renderer: null};
    const vm = {runtime};

    await withRendererStub(vm, async () => {
      expect(runtime.renderer.gl).toBeTruthy();
    });

    expect(runtime.renderer).toBeNull();
  });

  test('已经有真渲染器时一律不覆盖（浏览器宿主）', async () => {
    const realRenderer = {gl: {real: true}};
    const runtime = {renderer: realRenderer};
    const vm = {runtime};

    await withRendererStub(vm, async () => {
      expect(runtime.renderer).toBe(realRenderer);
    });

    expect(runtime.renderer).toBe(realRenderer);
  });

  test('回调抛错也要还原', async () => {
    const runtime = {};
    const vm = {runtime};

    await expect(withRendererStub(vm, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(Object.prototype.hasOwnProperty.call(runtime, 'renderer')).toBe(false);
  });
});
