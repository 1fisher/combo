import { useState } from 'react';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';

export function Composer({
  onSend,
  disabled,
}: {
  onSend: (p: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState('');
  function submit() {
    const v = value.trim();
    if (!v || disabled) return;
    onSend(v);
    setValue('');
  }
  return (
    <div className="border-t p-3">
      <div className="flex items-end gap-2">
        <Textarea
          className="min-h-[44px] flex-1 resize-none"
          placeholder={disabled ? '连接中,暂时无法发送…' : '给 agent 下任务,Enter 发送'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button onClick={submit} disabled={disabled || !value.trim()}>
          发送
        </Button>
      </div>
    </div>
  );
}
