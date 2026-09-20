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
