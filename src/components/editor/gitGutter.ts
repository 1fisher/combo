import { StateField, RangeSet, type Extension, type EditorState } from '@codemirror/state';
import { gutter, GutterMarker, EditorView, Decoration, type DecorationSet } from '@codemirror/view';
import { computeLineChanges } from '../../lib/gitDiff';

class AddedMarker extends GutterMarker {
  elementClass = 'cm-gitMarker-added';
}
class ModifiedMarker extends GutterMarker {
  elementClass = 'cm-gitMarker-modified';
}

const addedMarker = new AddedMarker();
const modifiedMarker = new ModifiedMarker();
const addedLineDeco = Decoration.line({ class: 'cm-gitLine-added' });
const modifiedLineDeco = Decoration.line({ class: 'cm-gitLine-modified' });

function buildMarkers(state: EditorState, headContent: string): RangeSet<GutterMarker> {
  const currentContent = state.doc.toString();
  if (headContent === currentContent) return RangeSet.empty;
  const changes = computeLineChanges(headContent, currentContent);
  const markers: ReturnType<typeof addedMarker.range>[] = [];
  const total = state.doc.lines;
  for (const [lineNum, type] of changes) {
    if (lineNum >= 1 && lineNum <= total) {
      const line = state.doc.line(lineNum);
      const marker = type === 'added' ? addedMarker : modifiedMarker;
      markers.push(marker.range(line.from));
    }
  }
  return markers.length > 0 ? RangeSet.of(markers) : RangeSet.empty;
}

function buildDecorations(state: EditorState, headContent: string): DecorationSet {
  const currentContent = state.doc.toString();
  if (headContent === currentContent) return Decoration.none;
  const changes = computeLineChanges(headContent, currentContent);
  const decos: ReturnType<typeof addedLineDeco.range>[] = [];
  const total = state.doc.lines;
  for (const [lineNum, type] of changes) {
    if (lineNum >= 1 && lineNum <= total) {
      const line = state.doc.line(lineNum);
      const deco = type === 'added' ? addedLineDeco : modifiedLineDeco;
      decos.push(deco.range(line.from));
    }
  }
  return decos.length > 0 ? Decoration.set(decos, true) : Decoration.none;
}

/**
 * 创建 git gutter + 行背景着色扩展。
 * headContent 为该文件在 HEAD 的内容;编辑器内容与之比较得出每行的变更状态。
 */
export function createGitGutter(headContent: string): Extension[] {
  const markerField = StateField.define<RangeSet<GutterMarker>>({
    create(state) {
      return buildMarkers(state, headContent);
    },
    update(oldSet, tr) {
      if (!tr.docChanged) return oldSet;
      return buildMarkers(tr.state, headContent);
    },
  });

  const gitGutter = gutter({
    class: 'cm-gitGutter',
    markers: (v) => v.state.field(markerField),
    initialSpacer: () => addedMarker,
  });

  const decoField = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, headContent);
    },
    update(oldDeco, tr) {
      if (!tr.docChanged) return oldDeco;
      return buildDecorations(tr.state, headContent);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const gitTheme = EditorView.baseTheme({
    '.cm-gitGutter': {
      width: '4px',
      borderRight: 'none',
      backgroundColor: 'transparent',
    },
    '.cm-gitGutter .cm-gutterElement': {
      padding: '0',
    },
    '.cm-gitMarker-added': {
      backgroundColor: 'var(--success, #22c55e)',
    },
    '.cm-gitMarker-modified': {
      backgroundColor: 'var(--warning, #eab308)',
    },
    '.cm-gitLine-added': {
      backgroundColor: 'color-mix(in srgb, var(--success, #22c55e) 12%, transparent)',
    },
    '.cm-gitLine-modified': {
      backgroundColor: 'color-mix(in srgb, var(--warning, #eab308) 12%, transparent)',
    },
  });

  return [markerField, gitGutter, decoField, gitTheme];
}
