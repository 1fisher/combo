import ReactMarkdown from 'react-markdown';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
}
