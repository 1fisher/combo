import { describe, expect, it } from 'vitest';
import {
  SHORTCUT_ACTIONS,
  comboToLabel,
  comboToParts,
  defaultBindings,
  eventToCombo,
  findBindingOwner,
  isEditableTarget,
  isModifierKey,
  resolveShortcut,
  type ShortcutBindings,
} from './shortcuts';

function keyEvent(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

describe('eventToCombo', () => {
  it('⌘/Ctrl+单键 → 小写键名', () => {
    expect(eventToCombo(keyEvent({ key: 'K', metaKey: true }))).toBe('k');
    expect(eventToCombo(keyEvent({ key: 'k', ctrlKey: true }))).toBe('k');
  });

  it('Shift 字母(大写 key)归一化为 ⇧ 前缀 + 小写', () => {
    expect(eventToCombo(keyEvent({ key: 'S', metaKey: true, shiftKey: true }))).toBe('⇧s');
  });

  it('无 ⌘/Ctrl、含 ⌥、纯修饰键均返回 null', () => {
    expect(eventToCombo(keyEvent({ key: 'k' }))).toBeNull();
    expect(eventToCombo(keyEvent({ key: 'k', metaKey: true, altKey: true }))).toBeNull();
    expect(eventToCombo(keyEvent({ key: 'Shift', metaKey: true, shiftKey: true }))).toBeNull();
    expect(eventToCombo(keyEvent({ key: 'Meta', metaKey: true }))).toBeNull();
  });

  it('F 键与方向键保留语义名,多字符普通键(如 Tab)不支持', () => {
    expect(eventToCombo(keyEvent({ key: 'F5', metaKey: true }))).toBe('f5');
    expect(eventToCombo(keyEvent({ key: 'ArrowLeft', metaKey: true }))).toBe('arrowleft');
    expect(eventToCombo(keyEvent({ key: 'Tab', metaKey: true }))).toBeNull();
  });
});

describe('comboToParts / comboToLabel', () => {
  it('渲染 ⌘ 前缀,Shift 拆出 ⇧,单键大写', () => {
    expect(comboToParts('k')).toEqual(['⌘', 'K']);
    expect(comboToParts('⇧s')).toEqual(['⌘', '⇧', 'S']);
    expect(comboToParts('f5')).toEqual(['⌘', 'f5']);
    expect(comboToLabel('⇧s')).toBe('⌘ ⇧ S');
  });

  it('禁用(null/空)渲染为空/「已禁用」', () => {
    expect(comboToParts(null)).toEqual([]);
    expect(comboToLabel(null)).toBe('已禁用');
  });
});

describe('findBindingOwner', () => {
  const bindings = defaultBindings();

  it('定位占用者,排除自身', () => {
    expect(findBindingOwner(bindings, '⇧s')).toBe('view:skills');
    expect(findBindingOwner(bindings, '⇧s', 'view:skills')).toBeNull();
    expect(findBindingOwner(bindings, '⇧z')).toBeNull();
  });
});

describe('resolveShortcut', () => {
  const bindings: ShortcutBindings = defaultBindings();

  it('默认绑定下 ⌘A 分派 automation', () => {
    const e = keyEvent({ key: 'a', metaKey: true });
    expect(resolveShortcut(e, bindings, ['view:automation'])).toBe('view:automation');
  });

  it('defaultPrevented 或编辑区让位时返回 null;豁免动作在编辑区仍触发', () => {
    const editable = document.createElement('input');
    const inInput = { target: editable } as unknown as KeyboardEvent;
    // 编辑区内 ⌘A 让位(与原生全选重叠)
    const ev = keyEvent({ key: 'a', metaKey: true });
    Object.defineProperty(ev, 'target', { value: editable });
    expect(resolveShortcut(ev, bindings, ['view:automation'])).toBeNull();
    // ⌘K 豁免,输入框内也触发
    const evK = keyEvent({ key: 'k', metaKey: true });
    Object.defineProperty(evK, 'target', { value: editable });
    expect(resolveShortcut(evK, bindings, ['view:search'])).toBe('view:search');
    // 已被其他组件处理的按键跳过
    const evSwallow = keyEvent({ key: 'a', metaKey: true });
    evSwallow.preventDefault();
    expect(resolveShortcut(evSwallow, bindings, ['view:automation'])).toBeNull();
    expect(inInput).toBeTruthy(); // 平台 lint:占位引用
  });

  it('候选 id 之外的绑定不匹配', () => {
    const e = keyEvent({ key: 'i', metaKey: true });
    expect(resolveShortcut(e, bindings, ['view:automation'])).toBeNull();
  });
});

describe('杂项', () => {
  it('默认绑定覆盖全部动作,且与 SHORTCUT_ACTIONS 一致', () => {
    const d = defaultBindings();
    expect(Object.keys(d).sort()).toEqual(
      SHORTCUT_ACTIONS.map((a) => a.id).sort(),
    );
  });

  it('isModifierKey / isEditableTarget', () => {
    expect(isModifierKey('Shift')).toBe(true);
    expect(isModifierKey('A')).toBe(false);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
