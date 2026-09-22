/*
 * 产物 HTML 的结构自检回归测试。
 *
 * 冲着一次真实事故写的：generateObfuscatedScriptTag() 里的闭合标签被写成
 * `<\\/script>`（模板字符串里 `\\` 会输出一个**字面反斜杠**），产物里于是留下
 * `<\/script>`。HTML 解析器不认这个序列，脚本会一直吞到后面第一个真正的
 * `</script>`，把下一个 `<script>` 也吃进来 —— 结果是：
 *
 *   Uncaught SyntaxError: Unexpected token '<'
 *   ReferenceError: Scaffolding is not defined
 *   ReferenceError: scaffolding is not defined
 *   ReferenceError: getProjectData is not defined
 *
 * 整页打不开，而**打包过程一句报错都没有**。所以这里两层都要盖住：
 *   1. 生成出来的脚本标签必须是「真闭合标签」，而且内容能真的跑起来；
 *   2. assertBalancedScriptTags() 必须能把这类坏产物拦住。
 */
import Packager from '../../src/packager/packager';

const makePackager = () => new Packager();

/** 按 packager 自己的方式编码一个 chunk（btoa(unescape(encodeURIComponent(...)))） */
const encodeChunk = (source) => btoa(unescape(encodeURIComponent(source)));

describe('generateObfuscatedScriptTag', () => {
  test('闭合标签必须是真正的 </script>，不能带反斜杠', () => {
    const packager = makePackager();
    packager.obfuscatedScript = [encodeChunk('var a = 1;')];

    const tag = packager.generateObfuscatedScriptTag();

    expect(tag).toContain('</script>');
    const backslash = String.fromCharCode(92);
    expect(tag).not.toContain('<' + backslash + '/script>');
  });

  test('标签配平：1 个开标签 + 1 个闭标签', () => {
    const packager = makePackager();
    packager.obfuscatedScript = [encodeChunk('var a = 1;')];

    const tag = packager.generateObfuscatedScriptTag();

    expect((tag.match(/<script(?=[\s>/])/gi) || []).length).toBe(1);
    expect((tag.match(/<\/script(?=[\s>])/gi) || []).length).toBe(1);
  });

  test('标签里的代码真的能跑：混淆分片被还原并 eval 出来', () => {
    const packager = makePackager();
    const source = 'globalThis.__BILUP_TAG_TEST__ = "ok";';
    packager.obfuscatedScript = [encodeChunk(source)];

    const tag = packager.generateObfuscatedScriptTag();
    // 取出 <script> 与 </script> 之间的可执行部分
    const inner = tag.slice(tag.indexOf('<script>') + '<script>'.length, tag.lastIndexOf('</script>'));

    delete globalThis.__BILUP_TAG_TEST__;
    // eslint-disable-next-line no-new-func
    new Function(inner)();

    expect(globalThis.__BILUP_TAG_TEST__).toBe('ok');
    delete globalThis.__BILUP_TAG_TEST__;
  });

  test('多分片内容按顺序拼接', () => {
    const packager = makePackager();
    // 故意把一段代码切成两半，验证拼接顺序
    packager.obfuscatedScript = [
      encodeChunk('globalThis.__BILUP_ORDER__ = '),
      encodeChunk('"a" + "b";')
    ];

    const tag = packager.generateObfuscatedScriptTag();
    const inner = tag.slice(tag.indexOf('<script>') + '<script>'.length, tag.lastIndexOf('</script>'));

    delete globalThis.__BILUP_ORDER__;
    // eslint-disable-next-line no-new-func
    new Function(inner)();

    expect(globalThis.__BILUP_ORDER__).toBe('ab');
    delete globalThis.__BILUP_ORDER__;
  });
});

