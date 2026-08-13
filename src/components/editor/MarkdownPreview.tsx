import { Markdown } from '../agent/markdown';

/**
 * Markdown 文件渲染预览:复用聊天 Markdown 渲染器,采用文档级排版。
 * 支持 highlightQuery 高亮关键词。
 */
export function MarkdownPreview({
  content,
  highlightQuery,
}: {
  content: string;
  highlightQuery?: string | null;
}) {
  const q = highlightQuery?.trim();
  if (!q) {
    return (
      <div className="h-full overflow-y-auto">
        <article className="mx-auto max-w-3xl px-8 py-8">
          <Markdown text={content} variant="document" />
        </article>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <article className="mx-auto max-w-3xl px-8 py-8">
        <div ref={(el) => { if (el) highlightDOM(el, q); }}>
          <Markdown text={content} variant="document" />
        </div>
      </article>
    </div>
  );
}

/**
 * 遍历 DOM 文本节点,用 <mark> 包裹匹配关键词。
 */
function highlightDOM(root: HTMLElement, query: string) {
  const lowerQ = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // 跳过 script/style/mark 标签
      const tag = parent.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'mark') {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(lowerQ)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    targets.push(current as Text);
    current = walker.nextNode();
  }

  for (const textNode of targets) {
    const text = textNode.nodeValue!;
    const lower = text.toLowerCase();
    const parent = textNode.parentElement!;
    const frag = document.createDocumentFragment();
    let pos = 0;
    let idx: number;
    while ((idx = lower.indexOf(lowerQ, pos)) !== -1) {
      if (idx > pos) {
        frag.appendChild(document.createTextNode(text.slice(pos, idx)));
      }
      const mark = document.createElement('mark');
      mark.style.cssText = 'background-color: rgba(20, 184, 166, 0.35); color: inherit; border-radius: 2px; padding: 0 1px; outline: 1px solid rgba(20, 184, 166, 0.6);';
      mark.textContent = text.slice(idx, idx + query.length);
      frag.appendChild(mark);
      pos = idx + query.length;
    }
    if (pos < text.length) {
      frag.appendChild(document.createTextNode(text.slice(pos)));
    }
    parent.replaceChild(frag, textNode);
  }
}
