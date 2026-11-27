import {writable} from 'svelte/store';

export const error = writable(null);

export const progress = writable({
  progress: 0,
  visible: false,
  text: ''
});
progress.reset = () => {
  progress.set({
    progress: 0,
    visible: false,
    text: ''
  });
};

export const currentTask = writable(null);

/**
 * 打包期预编译的警告。
 *
 * 预编译失败是静默降级（产物照样能开，只是没保护），必须让用户看见，
 * 否则他勾了「预编译脚本 / 移除项目数据」却拿到一个没保护的包。
 * 元素形如 {message: string}：message 是技术诊断信息，界面另给一条 i18n 标题。
 */
export const precompileWarnings = writable([]);
precompileWarnings.reset = () => precompileWarnings.set([]);

/**
 * 打包期素材体检的警告。
 *
 * 素材在产物里缺失是静默的（运行时造型变成灰色问号），用户只会看到「素材丢了」，
 * 所以打包器会在结束时核对一遍并在这里列出来。和 precompileWarnings 分开：
 * 素材缺失不是「没受到保护」，混在一起会让界面打出错误的标题。
 */
export const assetWarnings = writable([]);
assetWarnings.reset = () => assetWarnings.set([]);

currentTask.replace = (newTask) => {
  currentTask.update((old) => {
    if (old) {
      old.abort();
    }
    return newTask;
  });
};
currentTask.abort = () => {
  currentTask.update((old) => {
    if (old) {
      old.abort();
      progress.reset();
    }
    return null;
  });
};

const POSSIBLE_THEMES = [
  'system',
  'dark',
  'light'
];
const THEME_KEY = 'P4.theme';
export const theme = writable('system');
try {
  const storedTheme = localStorage.getItem(THEME_KEY);
  if (POSSIBLE_THEMES.includes(storedTheme)) {
    theme.set(storedTheme);
  }
} catch (e) {
  // Ignore
}
theme.subscribe((value) => {
  try {
    if (value === 'system') {
      localStorage.removeItem(THEME_KEY);
    } else {
      localStorage.setItem(THEME_KEY, value);
    }
  } catch (e) {
    // ignore
  }
});
