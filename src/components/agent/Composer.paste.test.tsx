import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Composer } from './Composer';
import { useAgentStore } from '../../stores/agentStore';

// 上传 API 打桩:验证调用参数与返回路径回填
const { uploadMock } = vi.hoisted(() => ({ uploadMock: vi.fn() }));
vi.mock('../../lib/api', () => ({
  listFiles: vi.fn().mockResolvedValue([]),
  uploadAttachment: uploadMock,
}));

// 与粘贴测试无关的 hooks 打桩(同 Composer.test.tsx)
vi.mock('../../hooks/useMention', () => ({
  useMention: () => ({
    mention: null,
    activeIndex: -1,
    setActiveIndex: () => {},
    select: () => undefined,
    handleKey: () => false,
  }),
}));
vi.mock('../../hooks/useFileIndex', () => ({ useFileIndex: () => ({ files: [] }) }));
vi.mock('../../hooks/useSkills', () => ({
  useSkills: () => ({ data: [] }),
  useWorkspaceDisabledSkills: () => ({ disabledSkills: [] }),
}));
vi.mock('../../hooks/useSessions', () => ({
  useSessions: () => ({ sessions: [], create: vi.fn() }),
}));
vi.mock('../../hooks/useDictation', () => ({
  useDictation: () => ({
    state: 'idle',
    seconds: 0,
    confirmedText: '',
    partialText: '',
    modelProgress: null,
    error: '',
    errorAction: null,
    toggle: vi.fn(),
    cancel: vi.fn(),
  }),
}));
vi.mock('../../hooks/useAgentModel', () => ({
  useAgentInfo: () => ({ data: null }),
  useProviders: () => ({ data: [] }),
  useWorkspaceConfig: () => ({ data: null }),
  useSetModel: () => ({ mutate: vi.fn(), isPending: false }),
}));

function Harness({ onSend }: { onSend: (attachments: unknown[]) => void }) {
  const [draft, setDraft] = useState('');
  return (
    <QueryClientProvider client={new QueryClient()}>
      <Composer
        workspaceId="ws-1"
        value={draft}
        onChange={setDraft}
        onSend={(attachments) => onSend(attachments)}
      />
    </QueryClientProvider>
  );
}

function pasteFiles(el: Element, files: File[]) {
  fireEvent.paste(el, { clipboardData: { files } });
}

describe('Composer 粘贴/拖拽附件上传', () => {
  beforeEach(() => {
    uploadMock.mockReset();
    useAgentStore.setState({ modelSelections: {}, recentModels: [] });
    // jsdom 未实现 blob URL(spyOn 会因属性不存在报错),直接定义
    const urlStub = URL as unknown as {
      createObjectURL: (b: Blob) => string;
      revokeObjectURL: (u: string) => void;
    };
    urlStub.createObjectURL = () => 'blob:mock-url';
    urlStub.revokeObjectURL = () => {};
  });

  it('粘贴图片:立即出现上传中 chip,完成后回填路径,发送携带附件', async () => {
    let resolveUpload!: (v: { ok: boolean; path: string; name: string }) => void;
    uploadMock.mockImplementation(
      () =>
        new Promise((r) => {
          resolveUpload = r;
        })
    );
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: '输入消息' });
    pasteFiles(box, [new File(['png-bytes'], '截图.png', { type: 'image/png' })]);

    // 上传中:chip 已出现(file_name),spinner 可见,发送按钮禁用
    expect(screen.getByText('截图.png')).toBeTruthy();
    expect(screen.getByLabelText('上传中')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled
    ).toBe(true);
    // 上传参数:workspace + 文件名 + 原始字节
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    const [ws, name, buf] = uploadMock.mock.calls[0];
    expect(ws).toBe('ws-1');
    expect(name).toBe('截图.png');
    expect(buf).toBeInstanceOf(ArrayBuffer);

    // 完成上传:chip title 变为回填的 workspace 相对路径
    resolveUpload({ ok: true, path: '.combo/uploads/2025-01-01/截图.png', name: '截图.png' });
    await waitFor(() =>
      expect(screen.getByTitle('.combo/uploads/2025-01-01/截图.png')).toBeTruthy()
    );

    // 发送:onSend 收到带 file_path 的附件
    const user = userEvent.setup();
    await user.type(box, '看下这张图');
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
    const atts = onSend.mock.calls[0][0] as {
      file_path: string;
      file_name: string;
      isImage: boolean;
    }[];
    expect(atts).toHaveLength(1);
    expect(atts[0].file_path).toBe('.combo/uploads/2025-01-01/截图.png');
    expect(atts[0].isImage).toBe(true);
  });

  it('上传中回车不发送(回车与发送按钮都被拦截)', async () => {
    uploadMock.mockImplementation(() => new Promise(() => {})); // 永不完成
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: '输入消息' });
    pasteFiles(box, [new File(['x'], 'a.png', { type: 'image/png' })]);
    const user = userEvent.setup();
    await user.type(box, '文字{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('粘贴超过 20MB 的文件:直接失败 chip,不发起上传', () => {
    render(<Harness onSend={() => {}} />);
    const box = screen.getByRole('textbox', { name: '输入消息' });
    const big = new File([new ArrayBuffer(20 * 1024 * 1024 + 1)], 'big.zip', {
      type: 'application/zip',
    });
    pasteFiles(box, [big]);
    expect(screen.getByTitle('big.zip:超过 20MB 上限')).toBeTruthy();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('上传失败:chip 显示错误态,发送时被过滤', async () => {
    uploadMock.mockRejectedValue(new Error('网络错误'));
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: '输入消息' });
    pasteFiles(box, [new File(['x'], 'err.png', { type: 'image/png' })]);
    await waitFor(() => expect(screen.getByTitle('err.png:网络错误')).toBeTruthy());

    const user = userEvent.setup();
    await user.type(box, '继续');
    await user.keyboard('{Enter}');
    // 失败附件被过滤,但文本照常发送
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toHaveLength(0);
  });

  it('纯文本粘贴不受影响(无 files 不拦截)', () => {
    render(<Harness onSend={() => {}} />);
    const box = screen.getByRole('textbox', { name: '输入消息' });
    fireEvent.paste(box, { clipboardData: { files: [], getData: () => '普通文本' } });
    expect(screen.queryByLabelText('上传中')).toBeNull();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('拖拽文件到输入框:悬停提示可见,松开上传为附件', async () => {
    uploadMock.mockResolvedValue({ ok: true, path: '.combo/uploads/drop.txt', name: 'drop.txt' });
    render(<Harness onSend={() => {}} />);
    const box = (screen.getByRole('textbox', { name: '输入消息' }).closest(
      '[class*="bg-input"]'
    ) ?? {}) as HTMLElement;
    expect(box).toBeTruthy();
    fireEvent.dragOver(box, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByText('松开以上传附件')).toBeTruthy();
    fireEvent.drop(box, { dataTransfer: { files: [new File(['hi'], 'drop.txt', { type: 'text/plain' })], types: ['Files'] } });
    await waitFor(() => expect(screen.getByTitle('.combo/uploads/drop.txt')).toBeTruthy());
    expect(screen.queryByText('松开添加 附件')).toBeNull();
  });
});
