/**
 * 全局快捷键配置:动作清单 + 组合键(combo)解析/格式化/冲突检测纯函数。
 *
 * combo 规范:与原 WorkspaceSidebar 内 `SHORTCUT_TO_VIEW` 的键约定一致——
 * `'(⇧)?(⌥)?<key>'`,如 `'k'`、`'⇧s'`;⌘/Ctrl 不进入字符串(两平台等价,统一由
 * 修饰键 meta/ctrl 触发)。key 为单字符(小写)或功能键名(`f1`..`f12`、
 * `arrowleft` 等)。`null` 表示该动作快捷键被禁用。
 */

/** 可配置的全局快捷键动作 id(`view:*` 与 SideView 名对齐) */
export type ShortcutAction =
  | 'newTask'
  | 'view:search'
  | 'view:automation'
  | 'view:skills'
  | 'view:mcp'
  | 'view:stats'
  | 'view:graph'
  | 'dictation';

export interface ShortcutActionMeta {
  id: ShortcutAction;
  /** 中文名(快捷键管理视图与帮助对话框共用) */
  label: string;
  /** 补充说明 */
  desc: string;
  /** 默认组合键 */
  defaultCombo: string | null;
  /**
   * 焦点在输入框等可编辑区域时是否仍触发(豁免让位)。
   * 搜索(命令面板惯例 ⌘K)/新建任务/语音输入(本就是输入场景)豁免;
   * 其余(⌘A 全选等与原生行为重叠)让位给原生行为。
   */
  editableExempt: boolean;
}

/** 全局可配置动作清单(顺序即快捷键管理视图的展示顺序) */
export const SHORTCUT_ACTIONS: readonly ShortcutActionMeta[] = [
  {
    id: 'newTask',
    label: '新建任务',
    desc: '在当前项目新建会话',
    defaultCombo: 'n',
    editableExempt: true,
  },
  {
    id: 'view:search',
    label: '搜索',
    desc: '打开搜索视图',
    defaultCombo: 'k',
    editableExempt: true,
  },
  {
    id: 'view:automation',
    label: '自动化',
    desc: '打开自动化视图',
    // 不用 'a'(⌘/Ctrl+A):与编辑器/输入框原生全选冲突,焦点不在可编辑区时会被劫持
    defaultCombo: '⇧a',
    editableExempt: false,
  },
  {
    id: 'view:skills',
    label: '技能',
    desc: '打开技能视图',
    defaultCombo: '⇧s',
    editableExempt: false,
  },
  {
    id: 'view:mcp',
    label: 'MCP 工具',
    desc: '打开 MCP 视图',
    defaultCombo: '⇧m',
    editableExempt: false,
  },
  {
    id: 'view:stats',
    label: '统计',
    desc: '打开用量统计视图',
    defaultCombo: '⇧d',
    editableExempt: false,
  },
  {
    id: 'view:graph',
    label: '知识图谱',
    desc: '打开知识图谱视图',
    defaultCombo: '⇧g',
    editableExempt: false,
  },
  {
    id: 'dictation',
    label: '语音输入',
    desc: '开关听写(输入框场景,编辑区内也可触发)',
    defaultCombo: 'i',
    editableExempt: true,
  },
];

/**
 * 上下文(固定)快捷键:作用域限定在输入框/编辑器内,不做配置。
 * 帮助对话框与快捷键管理视图共用同一份认知。
 */
export const FIXED_SHORTCUTS: readonly { keys: string[]; label: string }[] = [
  { keys: ['Enter'], label: '发送消息' },
  { keys: ['Shift', 'Enter'], label: '消息内换行' },
  { keys: ['⌘', 'Enter'], label: '提交(Git 面板)' },
  { keys: ['⌘', 'F'], label: '文件内搜索(编辑器视图)' },
  { keys: ['⌘', '⇧', 'F'], label: '跨文件内容搜索(编辑器视图)' },
  { keys: ['⌘', 'W'], label: '关闭当前文件(编辑器视图)' },
  { keys: ['⌘', 'S'], label: '保存当前文件(编辑器视图)' },
  { keys: ['⌘', '⌥', '←/→'], label: '切换打开的文件(编辑器视图)' },
];

