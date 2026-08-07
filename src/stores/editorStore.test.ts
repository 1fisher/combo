import { describe, expect, it } from 'vitest';
import { useEditorStore } from './editorStore';

describe('editorStore', () => {
  it('opens files, tracks dirty state, and marks saved', () => {
    useEditorStore.getState().resetOpenFiles();
    useEditorStore.getState().openFile('src/a.ts', 'a.ts', 'const a = 1;');
    useEditorStore.getState().openFile('src/b.ts', 'b.ts', 'const b = 2;');
    expect(useEditorStore.getState().openFiles).toHaveLength(2);
    expect(useEditorStore.getState().activePath).toBe('src/b.ts');

    // 重复打开已打开的文件只切换激活,不新增
    useEditorStore.getState().openFile('src/a.ts', 'a.ts', 'const a = 1;');
    expect(useEditorStore.getState().openFiles).toHaveLength(2);
    expect(useEditorStore.getState().activePath).toBe('src/a.ts');

    // 编辑产生脏标记
    useEditorStore.getState().setContent('src/a.ts', 'const a = 2;');
    const a = useEditorStore
      .getState()
      .openFiles.find((f) => f.path === 'src/a.ts')!;
    expect(a.dirty).toBe(true);

    // 保存后清脏
    useEditorStore.getState().markSaved('src/a.ts', 'const a = 2;');
    const saved = useEditorStore
      .getState()
      .openFiles.find((f) => f.path === 'src/a.ts')!;
    expect(saved.dirty).toBe(false);

    // 关闭激活文件后落到相邻文件
    useEditorStore.getState().closeFile('src/a.ts');
    expect(useEditorStore.getState().openFiles).toHaveLength(1);
    expect(useEditorStore.getState().activePath).toBe('src/b.ts');

    // 切换项目清空
    useEditorStore.getState().resetOpenFiles();
    expect(useEditorStore.getState().openFiles).toHaveLength(0);
    expect(useEditorStore.getState().activePath).toBeNull();
  });

  it('stores and updates headContent for git gutter', () => {
    useEditorStore.getState().resetOpenFiles();
    useEditorStore.getState().openFile('src/c.ts', 'c.ts', 'const c = 3;');
    const file = useEditorStore.getState().openFiles[0];
    expect(file.headContent).toBeUndefined();

    useEditorStore.getState().setHeadContent('src/c.ts', 'const c = 1;');
    const updated = useEditorStore.getState().openFiles[0];
    expect(updated.headContent).toBe('const c = 1;');

    useEditorStore.getState().setHeadContent('src/c.ts', null);
    const cleared = useEditorStore.getState().openFiles[0];
    expect(cleared.headContent).toBeNull();
  });
});
