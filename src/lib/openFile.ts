import { getFileContent } from './api';
import { useEditorStore } from '../stores/editorStore';

/**
 * 对话即导航:把对话中出现的文件路径交给编辑器打开。
 * 工具输入里的 path 通常是相对工作区根目录的路径。
 */
export async function openFileInEditor(workspaceId: string, path: string): Promise<void> {
  const rel = path.replace(/^\.\//, '').replace(/^\/+/, '');
  const name = rel.split('/').pop() ?? rel;
  try {
    const { content } = await getFileContent(workspaceId, rel);
    useEditorStore.getState().openFile(rel, name, content);
  } catch (e) {
    console.error('打开文件失败', e);
  }
}
