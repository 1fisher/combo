import { useLayoutEffect, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  FileText,
  Loader2,
  Paperclip,
  Plus,
  Quote,
  Search,
  ShieldAlert,
  Sparkles,
  Square,
  X,
  Zap,
} from 'lucide-react';
import { Button } from '../ui/button';
import { useAgentStore, type AgentMode } from '../../stores/agentStore';
import { useContextStore, type ContextItem } from '../../stores/contextStore';
import { useMention, type MentionResult } from '../../hooks/useMention';
import { useFileIndex } from '../../hooks/useFileIndex';
import { useSkills, useWorkspaceDisabledSkills } from '../../hooks/useSkills';
import { useSessions } from '../../hooks/useSessions';
import { useAgentInfo, useProviders, useSetModel, useWorkspaceConfig } from '../../hooks/useAgentModel';
import type { Api } from '../../lib/api/types';
import { cn, usageColor } from '../../lib/utils';
import { AttachmentPicker } from './AttachmentPicker';
import { ProviderLogo } from './ProviderLogo';
import { FlameWrap } from '../canvasui/FlameWrap';
import { DEFAULT_CONTEXT_WINDOW, formatTokenCount, getContextUsage, getRealUsage } from '../../lib/tokens';

/** 输入框的火焰特效参数(canvas-ui FlameWrap,参考组件默认值按输入框尺寸微调) */
const FLAME_OPTIONS = {
  color: [0.35, 0.55, 1] as [number, number, number],
  intensity: 0.8,
  height: 48,
  spread: 10,
  radius: 16,
  speed: 0.3,
  scale: 0.8,
  turbulence: 0.5,
  turbulenceScale: 0.5,
  turbulenceReach: 25,
  sparks: 1.2,
  sparkSize: 0.3,
  sparkDensity: 0.8,
  sparkSpeed: 0.8,
  rim: 2,
  melt: 3,
  distortion: 6,
  smoke: 0.5,
  ember: 1.5,
  scorch: 0.6,
};

/** 推理进行中给输入框点燃火焰特效;推理结束后保持挂载,heat 逐步衰减到 0,火焰的
 *  真实参数(intensity/sparks/rim/ember/height/color)随之渐变收束、自然熄灭后再卸载
 *  (不突然消失)。level 为热力包络:推理中保底亮度(heat=0 也有小火苗),结束后直接
 *  跟随 heat 衰减到 0。颜色由蓝转红、火焰越高越亮 = token 输出越快。 */
function FlameComposerBox({
  alive,
  running,
  boxH,
  heat,
  children,
}: {
  alive: boolean;
  running?: boolean;
  boxH: number | undefined;
  heat: number;
  children: ReactNode;
}) {
  if (!alive) return <>{children}</>;
  const level = running ? 0.35 + 0.65 * heat : heat;
  return (
    <FlameWrap
      className="w-full"
      style={boxH ? { height: boxH } : undefined}
      {...FLAME_OPTIONS}
      height={Math.round(40 + heat * 100)}
      intensity={FLAME_OPTIONS.intensity * level}
      sparks={FLAME_OPTIONS.sparks * level}
      ember={FLAME_OPTIONS.ember * level}
      rim={FLAME_OPTIONS.rim * level}
      smoke={FLAME_OPTIONS.smoke + (1 - level) * 0.8}
      color={[0.35 + heat * 0.65, 0.55 - heat * 0.3, 1 - heat * 0.8]}
    >
      {children}
    </FlameWrap>
  );
}

const MODES: { id: AgentMode; label: string; desc: string }[] = [
  { id: 'yolo', label: '完全访问', desc: '自动放行全部权限,不弹窗' },
  { id: 'edit', label: '自动编辑', desc: '自动放行写操作,其余确认' },
  { id: 'build', label: '变更前确认', desc: '所有权限均弹窗确认' },
  { id: 'plan', label: '计划模式', desc: '只读模式,不允许变更' },
];

