import { useEffect, useRef, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    }
    // 任意非修饰键按下即关闭(真正的快捷键处理由全局监听器完成)
    function onKey(e: KeyboardEvent) {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      onCloseRef.current();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onCloseRef.current);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onCloseRef.current);
    };
  }, []);

  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - items.length * 36 - 16);

  return (
    <div
      ref={ref}
      className="fixed z-[100] min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-xl"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          disabled={item.disabled}
          onClick={() => {
            item.onClick();
            onClose();
          }}
          className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {item.icon}
          <span className="flex-1">{item.label}</span>
          <kbd className="ml-auto pl-3 font-mono text-[11px] text-foreground-subtlest">
            ⌥{i + 1}
          </kbd>
        </button>
      ))}
    </div>
  );
}