const ACTION_MAP: ReadonlyMap<ShortcutAction, ShortcutActionMeta> = new Map(
  SHORTCUT_ACTIONS.map((a) => [a.id, a]),
);

export function shortcutAction(id: ShortcutAction): ShortcutActionMeta {
  return ACTION_MAP.get(id)!;
}

/** 绑定表:id → combo(null = 禁用) */
export type ShortcutBindings = Record<ShortcutAction, string | null>;

/** 默认绑定(恢复默认用) */
export function defaultBindings(): ShortcutBindings {
  const out = {} as ShortcutBindings;
  for (const a of SHORTCUT_ACTIONS) out[a.id] = a.defaultCombo;
  return out;
}

/** 是否纯修饰键(修饰键本身不算完整组合,录制时忽略继续等待) */
export function isModifierKey(key: string): boolean {
  return (
    key === 'Shift' || key === 'Meta' || key === 'Control' || key === 'Alt' || key === 'AltGraph'
  );
}

/**
 * 键名归一化:单字符 → 小写;F1..F12 / 方向键等保留语义名(小写);
 * 不支持的键返回 null。
 */
function normalizeKey(key: string): string | null {
  if (key.length === 1) return key.toLowerCase();
  const lower = key.toLowerCase();
  if (/^f\d{1,2}$/.test(lower)) return lower;
  if (lower.startsWith('arrow')) return lower;
  return null;
}

/**
 * KeyboardEvent → combo 字符串;不满足「⌘/Ctrl(±Shift)、无 ⌥」的约束返回 null。
 * (项目全局快捷键统一为 ⌘/Ctrl 前缀;⌥ 组合让位给浏览器/系统)
 */
export function eventToCombo(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}): string | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  if (e.altKey) return null;
  if (isModifierKey(e.key)) return null;
  const key = normalizeKey(e.key);
  if (!key) return null;
  return (e.shiftKey ? '⇧' : '') + key;
}

/** combo → 展示键位序列(['⌘','⇧','S']);禁用返回空数组 */
export function comboToParts(combo: string | null): string[] {
  if (!combo) return [];
  const shift = combo.startsWith('⇧');
  const key = shift ? combo.slice(1) : combo;
  // 单字符键大写展示(F1/F2、方向键等语义名保持原样)
  const display = key.length === 1 ? key.toUpperCase() : key;
  return shift ? ['⌘', '⇧', display] : ['⌘', display];
}

/** combo → 展示文本('⌘ ⇧ S');禁用返回 '已禁用' */
export function comboToLabel(combo: string | null): string {
  const parts = comboToParts(combo);
  return parts.length ? parts.join(' ') : '已禁用';
}

/** 找出占用某 combo 的动作(排除 exclude);无冲突返回 null */
export function findBindingOwner(
  bindings: ShortcutBindings,
  combo: string,
  exclude?: ShortcutAction,
): ShortcutAction | null {
  for (const a of SHORTCUT_ACTIONS) {
    if (a.id === exclude) continue;
    if (bindings[a.id] === combo) return a.id;
  }
  return null;
}

/** 事件目标是否为可编辑元素(输入框/文本域/CodeMirror 等富文本编辑区) */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * 统一分派管线:按键事件在给定候选动作里匹配绑定。
 * 应用两条让位规则:① 已被其他组件处理(defaultPrevented)的按键跳过;
 * ② 焦点在可编辑区域时,未豁免的动作让位给原生行为。
 */
export function resolveShortcut(
  e: KeyboardEvent,
  bindings: ShortcutBindings,
  ids: readonly ShortcutAction[],
): ShortcutAction | null {
  if (e.defaultPrevented) return null;
  const combo = eventToCombo(e);
  if (!combo) return null;
  for (const id of ids) {
    if (bindings[id] === combo) {
      if (isEditableTarget(e.target) && !ACTION_MAP.get(id)!.editableExempt) return null;
      return id;
    }
  }
  return null;
}
