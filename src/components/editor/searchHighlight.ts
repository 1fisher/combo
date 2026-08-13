import { ViewPlugin, ViewUpdate, Decoration, DecorationSet, EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * 自定义搜索高亮插件:用 Decoration.mark 标记文档中所有匹配位置。
 * 完全独立于 CodeMirror 的 search 扩展状态,不受扩展重配置影响。
 * 文档变化或视口变化时自动重新计算装饰。
 */
export function searchHighlightPlugin(query: string): Extension {
  const q = query.trim();
  if (!q) return [];

  const lowerQ = q.toLowerCase();

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = this.build(u.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const decos = [];
        const text = view.state.doc.toString();
        const lowerText = text.toLowerCase();
        let pos = 0;
        while ((pos = lowerText.indexOf(lowerQ, pos)) !== -1) {
          decos.push(
            Decoration.mark({
              class: 'cm-sidebar-search-match',
            }).range(pos, pos + q.length),
          );
          pos += q.length;
        }
        return Decoration.set(decos, true);
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
