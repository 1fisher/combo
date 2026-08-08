import { Markdown } from '../agent/markdown';

/**
 * Markdown 文件渲染预览:复用聊天 Markdown 渲染器,采用文档级排版。
 */
export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="h-full overflow-y-auto">
      <article className="mx-auto max-w-3xl px-8 py-8">
        <Markdown text={content} variant="document" />
      </article>
    </div>
  );
}