describe('预编译装载代码', () => {
  test('会等待扩展加载句柄落地，并暴露装载报告（不再静默降级）', () => {
    const packager = makePackager();
    // generatePrecompiledInstallCode 只在有索引时才产出内容
    packager.precompiledIndexText = '{"v":3,"t":[]}';

    const code = packager.generatePrecompiledInstallCode();

    // 1) 等 window.__BILUP_EXTENSION_LOADS__（产物里扩展是异步启动的，不等就会把
    //    「正在加载」误判成「加载不了」，进而整体拒绝装载）
    expect(code).toContain('__BILUP_EXTENSION_LOADS__');
    expect(code).toMatch(/await Promise\.all\(/);
    // 2) 报告必须挂到 window 上，并在不完整时告警 —— 以前这一步是完全静默的
    expect(code).toContain('__BILUP_PRECOMPILED_REPORT__');
    expect(code).toContain('console.warn');
    expect(code).toContain('installed === 0');
    // 3) 扩展加载失败也必须报出来（以前只是 unhandled rejection，看不出是哪条 URL）
    expect(code).toContain('有扩展没能加载');
  });

  test('没有索引时不产出任何装载代码', () => {
    const packager = makePackager();
    expect(packager.generatePrecompiledInstallCode()).toBe('');
  });
});

describe('assertBalancedScriptTags', () => {
  test('配平的 HTML 通过', () => {
    const packager = makePackager();
    const html = '<html><body><script>var a=1;</script><script data="x">y</script></body></html>';
    expect(() => packager.assertBalancedScriptTags(html)).not.toThrow();
  });

  test('接 Uint8Array 也接字符串（产物其实是字节，见 encodeBigString）', () => {
    const packager = makePackager();
    const html = '<script>var a=1;</script>';
    expect(() => packager.assertBalancedScriptTags(new TextEncoder().encode(html))).not.toThrow();
  });

  test('闭标签被转义时抛错，并把被转义的标签作为线索指出', () => {
    const packager = makePackager();
    const backslash = String.fromCharCode(92);
    // 正是事故产物的形态：转义的闭合标签后面紧跟一个真正的 <script>
    const html = '<script>\nvar a=1;\n' + '<' + backslash + '/script>\n<script>var b=2;</script>';

    expect(() => packager.assertBalancedScriptTags(html)).toThrow(/不配平/);
    expect(() => packager.assertBalancedScriptTags(html)).toThrow(/被转义的闭合标签/);
  });

  test('开闭数量不配平时抛错', () => {
    const packager = makePackager();
    // 两个开标签、一个闭标签 —— 正是「闭标签写坏被吞掉」之后的形态
    const html = '<script>var a=1;</script><script>var b=2;';

    expect(() => packager.assertBalancedScriptTags(html)).toThrow(/不配平/);
  });

  test('内容里混进未转义的 </script 时也抛错（闭多开少）', () => {
    const packager = makePackager();
    const html = '<script>var s = "</script>";</script>';
    expect(() => packager.assertBalancedScriptTags(html)).toThrow(/不配平/);
  });

  test('noscript 不该被误判成 script', () => {
    const packager = makePackager();
    const html = '<noscript>Enable JavaScript</noscript><script>var a=1;</script>';
    expect(() => packager.assertBalancedScriptTags(html)).not.toThrow();
  });

  test('JS 字符串字面量里转义过的 <\\/script> 不会误判（配平就放行）', () => {
    const packager = makePackager();
    const backslash = String.fromCharCode(92);
    // 合法：字符串里的 <\/script> 不含 `</script` 序列，配平也是对的
    const html = '<script>var s = "a<' + backslash + '/script>b";</script>';

    expect(() => packager.assertBalancedScriptTags(html)).not.toThrow();
  });

  test('脚本内容里裸的 <script（正则 / 字符串里）不该被算成开标签', () => {
    const packager = makePackager();
    const backslash = String.fromCharCode(92);
    // 真实运行时里就有这种代码（metadata 清洗），它是合法的、必须放行
    const code = 'x.replace(/<script[' + backslash + 's' + backslash + 'S]*>[' +
      backslash + 's' + backslash + 'S]*<' + backslash + '/script>/,"<script><' +
      backslash + '/script>")';
    const html = '<script>' + code + '</script>';

    expect(() => packager.assertBalancedScriptTags(html)).not.toThrow();
  });
});
