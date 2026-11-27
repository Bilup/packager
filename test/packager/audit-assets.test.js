/*
 * 打包期素材体检的回归测试。
 *
 * 冲着「打包后素材丢失，但打包过程一句错都没有」这类问题写的：
 * 素材缺失在运行时的唯一表现是造型变成灰色问号 / 声音变静音，用户拿不到任何线索。
 * 这里锁住三件事：
 *   1. 健康工程必须报「不缺」—— 误报会让这条警告彻底失去意义；
 *   2. 素材真的不在 zip 里时必须报出来，并且带上文件名与所属角色/造型；
 *   3. 子目录里的素材（`this is a subdirectory/xxx.png`）必须算「找得到」——
 *      运行时的查找规则允许一层子目录，体检必须对齐，否则会谎报缺失。
 */
import fs from 'fs';
import path from 'path';
import {
  auditAssets,
  collectReferencedAssets,
  describeAssetAudit,
  isZipBuffer
} from '../../src/packager/audit-assets';

const readTestProject = (name) => {
  const buffer = fs.readFileSync(path.resolve(__dirname, 'projects', name));
  return new Uint8Array(buffer);
};

const getJSZip = async () => (await import('@turbowarp/jszip')).default;

describe('isZipBuffer', () => {
  test('识别 sb3', () => {
    expect(isZipBuffer(readTestProject('comments.sb3'))).toBe(true);
  });

  test('普通文本不是 zip', () => {
    expect(isZipBuffer(readTestProject('invalid.txt'))).toBe(false);
  });

  test('空值不算 zip', () => {
    expect(isZipBuffer(null)).toBe(false);
    expect(isZipBuffer(new Uint8Array(0))).toBe(false);
  });
});

describe('collectReferencedAssets', () => {
  test('造型与声音都按 md5ext 收集', () => {
    const items = collectReferencedAssets({
      targets: [{
        name: 'Sprite1',
        costumes: [
          {name: 'costume1', md5ext: 'aaa.png', assetId: 'aaa', dataFormat: 'png'},
          {name: '只有 assetId', assetId: 'bbb', dataFormat: 'svg'}
        ],
        sounds: [
          {name: 'pop', md5ext: 'ccc.wav', assetId: 'ccc', dataFormat: 'wav'}
        ]
      }]
    });
    expect(items).toEqual([
      {kind: 'costume', target: 'Sprite1', name: 'costume1', file: 'aaa.png'},
      {kind: 'costume', target: 'Sprite1', name: '只有 assetId', file: 'bbb.svg'},
      {kind: 'sound', target: 'Sprite1', name: 'pop', file: 'ccc.wav'}
    ]);
  });

  test('算不出文件名的素材被跳过，不报假缺失', () => {
    expect(collectReferencedAssets({
      targets: [{name: 'Sprite1', costumes: [{name: '空的'}], sounds: []}]
    })).toEqual([]);
  });
});

describe('auditAssets', () => {
  test('健康工程不报缺失', async () => {
    const report = await auditAssets({
      JSZip: await getJSZip(),
      projectBuffer: readTestProject('subdirectory.sb3')
    });
    expect(report.available).toBe(true);
    expect(report.total).toBe(1);
    expect(report.missing).toEqual([]);
    expect(describeAssetAudit(report)).toBe(null);
  });

  test('素材在子目录里也算找得到（与运行时的查找规则对齐）', async () => {
    const JSZip = await getJSZip();
    const report = await auditAssets({
      JSZip,
      projectBuffer: readTestProject('subdirectory.sb3')
    });
    expect(report.missing).toEqual([]);
  });

  test('素材真的不在 zip 里时必须报出来', async () => {
    const JSZip = await getJSZip();
    const source = await JSZip.loadAsync(readTestProject('subdirectory.sb3'));
    // 把素材改名，模拟「工程里引用的文件和压缩包里的对不上」
    const renamed = new JSZip();
    for (const name of Object.keys(source.files)) {
      const entry = source.files[name];
      if (entry.dir) continue;
      const target = name.endsWith('.png')
        ? name.replace('9838d02002d05f88dc54d96494fbc202.png', 'ffffffffffffffffffffffffffffffff.png')
        : name;
      renamed.file(target, await entry.async('uint8array'));
    }
    const buffer = await renamed.generateAsync({type: 'uint8array'});

    const report = await auditAssets({JSZip, projectBuffer: buffer});
    expect(report.available).toBe(true);
    expect(report.missing).toEqual([{
      kind: 'costume',
      target: 'Stage',
      name: 'Xy-grid',
      file: '9838d02002d05f88dc54d96494fbc202.png'
    }]);

    const message = describeAssetAudit(report);
    expect(message).toContain('9838d02002d05f88dc54d96494fbc202.png');
    expect(message).toContain('Xy-grid');
    expect(message).toContain('Stage');
  });

  test('非 zip 工程跳过核对并说明原因', async () => {
    const report = await auditAssets({
      JSZip: await getJSZip(),
      projectBuffer: readTestProject('project.sb')
    });
    expect(report.available).toBe(false);
    expect(report.missing).toEqual([]);
    expect(report.reason).toBeTruthy();
  });

  test('sb2 工程不谎报「核对通过」', async () => {
    const report = await auditAssets({
      JSZip: await getJSZip(),
      projectBuffer: readTestProject('music.sb2')
    });
    expect(report.available).toBe(false);
    expect(report.reason).toContain('Scratch 1/2');
  });
});
