import { useCallback, useEffect, useState } from 'react';

export type TriggerType = 'file' | 'skill' | 'command' | 'conversation' | null;

export interface MentionState {
  type: TriggerType;
  query: string;
  /** 触发字符在 textarea value 中的起始位置 */
  startIndex: number;
}

export interface MentionResult {
  id: string;
  label: string;
  description?: string;
  /** 选中后插入 textarea 的文本(不含触发字符) */
  insertText: string;
  /** 原始数据,供调用方使用 */
  raw?: unknown;
}

/**
 * 在受控 textarea 中检测 `@`(文件)和 `%`(技能)触发器。
 * 返回当前激活的 mention 状态、候选列表控制权、以及选择后的插入方法。
 */
export function useMention(
  value: string,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  onChange: (v: string) => void,
) {
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // 每次 value 变化时检查光标位置是否处于触发范围内
  const detect = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const pos = el.selectionStart;
    const text = value.slice(0, pos);

    // 从光标往前找最近的 @ / % / / / #,中间不能有空格/换行
    let triggerChar: TriggerType = null;
    let at = -1;
    for (let i = text.length - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === ' ' || ch === '\n' || ch === '\t') break;
      if (ch === '@' && (i === 0 || /[\s\n]/.test(text[i - 1]))) {
        triggerChar = 'file';
        at = i;
        break;
      }
      if (ch === '%' && (i === 0 || /[\s\n]/.test(text[i - 1]))) {
        triggerChar = 'skill';
        at = i;
        break;
      }
      if (ch === '/' && (i === 0 || /[\s\n]/.test(text[i - 1]))) {
        triggerChar = 'command';
        at = i;
        break;
      }
      if (ch === '#' && (i === 0 || /[\s\n]/.test(text[i - 1]))) {
        triggerChar = 'conversation';
        at = i;
        break;
      }
    }

    if (triggerChar && at >= 0) {
      const query = text.slice(at + 1);
      if (query.length <= 64) {
        setMention((prev) => {
          if (prev && prev.type === triggerChar && prev.startIndex === at && prev.query === query) {
            return prev;
          }
          setActiveIndex(0);
          return { type: triggerChar, query, startIndex: at };
        });
        return;
      }
    }
    setMention(null);
  }, [value, textareaRef]);

  useEffect(() => {
    detect();
  }, [detect]);

  // 光标移动(方向键/点击)后重新检测
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    function onSel() {
      detect();
    }
    el.addEventListener('keyup', onSel);
    el.addEventListener('click', onSel);
    return () => {
      el.removeEventListener('keyup', onSel);
      el.removeEventListener('click', onSel);
    };
  }, [textareaRef, detect]);

  const close = useCallback(() => {
    setMention(null);
    setActiveIndex(0);
  }, []);

  /**
   * 选择一个结果:
   * - file 类型: 移除 textarea 中的 `@query` 文本,返回附件信息供调用方添加 chip
   * - skill 类型: 在 textarea 中将 `%query` 替换为 `%skillname `
   * - command 类型: 在 textarea 中将 `/query` 替换为 `/command `
   * - conversation 类型: 在 textarea 中将 `#query` 替换为 `#title `
   * 返回 MentionResult 供调用方决定后续行为。
   */
  const select = useCallback(
    (result: MentionResult): MentionResult | null => {
      const el = textareaRef.current;
      if (!el || !mention) return null;
      const pos = el.selectionStart;

      if (mention.type === 'file') {
        // 移除 @query 文本,不加任何替代文本(chip 会在附件区域展示)
        const newValue = value.slice(0, mention.startIndex) + value.slice(pos);
        onChange(newValue);
        // 延迟设置光标,等 React 更新 DOM
        requestAnimationFrame(() => {
          const el2 = textareaRef.current;
          if (el2) {
            el2.setSelectionRange(mention.startIndex, mention.startIndex);
            el2.focus();
          }
        });
        const ret = { ...result };
        close();
        return ret;
      }

      // skill / command / conversation: 替换为 %name / /name / #name
      const triggerMap: Record<string, string> = {
        skill: '%',
        command: '/',
        conversation: '#',
      };
      const trigger = triggerMap[mention.type ?? 'skill'] ?? '%';
      const insert = `${trigger}${result.insertText} `;
      const newValue = value.slice(0, mention.startIndex) + insert + value.slice(pos);
      onChange(newValue);
      requestAnimationFrame(() => {
        const el2 = textareaRef.current;
        if (el2) {
          const cursor = mention.startIndex + insert.length;
          el2.setSelectionRange(cursor, cursor);
          el2.focus();
        }
      });
      close();
      return result;
    },
    [value, mention, textareaRef, onChange, close],
  );

  /** 键盘导航:ArrowUp/Down/Enter/Escape/Tab,返回 true 表示已消费 */
  const handleKey = useCallback(
    (e: { key: string; shiftKey: boolean; preventDefault: () => void }, resultCount: number): boolean => {
      if (!mention) return false;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % Math.max(resultCount, 1));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + Math.max(resultCount, 1)) % Math.max(resultCount, 1));
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return true;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (resultCount > 0) {
          e.preventDefault();
          return true;
        }
      }
      return false;
    },
    [mention, close],
  );

  return { mention, activeIndex, setActiveIndex, close, select, handleKey };
}