const THOUGHT_LEVELS = [
  { id: 'nothink', label: '无思考' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最高' },
] as const;

const SLASH_COMMANDS = [
  { id: 'clear', label: '/clear', description: '清空当前对话上下文' },
  { id: 'new', label: '/new', description: '开始新的任务' },
  { id: 'summary', label: '/summary', description: '总结当前对话内容' },
  { id: 'review', label: '/review', description: '审查代码变更' },
  { id: 'tests', label: '/tests', description: '运行项目测试' },
];

export function Composer({
  workspaceId,
  value,
  onChange,
  onSend,
  disabled,
  running,
  onStop,
  banner,
}: {
  workspaceName?: string;
  workspaceId?: string;
  value: string;
  onChange: (v: string) => void;
  onSend: (attachments: Api.Attachment[], contextItems: ContextItem[]) => void;
  disabled?: boolean;
  running?: boolean;
  onStop?: () => void;
  /** 渲染在输入框正上方的插槽(如运行中指示器),与输入框同宽边距 */
  banner?: ReactNode;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const agentMode = useAgentStore((s) => s.agentMode);
  const setAgentMode = useAgentStore((s) => s.setAgentMode);
  const mode = MODES.find((m) => m.id === agentMode) ?? MODES[0];
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<Api.Attachment[]>([]);
  const contextItems = useContextStore((s) => s.items);
  const removeContextItem = useContextStore((s) => s.removeItem);
  const clearContextItems = useContextStore((s) => s.clear);
  const [thoughtMenuOpen, setThoughtMenuOpen] = useState(false);

  // agent / model 选择
  const { data: agentInfo } = useAgentInfo(workspaceId);
  const { data: providers } = useProviders(workspaceId);
  const { data: wsConfig } = useWorkspaceConfig(workspaceId);
  const setModel = useSetModel(workspaceId);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelErr, setModelErr] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  // FlameWrap 原生(layoutsubtree)模式下外层 wrapper 无行内内容会塌陷为 0 高,
  // 需用输入框实际高度显式撑开;每帧渲染前同步测量,避免挂载时机导致高度缺失
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxH, setBoxH] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    // 火焰未挂载时跳过测量:输入框打字会触发频繁重渲染,
    // 每次都读 offsetHeight 会强制同步布局(reflow),是中文输入卡顿的来源之一
    if (!flameAlive) return;
    const el = boxRef.current;
    if (el) {
      const h = el.offsetHeight;
      setBoxH((prev) => (prev === h ? prev : h));
    }
  });
  // 火焰热力:按 token 输出速度(文本/思考字符/秒)采样并平滑,0~1。
  // 推理结束不立即熄灭:heat 逐步衰减到 0,火焰参数(高度/颜色/亮度/火星)随之渐变
  // 收束,完全熄灭后由 flameAlive 卸载特效,避免突然消失。
  const [flameHeat, setFlameHeat] = useState(0);
  const [flameAlive, setFlameAlive] = useState(false);
  useEffect(() => {
    if (running) {
      setFlameAlive(true);
      return;
    }
    if (!flameAlive) return;
    // ≈0.83/s 的衰减速率,从满热到熄灭约 1.2s
    const id = window.setInterval(() => {
      setFlameHeat((h) => Math.max(h - 0.05, 0));
    }, 60);
    return () => window.clearInterval(id);
  }, [running, flameAlive]);
  useEffect(() => {
    if (!running && flameAlive && flameHeat === 0) setFlameAlive(false);
  }, [running, flameAlive, flameHeat]);
  useEffect(() => {
    if (!running) return;
    let lastLen = -1;
    let lastTime = performance.now();
    let ema = 0;
    const tick = () => {
      const st = useAgentStore.getState();
      const rt = st.activeSessionId ? st.bySession[st.activeSessionId] : undefined;
      let len = 0;
      for (const m of rt?.messages ?? []) {
        if (!m.streaming) continue;
        for (const p of m.parts) {
          if (p.type === 'text') len += p.data.text.length;
          else if (p.type === 'reasoning') len += p.data.thinking.length;
        }
      }
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      if (lastLen >= 0 && dt > 0) {
        // 120 字符/秒 视为满速(≈峰值 token 输出),EMA 平滑过渡
        const target = Math.min(Math.max((len - lastLen) / dt / 120, 0), 1);
        ema = ema === 0 ? target : ema * 0.7 + target * 0.3;
        setFlameHeat(ema);
      }
      lastLen = len;
    };
    tick();
    const id = window.setInterval(tick, 400);
    return () => window.clearInterval(id);
  }, [running]);
  // 当前模型:优先使用用户手动选中的(持久化),其次从 agent info 获取,否则从 config 加载默认
  const storedModel = useAgentStore((s) =>
    workspaceId ? s.modelSelections[workspaceId] : undefined
  );
  const configModel = wsConfig?.models?.large?.model ?? wsConfig?.models?.small?.model;
  const currentModelId =
    storedModel?.model ?? agentInfo?.model_cfg?.model ?? agentInfo?.model?.id ?? configModel ?? '';

  // 扁平化 provider → model 列表
  const modelList = useMemo(() => {
    if (!providers) return [];
    const out: {
      id: string;
      name: string;
      provider: string;
      providerName: string;
      contextWindow?: number;
    }[] = [];
    for (const p of providers) {
      const pName = p.name ?? p.id;
      const models = Array.isArray(p.models) ? p.models : [];
      for (const m of models) {
        out.push({
          id: m.id ?? '',
          name: m.name ?? m.id ?? '',
          provider: p.id,
          providerName: pName,
          contextWindow: typeof m.context_window === 'number' ? m.context_window : undefined,
        });
      }
    }
    // 按模型编号从大到小排序(如 glm-5.2 排在 glm-5 前面,无编号的排最后)
    const versionOf = (s: string): number => {
      const m = /\d+(?:\.\d+)*/.exec(s);
      return m ? parseFloat(m[0]) : -1;
    };
    const modelVersion = (m: { id: string; name: string }): number => {
      const v = versionOf(m.id);
      return v >= 0 ? v : versionOf(m.name);
    };
    return out.sort((a, b) => modelVersion(b) - modelVersion(a));
  }, [providers]);

  // 当前 provider:优先用户手动选中,其次 agent info,然后按当前模型反查,最后取第一个
  const currentProviderId = useMemo(() => {
    if (storedModel?.provider) return storedModel.provider;
    const fromInfo = agentInfo?.model_cfg?.provider;
    if (fromInfo) return fromInfo;
    if (currentModelId) {
      const hit = modelList.find((m) => m.id === currentModelId);
      if (hit) return hit.provider;
    }
    return providers?.[0]?.id ?? '';
  }, [storedModel, agentInfo, currentModelId, modelList, providers]);

  // 后端模型仅存内存,重启后会回退到默认。当本地有持久化的用户选择且与后端不一致时,
  // 自动把用户选中的模型同步到后端,保证 agent 实际使用正确的模型。
  useEffect(() => {
    if (!workspaceId || !storedModel || !agentInfo || setModel.isPending) return;
    const backendModel = agentInfo.model_cfg?.model;
    const backendProvider = agentInfo.model_cfg?.provider;
    if (storedModel.model !== backendModel || storedModel.provider !== backendProvider) {
      setModel.mutate({ model: { model: storedModel.model, provider: storedModel.provider } });
    }
  }, [workspaceId, storedModel, agentInfo, setModel]);

  const currentProvider = useMemo(
    () => providers?.find((p) => p.id === currentProviderId),
    [providers, currentProviderId]
  );

  // 当前思考强度:优先本地持久化,默认「高」
  const currentThoughtId = storedModel?.reasoningEffort ?? 'high';
  const thought = THOUGHT_LEVELS.find((t) => t.id === currentThoughtId) ?? THOUGHT_LEVELS[1];

  // 手动设置的模型上下文窗口(key = 模型 id,按模型全局生效),优先级最高
  const contextOverrides = useAgentStore((s) => s.contextOverrides);
  // 当前模型的上下文窗口上限:手动设置优先,其次 agent_info(后端按当前模型解析真实值),
  // 再按模型 id 在 provider 列表查,最后用兜底值。
  // 手动值先精确匹配 provider/model(兼容旧版本按 provider 存储的 key),
  // 查不到再按模型 id 全局匹配(同一模型挂多个 provider 时也能命中)。
  const contextWindow = useMemo(() => {
    const exactKey = currentProviderId ? `${currentProviderId}/${currentModelId}` : '';
    const manual =
      (exactKey ? contextOverrides[exactKey] : undefined) ?? contextOverrides[currentModelId];
    if (typeof manual === 'number' && manual > 0) return manual;
    const fromInfo =
      typeof agentInfo?.model?.context_window === 'number'
        ? agentInfo.model.context_window
        : undefined;
    if (fromInfo) return fromInfo;
    const hit = modelList.find((m) => m.id === currentModelId);
    return hit?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  }, [agentInfo, modelList, currentModelId, currentProviderId, contextOverrides]);

  // 活跃会话的消息 → 上下文已用 token(真实 usage 优先,缺失时本地估算)
  const activeRuntime = useAgentStore((s) =>
    s.activeSessionId ? s.bySession[s.activeSessionId] : undefined
  );
  const contextUsed = useMemo(
    () => (activeRuntime ? getContextUsage(activeRuntime.messages) : 0),
    [activeRuntime]
  );
  const contextPct = Math.min(100, Math.round((contextUsed / contextWindow) * 100));
  // 最近一次 run 的真实消耗(rig 原生 usage,run 内全部 completion 调用累计)
  const lastRunTokens = useMemo(() => {
    if (!activeRuntime) return null;
    const u = getRealUsage(activeRuntime.messages);
    return u ? u.totalInput + u.totalOutput : null;
  }, [activeRuntime]);

  // 当前会话的调用次数(assistant 消息数 ≈ API 调用次数)
  const callCount = useMemo(
    () => (activeRuntime ? activeRuntime.messages.filter((m) => m.role === 'assistant').length : 0),
    [activeRuntime],
  );

  // 全部 provider 的模型,按 provider 分组(可跨 provider 直接选模型)
  const modelGroups = useMemo(() => {
    const out: {
      providerId: string;
      providerName: string;
      models: { id: string; name: string }[];
    }[] = [];
    for (const m of modelList) {
      let g = out.find((x) => x.providerId === m.provider);
      if (!g) {
        g = { providerId: m.provider, providerName: m.providerName, models: [] };
        out.push(g);
      }
      g.models.push({ id: m.id, name: m.name });
    }
    return out;
  }, [modelList]);

  // 模型搜索:按模型 id/名称(忽略大小写)过滤,命中后分组内保持原有排序,空组剔除
  const filteredModelGroups = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return modelGroups;
    const out: typeof modelGroups = [];
    for (const g of modelGroups) {
      const models = g.models.filter(
        (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
      );
      if (models.length) out.push({ ...g, models });
    }
    return out;
  }, [modelGroups, modelSearch]);

  function handleModelChange(modelId: string, provider: string) {
    setModelMenuOpen(false);
    setModelErr('');
    if (workspaceId) {
      useAgentStore.getState().setModelSelection(workspaceId, { model: modelId, provider });
    }
    setModel.mutate(
      { model: { model: modelId, provider } },
      {
        onError: (e) => setModelErr(e instanceof Error ? e.message : '切换失败,请稍后重试'),
      }
    );
  }

  function handleThoughtChange(effortId: string) {
    setThoughtMenuOpen(false);
    if (effortId === currentThoughtId) return;
    if (workspaceId) {
      useAgentStore.getState().setModelSelection(workspaceId, {
        model: currentModelId,
        provider: currentProviderId,
        reasoningEffort: effortId,
      });
    }
    setModel.mutate(
      {
        model: {
          model: currentModelId,
          provider: currentProviderId,
          reasoning_effort: effortId,
        },
      },
      {
        onError: (e) => setModelErr(e instanceof Error ? e.message : '切换失败,请稍后重试'),
      }
    );
  }

  // mention popover 定位(基于 textarea 的 fixed 坐标)
  const [popoverPos, setPopoverPos] = useState<{ left: number; bottom: number; width: number } | null>(null);

  // @ 文件提及 / $ 技能提及
  const { mention, activeIndex, setActiveIndex, select: selectMention, handleKey: handleMentionKey } =
    useMention(value, areaRef, onChange);
  const { files: fileIndex } = useFileIndex(workspaceId);
  const { data: skillsData } = useSkills(workspaceId);
  const { disabledSkills } = useWorkspaceDisabledSkills(workspaceId ?? null);
  const { sessions } = useSessions(workspaceId ?? null);

  const mentionResults: MentionResult[] = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    if (mention.type === 'file') {
      return fileIndex
        .filter((f) => f.path.toLowerCase().includes(q))
        .slice(0, 10)
        .map((f) => ({
          id: f.path,
          label: f.name,
          description: f.path,
          insertText: f.path,
          raw: f,
        }));
    }
    if (mention.type === 'skill') {
      // skill(禁用的不出现在候选中)
      return (skillsData ?? [])
        .filter((s) => !disabledSkills.includes(s.name))
        .filter((s) => s.name.toLowerCase().includes(q))
        .slice(0, 10)
        .map((s) => ({
          id: s.dir_name,
          label: s.name,
          description: s.description,
          insertText: s.name,
          raw: s,
        }));
    }
    if (mention.type === 'command') {
      return SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
        .slice(0, 10)
        .map((c) => ({
          id: c.id,
          label: c.label,
          description: c.description,
          insertText: c.id,
        }));
    }
    // conversation: 同工作区其他会话
    return (sessions ?? [])
      .filter((s) => s.title.toLowerCase().includes(q))
      .slice(0, 10)
      .map((s) => ({
        id: s.id,
        label: s.title,
        description: `${s.message_count} 条消息`,
        insertText: s.title,
        raw: s,
      }));
  }, [mention, fileIndex, skillsData, disabledSkills, sessions]);

  function handleMentionSelect(r: MentionResult) {
    const result = selectMention(r);
    if (!result) return;
    // 文件提及:同时添加为附件 chip
    if (mention?.type === 'file') {
      const raw = result.raw as { path: string; name: string; isDir?: boolean } | undefined;
      if (raw) {
        setAttachments((prev) => {
          if (prev.some((a) => a.file_path === raw.path)) return prev;
          return [...prev, { file_path: raw.path, file_name: raw.name }];
        });
      }
    }
  }

  function autosize() {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  // 外部清空 value(如发送后)时重置高度
  useEffect(() => {
    if (!value) {
      const el = areaRef.current;
      if (el) el.style.height = 'auto';
    }
  }, [value]);

  function submit() {
    if (running || disabled || (!value.trim() && attachments.length === 0 && contextItems.length === 0)) return;
    onSend(attachments, contextItems);
    setAttachments([]);
    clearContextItems();
  }

  function handlePick(files: Api.Attachment[]) {
    setAttachments((prev) => {
      const existing = new Set(prev.map((a) => a.file_path));
      const added = files.filter((f) => !existing.has(f.file_path));
      return [...prev, ...added];
    });
    setPickerOpen(false);
  }

  return (
    <div className="w-full shrink-0 px-4 pb-4 pt-12">
      <div className="w-full">
        {banner}
        <div className="w-full shrink-0 rounded-2xl bg-surface shadow-xl/5">
          <form
            className="relative p-0"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <FlameComposerBox alive={flameAlive} running={running} boxH={boxH} heat={flameHeat}>
            <div
              ref={boxRef}
              className="relative flex flex-col gap-3 rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused"
            >
              {/* 附件 chips */}
              {(attachments.length > 0 || contextItems.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {attachments.map((a) => (
                    <span
                      key={a.file_path}
                      className="group/att flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-foreground"
                      title={a.file_path}
                    >
                      <Paperclip className="size-3 shrink-0 text-foreground-subtle" />
                      <span className="min-w-0 max-w-[14rem] truncate font-mono">{a.file_name}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setAttachments((prev) => prev.filter((x) => x.file_path !== a.file_path))
                        }
                        className="rounded p-0.5 text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
                        aria-label={`移除附件 ${a.file_name}`}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  {contextItems.map((item) => (
                    <span
                      key={item.id}
                      className="group/ctx flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-brand/30 bg-brand/5 px-2 py-1 text-xs text-foreground"
                      title={
                        item.type === 'snippet'
                          ? `${item.filePath}:${item.startLine ?? ''}${item.endLine && item.endLine !== item.startLine ? `-${item.endLine}` : ''}`
                          : item.filePath
                      }
                    >
                      {item.type === 'snippet' ? (
                        <Quote className="size-3 shrink-0 text-brand" />
                      ) : (
                        <FileText className="size-3 shrink-0 text-brand" />
                      )}
                      <span className="min-w-0 max-w-[12rem] truncate font-mono">
                        {item.fileName}
                        {item.startLine != null && (
                          <span className="text-foreground-subtle">
                            :{item.startLine}
                            {item.endLine != null && item.endLine !== item.startLine
                              ? `-${item.endLine}`
                              : ''}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeContextItem(item.id)}
                        className="rounded p-0.5 text-foreground-subtlest transition-colors hover:bg-surface-hover hover:text-foreground"
                        aria-label={`移除上下文 ${item.fileName}`}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {/* 输入区 */}
              <div className="relative flex-1">
                <textarea
                  ref={areaRef}
                  rows={1}
                  value={value}
                  onChange={(e) => {
                    onChange(e.target.value);
                    autosize();
                  }}
                  onCompositionStart={() => {
                    composingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    composingRef.current = false;
                  }}
                  onKeyDown={(e) => {
                    // mention 导航优先
                    if (mention && mentionResults.length > 0) {
                      const consumed = handleMentionKey(e, mentionResults.length);
                      if (consumed && ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab')) {
                        handleMentionSelect(mentionResults[activeIndex]);
                        return;
                      }
                      if (consumed) return;
                    }
                    // keyCode 229 表示输入法正在组合中,此时回车用于确认候选词而非发送
                    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current && e.keyCode !== 229) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder="向 combo 提问,@ 提及文件或文件夹,/ 使用命令或子智能体,$ 使用技能,# 关联对话"
                  disabled={disabled}
                  className="min-h-10 w-full max-h-40 resize-none border-0 bg-transparent p-0 text-sm leading-5 text-foreground shadow-none outline-none placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="输入消息"
                />
              </div>
              {/* 工具栏 */}
              <div className="flex items-end gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setPickerOpen(true)}
                    className="shrink-0 gap-1 rounded-lg text-foreground hover:text-foreground"
                    aria-label="添加附件"
                    title="添加附件"
                  >
                    <Plus className="size-4" />
                    <span className="sr-only">添加附件</span>
                  </Button>
                  <button
                    type="button"
                    onClick={() => {
                      setModeMenuOpen((o) => !o);
                      setModelMenuOpen(false);
                    }}
                    className="relative flex h-7 shrink-0 items-center justify-center gap-0 rounded-lg p-0 text-warning hover:bg-surface-hover hover:text-warning"
                    aria-label="切换模式"
                    title="切换模式"
                  >
                    <ShieldAlert className="pointer-events-none size-4 text-warning" />
                    <span className="hidden whitespace-nowrap pl-1 pr-0.5 text-[13px] @xl/composer:inline-flex">
                      {mode.label}
                    </span>
                    <ChevronDown className="pointer-events-none hidden size-3.5 text-foreground-subtle" />
                  </button>
                  {modeMenuOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setModeMenuOpen(false)}
                      />
                      <div className="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                        <div className="px-2 py-1 text-xs font-medium text-foreground-subtlest">
                          Agent 模式
                        </div>
                        {MODES.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              setAgentMode(m.id);
                              setModeMenuOpen(false);
                            }}
                            className={cn(
                              'flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover',
                              m.id === agentMode && 'bg-surface-hover'
                            )}
                          >
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate font-medium">{m.label}</span>
                              <span className="truncate text-[11px] text-foreground-subtle">
                                {m.desc}
                              </span>
                            </span>
                            {m.id === agentMode && (
                              <Check className="size-3.5 shrink-0 text-brand" />
                            )}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {/* 模型选择 */}
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        if (!modelMenuOpen) setModelSearch('');
                        setModelMenuOpen((o) => !o);
                        setThoughtMenuOpen(false);
                      }}
                      className={cn(
                        'flex h-7 w-fit items-center justify-between gap-1 rounded-lg px-1.5 py-1.5 text-[13px] whitespace-nowrap transition-colors hover:bg-surface-hover',
                        currentProvider?.has_api_key
                          ? 'text-foreground-subtle hover:text-foreground'
                          : 'text-warning hover:text-warning'
                      )}
                      aria-label="切换模型"
                      title="切换模型"
                    >
                      {setModel.isPending ? (
                        <Loader2 className="pointer-events-none size-4 animate-spin" />
                      ) : (
                        <ProviderLogo
                          providerId={currentProviderId}
                          name={currentProvider?.name}
                          className="pointer-events-none size-4 shrink-0"
                        />
                      )}
                      <span className="min-w-0 max-w-[8rem] truncate">
                        {currentModelId || '默认模型'}
                      </span>
                      <ChevronDown className="pointer-events-none size-3.5 text-foreground-subtlest" />
                    </button>
                    {modelMenuOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={() => setModelMenuOpen(false)}
                        />
                        <div className="absolute bottom-full right-0 z-50 mb-2 max-h-80 w-72 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                          <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-foreground-subtlest">
                            <span>选择模型</span>
                            {currentModelId && (
                              <span className="truncate text-[11px] text-foreground-subtle">
                                当前: {currentModelId}
                              </span>
                            )}
                          </div>
                          <div className="px-1 pb-1">
                            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1">
                              <Search className="size-3.5 shrink-0 text-foreground-subtlest" />
                              <input
                                value={modelSearch}
                                onChange={(e) => setModelSearch(e.target.value)}
                                placeholder="搜索模型"
                                className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-foreground-subtlest"
                              />
                              {modelSearch && (
                                <button
                                  type="button"
                                  onClick={() => setModelSearch('')}
                                  className="shrink-0 text-foreground-subtlest transition-colors hover:text-foreground"
                                  aria-label="清空搜索"
                                >
                                  <X className="size-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                          {filteredModelGroups.length === 0 ? (
                            <div className="px-2 py-2 text-[13px] text-foreground-subtle">
                              {modelGroups.length === 0
                                ? '暂无可用的模型。可在「设置」中配置 API Key 后拉取模型。'
                                : '未找到匹配的模型。'}
                            </div>
                          ) : (
                            filteredModelGroups.map((g) => (
                              <div key={g.providerId}>
                                <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-foreground-subtlest">
                                  <ProviderLogo
                                    providerId={g.providerId}
                                    name={g.providerName}
                                    className="size-3.5"
                                  />
                                  <span className="truncate">{g.providerName}</span>
                                </div>
                                {g.models.map((m) => {
                                  // 选中态必须同时匹配 provider + 模型 id:不同 provider 下
                                  // 可能存在同名模型(如 deepseek / opencode-zen 都有
                                  // deepseek-v4-flash-free),只比较 id 会全部高亮打勾
                                  const isSelected =
                                    m.id === currentModelId && g.providerId === currentProviderId;
                                  return (
                                    <button
                                      key={`${g.providerId}/${m.id}`}
                                      type="button"
                                      onClick={() => handleModelChange(m.id, g.providerId)}
                                      className={cn(
                                        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover',
                                        isSelected && 'bg-surface-hover'
                                      )}
                                    >
                                      <span className="min-w-0 flex-1 truncate font-medium">
                                        {m.name || m.id}
                                      </span>
                                      {isSelected && (
                                        <Check className="size-3.5 shrink-0 text-brand" />
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            ))
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  {/* 思考等级 */}
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setThoughtMenuOpen((o) => !o);
                        setModelMenuOpen(false);
                      }}
                      className="flex h-7 w-fit items-center justify-between gap-1 rounded-lg px-1.5 py-1.5 text-[13px] whitespace-nowrap transition-colors hover:bg-surface-hover text-foreground-subtle hover:text-foreground"
                      aria-label="思考等级"
                      title="思考等级"
                    >
                      <Brain className="pointer-events-none size-4 text-current" />
                      <span className="whitespace-nowrap">{thought.label}</span>
                      <ChevronDown className="pointer-events-none size-3.5 text-foreground-subtlest" />
                    </button>
                    {thoughtMenuOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={() => setThoughtMenuOpen(false)}
                        />
                        <div className="absolute bottom-full right-0 z-50 mb-2 w-40 rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                          <div className="px-2 py-1 text-xs font-medium text-foreground-subtlest">
                            思考等级
                          </div>
                          {THOUGHT_LEVELS.map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => handleThoughtChange(t.id)}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover',
                                t.id === currentThoughtId && 'bg-surface-hover'
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate font-medium">
                                {t.label}
                              </span>
                              {t.id === currentThoughtId && (
                                <Check className="size-3.5 shrink-0 text-brand" />
                              )}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  {/* 发送 / 停止 */}
                  {running ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      onClick={onStop}
                      className="shrink-0 gap-1 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      aria-label="停止"
                      title="停止"
                    >
                      <Square className="size-3.5 fill-current" />
                      <span className="sr-only">停止</span>
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      size="icon-sm"
                      disabled={(!value.trim() && attachments.length === 0 && contextItems.length === 0) || disabled}
                      className="shrink-0 gap-1 rounded-lg bg-brand text-foreground-inverse hover:bg-brand/80"
                      aria-label="发送"
                      title="发送"
                    >
                      <ArrowUp className="size-4" />
                      <span className="sr-only">发送</span>
                    </Button>
                  )}
                </div>
              </div>
              {/* 上下文窗口用量统计:进度条 + 已用/上限 + 调用次数(颜色随用量从绿渐变到红) */}
              {contextUsed > 0 && (
                <div
                  className="flex items-center gap-2"
                  aria-label="上下文窗口用量"
                  title={`上下文用量:${contextPct}%  ·  调用 ${callCount} 次${
                    lastRunTokens ? `  ·  上轮消耗 ${formatTokenCount(lastRunTokens)} tokens` : ''
                  }`}
                >
                  <div className="h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-hover">
                    <div
                      className="h-full rounded-full transition-[width] duration-500"
                      style={{
                        width: `${contextPct}%`,
                        backgroundColor: usageColor(contextPct / 100),
                      }}
                    />
                  </div>
                  <span
                    className="shrink-0 text-[10px] leading-none tabular-nums"
                    style={{ color: usageColor(contextPct / 100) }}
                  >
                    {formatTokenCount(contextUsed)} / {formatTokenCount(contextWindow)}
                  </span>
                  <span
                    className="shrink-0 text-[10px] leading-none tabular-nums"
                    style={{ color: usageColor(callCount / 100) }}
                    title={`调用次数:${callCount}`}
                  >
                    {callCount} 次
                  </span>
                </div>
              )}
              {modelErr && (
                <p className="px-1 text-xs text-destructive" role="alert">
                  {modelErr}
                </p>
              )}
            </div>
            </FlameComposerBox>
          </form>
        </div>
      </div>
      {mention && mentionResults.length > 0 && createPortal(
        <MentionPopover
          type={mention.type as 'file' | 'skill' | 'command' | 'conversation'}
          results={mentionResults}
          activeIndex={activeIndex}
          setActiveIndex={setActiveIndex}
          onSelect={handleMentionSelect}
          areaRef={areaRef}
          onPositionChange={setPopoverPos}
          popoverPos={popoverPos}
        />,
        document.body,
      )}
      {pickerOpen && workspaceId && (
        <AttachmentPicker
          workspaceId={workspaceId}
          selected={attachments}
          onPick={handlePick}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function MentionPopover({
  type,
  results,
  activeIndex,
  setActiveIndex,
  onSelect,
  areaRef,
  onPositionChange,
  popoverPos,
}: {
  type: 'file' | 'skill' | 'command' | 'conversation';
  results: MentionResult[];
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  onSelect: (r: MentionResult) => void;
  areaRef: React.RefObject<HTMLTextAreaElement | null>;
  onPositionChange: (pos: { left: number; bottom: number; width: number }) => void;
  popoverPos: { left: number; bottom: number; width: number } | null;
}) {
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    function update() {
      const el = areaRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      onPositionChange({ left: rect.left, bottom: window.innerHeight - rect.top + 8, width: rect.width });
    }
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [areaRef, onPositionChange]);

  if (!popoverPos) return null;

  return (
    <div
      className="fixed z-[100] max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl"
      style={{ left: popoverPos.left, bottom: popoverPos.bottom, width: popoverPos.width }}
    >
      <div className="px-2 py-1 text-xs font-medium text-foreground-subtlest">
        {type === 'file' ? '提及文件' : type === 'skill' ? '使用技能' : type === 'command' ? '使用命令' : '关联对话'}
      </div>
      {results.map((r, i) => (
        <button
          key={r.id}
          type="button"
          onMouseEnter={() => setActiveIndex(i)}
          onClick={() => onSelect(r)}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors',
            i === activeIndex ? 'bg-surface-hover' : 'hover:bg-surface-hover',
          )}
        >
          {type === 'file' ? (
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          ) : type === 'skill' ? (
            <Sparkles className="size-3.5 shrink-0 text-brand" />
          ) : type === 'command' ? (
            <Zap className="size-3.5 shrink-0 text-warning" />
          ) : (
            <Brain className="size-3.5 shrink-0 text-foreground-subtle" />
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">{r.label}</span>
            {r.description && (
              <span className="truncate text-[11px] text-foreground-subtle">
                {r.description}
              </span>
            )}
          </span>
          {i === activeIndex && (
            <Check className="size-3.5 shrink-0 text-brand" />
          )}
        </button>
      ))}
    </div>
  );
}
