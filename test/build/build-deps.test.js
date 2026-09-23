/*
 * 构建期依赖的守卫测试。
 *
 * 冲着一次真实的「本地构建失败」写的。构建配置里用到的三个包
 * —— `terser`、`webpack-sources`、`glob` —— **从来没写进 package.json**，
 * 它们只是别的包的传递依赖，靠 npm 时代的扁平 node_modules（或 pnpm 早期提升出来的
 * 顶层链接）侥幸能 require 到。一旦 pnpm 重新 link 过 node_modules，这些链接就没了：
 *
 *   [webpack-cli] Failed to load 'webpack.config.js' config
 *   [webpack-cli] Error: Cannot find module 'webpack-sources'
 *       at src/build/add-build-id-to-output-plugin.js:1:19
 *
 * 更阴的是 terser：它不会让构建失败，只是 `isMinifierAvailable()` 悄悄变 false，
 * 于是预编译脚本不再压缩（实测索引大了 24%，而且编译后的逻辑更易读），
 * 只在构建日志里留一句容易被忽略的 `Module not found: Error: Can't resolve 'terser'`。
 *
 * 所以这里静态扫一遍：构建配置直接 require 的每个裸包名，都必须
 *   1) 在 package.json 的 dependencies/devDependencies 里声明，
 *   2) 且从真正 require 它的那个文件所在目录能解析到。
 */
import fs from 'fs';
import path from 'path';
import {builtinModules} from 'module';

const ROOT = path.resolve(__dirname, '..', '..');

/** 构建期真正会被 Node 直接加载的入口 */
const ENTRIES = ['webpack.config.js', 'babel.config.js'];

const collectFiles = () => {
  const files = [];
  for (const entry of ENTRIES) {
    if (fs.existsSync(path.join(ROOT, entry))) files.push(entry);
  }
  // src/build 下的脚本会被配置文件 require（例如 add-build-id-to-output-plugin、
  // generate-scaffolding-build-id），它们的依赖同样必须是真依赖
  const walk = (dir) => {
    for (const item of fs.readdirSync(path.join(ROOT, dir), {withFileTypes: true})) {
      const rel = path.posix.join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name !== 'node_modules') walk(rel);
      } else if (/\.js$/.test(item.name)) {
        files.push(rel);
      }
    }
  };
  walk('src/build');
  return files;
};

const SPECIFIER = /(?:require\(|from\s+|import\()\s*['"]([^'"]+)['"]/g;

const bareSpecifiers = (text) => {
  const found = new Set();
  let match = SPECIFIER.exec(text);
  while (match) {
    found.add(match[1]);
    match = SPECIFIER.exec(text);
  }
  SPECIFIER.lastIndex = 0;
  return found;
};

const packageNameOf = (spec) => {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

test('构建配置直接 require 的包都必须在 package.json 里声明且可解析', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {})
  ]);

  const problems = [];
  for (const file of collectFiles()) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const fromDir = path.dirname(path.join(ROOT, file));
    for (const spec of bareSpecifiers(text)) {
      const name = packageNameOf(spec);
      if (!name || builtinModules.includes(name)) continue;

      if (!declared.has(name)) {
        problems.push(`${file} 里 require('${spec}')，但 package.json 没声明 ${name}`);
        continue;
      }
      try {
        require.resolve(spec, {paths: [fromDir]});
      } catch (e) {
        problems.push(`${file} 里 require('${spec}') 解析不到（顶层 node_modules 没有它）`);
      }
    }
  }

  // 把所有问题一次列出来，别让人修一个跑一次
  expect(problems).toEqual([]);
});

test('terser 必须是真的依赖（不是靠传递依赖侥幸可解析）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // 打包期压缩靠它；放在 dependencies 里是因为发布的 Node 包里它是外部依赖
  expect(pkg.dependencies).toHaveProperty('terser');
});
