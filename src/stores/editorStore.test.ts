import { describe, expect, it } from 'vitest';
import { useEditorStore } from './editorStore';

describe('editorStore diagnostics', () => {
  it('setDiagnostics 记录/覆盖计数,null 删除条目', () => {
    const st = useEditorStore.getState();
    st.setDiagnostics('src/main.rs', { errors: 2, warnings: 1 });
    expect(useEditorStore.getState().diagnostics['src/main.rs']).toEqual({ errors: 2, warnings: 1 });
    st.setDiagnostics('src/main.rs', { errors: 0, warnings: 3 });
    expect(useEditorStore.getState().diagnostics['src/main.rs']).toEqual({ errors: 0, warnings: 3 });
    st.setDiagnostics('src/main.rs', null);
    expect(useEditorStore.getState().diagnostics['src/main.rs']).toBeUndefined();
  });

  it('closeFile 级联清理该文件的诊断计数', () => {
    const st = useEditorStore.getState();
    st.openFile('a.rs', 'a.rs', 'fn a() {}');
    st.openFile('b.ts', 'b.ts', 'let b = 1');
    st.setDiagnostics('a.rs', { errors: 1, warnings: 0 });
    st.setDiagnostics('b.ts', { errors: 0, warnings: 2 });
    useEditorStore.getState().closeFile('a.rs');
    const d = useEditorStore.getState().diagnostics;
    expect(d['a.rs']).toBeUndefined();
    expect(d['b.ts']).toEqual({ errors: 0, warnings: 2 });
  });

  it('resetOpenFiles 清空全部诊断', () => {
    const st = useEditorStore.getState();
    st.openFile('c.py', 'c.py', 'x = 1');
    st.setDiagnostics('c.py', { errors: 5, warnings: 5 });
    useEditorStore.getState().resetOpenFiles();
    expect(useEditorStore.getState().diagnostics).toEqual({});
  });
});
