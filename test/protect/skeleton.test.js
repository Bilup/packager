import {stripProjectBlocks} from '../../src/packager/protect/skeleton';
import {FORMAT_VERSION} from '../../src/protect/index-format';

/**
 * 造一个最小工程：
 *   Sprite1
 *     top1（已编译）   event_whenflagclicked -> motion_movesteps(10)
 *       其中 motion_movesteps 的 STEPS 输入指向 shadow 积木 s1
 *     top2（未编译）   event_whenflagclicked -> say "hi"
 *
 * 期望：top1 只留下帽子本身 + shadow（s1），逻辑积木被删掉、next 被断开；
 *       top2 整棵树保留，运行时继续走解释器。
 */
const sampleProject = () => ({
  targets: [
    {
      name: 'Stage',
      isStage: true,
      blocks: {}
    },
    {
      name: 'Sprite1',
      isStage: false,
      blocks: {
        top1: {
          opcode: 'event_whenflagclicked',
          next: 'b1',
          parent: null,
          inputs: {},
          fields: {},
          shadow: false,
          topLevel: true
        },
        b1: {
          opcode: 'motion_movesteps',
          next: 'b2',
          parent: 'top1',
          inputs: {STEPS: [1, [4, '10'], 's1']},
          fields: {},
          shadow: false,
          topLevel: false
        },
        s1: {
          opcode: 'math_number',
          next: null,
          parent: 'b1',
          inputs: {},
          fields: {NUM: ['10', null]},
          shadow: true,
          topLevel: false
        },
        b2: {
          opcode: 'looks_say',
          next: null,
          parent: 'b1',
          inputs: {},
          fields: {MESSAGE: ['hello', null]},
          shadow: false,
          topLevel: false
        },
        top2: {
          opcode: 'event_whenflagclicked',
          next: 'b3',
          parent: null,
          inputs: {},
          fields: {},
          shadow: false,
          topLevel: true
        },
        b3: {
          opcode: 'looks_say',
          next: null,
          parent: 'top2',
          inputs: {MESSAGE: [1, [10, 'hi']]},
          fields: {},
          shadow: false,
          topLevel: false
        }
      }
    }
  ]
});

const indexFor = (topBlockIds) => ({
  v: FORMAT_VERSION,
  t: [
    {
      n: 'Sprite1',
      st: 0,
      s: Object.fromEntries(topBlockIds.map((id) => [id, {e: 'src', h: true}]))
    }
  ]
});

const NO_COMPILE_INDEX = {
  v: FORMAT_VERSION,
  t: []
};

test('已编译脚本只保留帽子与 shadow，未编译脚本整棵保留', () => {
  const project = sampleProject();
  const {stats} = stripProjectBlocks(project, indexFor(['top1']));
  const blocks = project.targets[1].blocks;

  // 已编译：只留下帽子本身（它有 next 指向逻辑，但 next 会被断开）
  expect(blocks.top1.opcode).toBe('event_whenflagclicked');
  expect(blocks.top1.next).toBe(null);
  // 逻辑积木（含挂在它们下面的 shadow）全部消失
  expect(blocks.b1).toBeUndefined();
  expect(blocks.b2).toBeUndefined();
  expect(blocks.s1).toBeUndefined();

  // 未编译：整棵树都在
  expect(blocks.b3.opcode).toBe('looks_say');
  expect(Object.keys(blocks).sort()).toEqual(['b3', 'top1', 'top2']);

  expect(stats.strippedScripts).toBe(1);
  expect(stats.keptScripts).toBe(1);
  expect(stats.keptTargets).toEqual(['Sprite1']);
});

test('帽子自己引用的 shadow 会被保留（procedures_definition 的 custom_block 是典型场景）', () => {
  const project = {
    targets: [{
      name: 'Sprite1',
      isStage: false,
      blocks: {
        def: {
          opcode: 'procedures_definition',
          next: 'body',
          parent: null,
          inputs: {custom_block: [1, 'proto']},
          fields: {},
          shadow: false,
          topLevel: true
        },
        proto: {
          opcode: 'procedures_prototype',
          next: null,
          parent: 'def',
          inputs: {arg0: [1, 'argShadow']},
          fields: {},
          shadow: true,
          topLevel: false,
          mutation: {proccode: 'foo %s', argumentids: '["arg0"]', argumentnames: '["x"]'}
        },
        argShadow: {
          opcode: 'text',
          next: null,
          parent: 'proto',
          inputs: {},
          fields: {TEXT: ['', null]},
          shadow: true,
          topLevel: false
        },
        body: {
          opcode: 'looks_say',
          next: null,
          parent: 'def',
          inputs: {},
          fields: {MESSAGE: ['hi', null]},
          shadow: false,
          topLevel: false
        }
      }
    }]
  };

  stripProjectBlocks(project, indexFor(['def']));
  const blocks = project.targets[0].blocks;
  // 帽子 + 它引用的 shadow 链都留下，mutation 完好
  expect(Object.keys(blocks).sort()).toEqual(['argShadow', 'def', 'proto']);
  expect(blocks.def.inputs.custom_block).toEqual([1, 'proto']);
  expect(blocks.proto.mutation.proccode).toBe('foo %s');
  // 过程体（真正的逻辑）被摘掉
  expect(blocks.body).toBeUndefined();
});

test('指向已删除积木的 next 会被断开，避免悬空引用', () => {
  const project = sampleProject();
  stripProjectBlocks(project, indexFor(['top1']));
  expect(project.targets[1].blocks.top1.next).toBe(null);
});

test('保留块里指向已删除积木的输入会被剪掉，避免反序列化出错', () => {
  const project = sampleProject();
  // 给「已编译脚本」的帽子挂一个指向逻辑积木的输入（真实工程里不会出现，纯防御性场景）
  project.targets[1].blocks.top1.inputs = {SOMETHING: [3, 'b1', [10, 'hi']]};
  stripProjectBlocks(project, indexFor(['top1']));
  expect(project.targets[1].blocks.top1.inputs.SOMETHING).toEqual([]);
});

test('整个目标都没编译成功时原样保留', () => {
  const project = sampleProject();
  const before = JSON.stringify(project.targets[1].blocks);
  const {stats} = stripProjectBlocks(project, NO_COMPILE_INDEX);
  expect(JSON.stringify(project.targets[1].blocks)).toBe(before);
  expect(stats.keptTargets).toEqual(['Sprite1']);
  expect(stats.strippedScripts).toBe(0);
});

test('角色名对不上时不做任何改动', () => {
  const project = sampleProject();
  const before = JSON.stringify(project.targets[1].blocks);
  stripProjectBlocks(project, {
    v: FORMAT_VERSION,
    t: [{n: 'NotHere', st: 0, s: {top1: {e: 'src', h: true}}}]
  });
  expect(JSON.stringify(project.targets[1].blocks)).toBe(before);
});

test('索引按角色名匹配（isStage 只在运行时注入阶段校验），这里锁定该行为', () => {
  const project = sampleProject();
  const index = {
    v: FORMAT_VERSION,
    // st 故意写成 1（舞台），列表里是角色：当前实现仍按名字匹配上
    t: [{n: 'Sprite1', st: 1, s: {top1: {e: 'src', h: true}}}]
  };
  stripProjectBlocks(project, index);
  expect(project.targets[1].blocks.b1).toBeUndefined();
  expect(project.targets[1].blocks.top1.opcode).toBe('event_whenflagclicked');
});

test('没有 blocks 字段的目标会被跳过而不是抛错', () => {
  const project = {targets: [{name: 'Sprite1', isStage: false}]};
  expect(() => stripProjectBlocks(project, indexFor(['top1']))).not.toThrow();
});

test('blocks 为空对象时也能安全处理', () => {
  const project = {targets: [{name: 'Sprite1', isStage: false, blocks: {}}]};
  const {stats} = stripProjectBlocks(project, indexFor(['top1']));
  expect(stats.strippedScripts).toBe(0);
  expect(stats.keptTargets).toEqual([]);
});
