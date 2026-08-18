import { useLayoutEffect, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  FileText,
  History,
  Loader2,
  Mic,
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
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIPreferences } from '../../stores/uiPreferencesStore';
import { useDictation } from '../../hooks/useDictation';
import { appendTranscript } from '../../lib/audio';
import { openMicSettings } from '../../lib/openMicSettings';
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

/**
 * 弹层锚点定位(移动端适配):fixed 弹层相对锚点元素定位,水平方向钳制在视口内
 * (左右各留 8px),避免 w-72 等较宽下拉在窄屏向左溢出被裁剪(如 Composer 模型菜单
 * 移动端偏左显示不全);垂直方向贴合锚点上方 8px。桌面端不启用,沿用 absolute 定位。
 * 默认右对齐锚点右边缘(与 right-0 语义一致),空间不足时钳制进视口。
 */
function useAnchorPopover(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  opts: { width: number; enabled: boolean }
): { left: number; bottom: number } | null {
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !opts.enabled) {
      setPos(null);
      return;
    }
    const el = anchorRef.current;
    if (!el) return;
    function update() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const left = Math.min(Math.max(rect.right - opts.width, 8), Math.max(8, vw - opts.width - 8));
      setPos({ left, bottom: window.innerHeight - rect.top + 8 });
    }
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, anchorRef, opts.width, opts.enabled]);
  return pos;
}

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
  /** 听写预输入镜像层(确认文本实色、推断文本半透明,textarea 文字透明对齐光标) */
  const dictationMirrorRef = useRef<HTMLDivElement>(null);
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
  // 移动端(<768px)弹层用 fixed 定位并钳制在视口内,避免宽菜单向左溢出裁剪
  const isMobile = useIsMobile();
  const modeBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const thoughtBtnRef = useRef<HTMLButtonElement>(null);
  const modePopoverPos = useAnchorPopover(modeMenuOpen, modeBtnRef, { width: 256, enabled: isMobile });
  const modelPopoverPos = useAnchorPopover(modelMenuOpen, modelBtnRef, { width: 288, enabled: isMobile });
  const thoughtPopoverPos = useAnchorPopover(thoughtMenuOpen, thoughtBtnRef, { width: 160, enabled: isMobile });
  const [modelErr, setModelErr] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  // 最近使用的模型(全局记录,持久化),用于菜单顶部快速切换
  const recentModels = useAgentStore((s) => s.recentModels);
  // FlameWrap 原生(layoutsubtree)模式下外层 wrapper 无行内内容会塌陷为 0 高,
  // 需用输入框实际高度显式撑开;每帧渲染前同步测量,避免挂载时机导致高度缺失
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxH, setBoxH] = useState<number | undefined>(undefined);
  // 火焰特效开关(设置 → 通用「输入框火焰特效」,默认开启)
  const flameEnabled = useUIPreferences((s) => s.flameEnabled);
  useLayoutEffect(() => {
    // 火焰未挂载时跳过测量:输入框打字会触发频繁重渲染,
    // 每次都读 offsetHeight 会强制同步布局(reflow),是中文输入卡顿的来源之一
    if (!flameEnabled || !flameAlive) return;
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
    if (!running || !flameEnabled) return;
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
  }, [running, flameEnabled]);
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

  // 模型选择按 workspace 独立(各项目互不联动):本地持久化 + 服务端 sqlite
  // 双份记忆。本地选择与服务端不一致时(如换浏览器/清理 localStorage 后),
  // 以本地为准同步到服务端,保证 agent 实际使用正确的模型。
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

  // 当前模型的上下文窗口上限:全部来自后端 combo-cli 配置——agent_info
  // (后端按当前模型解析真实值,含设置界面写入的手动覆盖)优先,再按模型
  // id 在 provider 列表查,最后用兜底值。前端不再单独存一份覆盖值,
  // 与 compact 压缩预算共用同一来源,避免「显示未满却频繁触发压缩」。
  const contextWindow = useMemo(() => {
    const fromInfo =
      typeof agentInfo?.model?.context_window === 'number'
        ? agentInfo.model.context_window
        : undefined;
    if (fromInfo) return fromInfo;
    const hit = modelList.find((m) => m.id === currentModelId);
    return hit?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  }, [agentInfo, modelList, currentModelId]);

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

  // 最近使用的模型:解析回当前 provider 列表中的条目(已下线的模型不再展示),
  // 同样受搜索过滤,置顶展示方便在常用模型间快速切换
  const recentModelEntries = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    const out: { id: string; name: string; providerId: string; providerName: string }[] = [];
    for (const r of recentModels) {
      const hit = modelList.find((m) => m.id === r.model && m.provider === r.provider);
      if (!hit) continue;
      if (q && !hit.id.toLowerCase().includes(q) && !hit.name.toLowerCase().includes(q)) continue;
      out.push({
        id: hit.id,
        name: hit.name,
        providerId: hit.provider,
        providerName: hit.providerName,
      });
    }
    return out;
  }, [recentModels, modelList, modelSearch]);

  function handleModelChange(modelId: string, provider: string) {
    setModelMenuOpen(false);
    setModelErr('');
    if (workspaceId) {
      useAgentStore.getState().setModelSelection(workspaceId, { model: modelId, provider });
    }
    // 记录最近使用,菜单顶部置顶展示
    useAgentStore.getState().pushRecentModel({ model: modelId, provider });
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

  // 语音听写:识别文本以「预输入」方式实时拼进输入框末尾(类似输入法组合,
  // 不写入受控 value),停止后 final 经 appendTranscript 正式追加;录音中
  // 手动编辑输入框会取消识别
  const dictation = useDictation((text) => {
    onChange(appendTranscript(value, text));
    requestAnimationFrame(() => areaRef.current?.focus());
  });
  // 录音中显示在输入框末尾的预输入文本:已确认(分段固化)部分稳定保留,
  // 推断部分实时修正(说话中不会整段消失);停止后清空,由 onText 追加 final
  const asrPending =
    dictation.state !== 'idle' ? dictation.confirmedText + dictation.partialText : '';

  // 预输入文本变化时同步输入框高度(与用户输入共用同一高度策略)
  useEffect(() => {
    if (asrPending) autosize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asrPending]);

  return (
    <div className="px-4 py-2 w-full shrink-0">
      <div className="w-full">
        {banner}
        <div className="bg-surface shadow-xl/5 rounded-2xl w-full shrink-0">
          <form
            className="relative p-0"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <FlameComposerBox alive={flameEnabled && flameAlive} running={running} boxH={boxH} heat={flameHeat}>
            <div
              ref={boxRef}
              className="relative flex flex-col gap-3 bg-input focus-within:bg-input-focused p-3 border border-input-border hover:border-input-border-hover focus-within:!border-input-border-focused rounded-2xl transition-colors"
            >
              {/* 附件 chips */}
              {(attachments.length > 0 || contextItems.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {attachments.map((a) => (
                    <span
                      key={a.file_path}
                      className="group/att flex items-center gap-1.5 bg-surface px-2 py-1 border border-border rounded-lg min-w-0 max-w-full text-foreground text-xs"
                      title={a.file_path}
                    >
                      <Paperclip className="size-3 text-foreground-subtle shrink-0" />
                      <span className="min-w-0 max-w-[14rem] font-mono truncate">{a.file_name}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setAttachments((prev) => prev.filter((x) => x.file_path !== a.file_path))
                        }
                        className="hover:bg-surface-hover p-0.5 rounded text-foreground-subtlest hover:text-foreground transition-colors"
                        aria-label={`移除附件 ${a.file_name}`}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  {contextItems.map((item) => (
                    <span
                      key={item.id}
                      className="group/ctx flex items-center gap-1.5 bg-brand/5 px-2 py-1 border border-brand/30 rounded-lg min-w-0 max-w-full text-foreground text-xs"
                      title={
                        item.type === 'snippet'
                          ? `${item.filePath}:${item.startLine ?? ''}${item.endLine && item.endLine !== item.startLine ? `-${item.endLine}` : ''}`
                          : item.filePath
                      }
                    >
                      {item.type === 'snippet' ? (
                        <Quote className="size-3 text-brand shrink-0" />
                      ) : (
                        <FileText className="size-3 text-brand shrink-0" />
                      )}
                      <span className="min-w-0 max-w-[12rem] font-mono truncate">
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
                        className="hover:bg-surface-hover p-0.5 rounded text-foreground-subtlest hover:text-foreground transition-colors"
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
                {/* 听写镜像层:确认文本实色、推断文本半透明斜体;textarea 文字透明仅留光标 */}
                {asrPending && (
                  <div
                    ref={dictationMirrorRef}
                    aria-hidden
                    className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-sm leading-5 text-foreground"
                  >
                    {value}
                    {dictation.confirmedText}
                    <span className="italic opacity-60">{dictation.partialText}</span>
                  </div>
                )}
                <textarea
                  ref={areaRef}
                  rows={1}
                  value={value + asrPending}
                  style={
                    asrPending
                      ? { color: 'transparent', caretColor: 'var(--color-foreground)' }
                      : undefined
                  }
                  onScroll={
                    asrPending
                      ? () => {
                          const el = dictationMirrorRef.current;
                          if (el) el.scrollTop = areaRef.current?.scrollTop ?? 0;
                        }
                      : undefined
                  }
                  onChange={(e) => {
                    // 听写进行中手动编辑:放弃当前识别;受控值里拼着预输入尾巴,
                    // 剥离后再写入,避免 pending 文本污染用户输入
                    if (dictation.state !== 'idle') dictation.cancel();
                    const v = e.target.value;
                    if (asrPending) {
                      // 预输入尾巴一定在末尾,移除最后一次出现的位置
                      const idx = v.lastIndexOf(asrPending);
                      onChange(idx >= 0 ? v.slice(0, idx) + v.slice(idx + asrPending.length) : v);
                    } else {
                      onChange(v);
                    }
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
                  placeholder={
                    value || asrPending
                      ? undefined
                      : '向 combo 提问,@ 提及文件或文件夹,/ 使用命令或子智能体,$ 使用技能,# 关联对话'
                  }
                  disabled={disabled}
                  className={`bg-transparent disabled:opacity-50 shadow-none p-0 border-0 outline-none w-full min-h-10 max-h-40 text-foreground placeholder:text-foreground-subtlest text-sm leading-5 resize-none disabled:cursor-not-allowed${
                    asrPending ? ' [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : ''
                  }`}
                  aria-label="输入消息"
                />
              </div>
              {/* 工具栏 */}
              <div className="flex items-end gap-3">
                <div className="flex flex-1 items-center gap-1 min-w-0">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setPickerOpen(true)}
                    className="gap-1 rounded-lg text-foreground hover:text-foreground shrink-0"
                    aria-label="添加附件"
                    title="添加附件"
                  >
                    <Plus className="size-4" />
                    <span className="sr-only">添加附件</span>
                  </Button>
                  <button
                    type="button"
                    ref={modeBtnRef}
                    onClick={() => {
                      setModeMenuOpen((o) => !o);
                      setModelMenuOpen(false);
                    }}
                    className="relative flex justify-center items-center gap-0 hover:bg-surface-hover p-0 rounded-lg h-7 text-warning hover:text-warning shrink-0"
                    aria-label="切换模式"
                    title="切换模式"
                  >
                    <ShieldAlert className="size-4 text-warning pointer-events-none" />
                    <span className="hidden @xl/composer:inline-flex pr-0.5 pl-1 text-[13px] whitespace-nowrap">
                      {mode.label}
                    </span>
                    <ChevronDown className="hidden size-3.5 text-foreground-subtle pointer-events-none" />
                  </button>
                  {modeMenuOpen && (
                    <>
                      <div
                        className="z-40 fixed inset-0"
                        onClick={() => setModeMenuOpen(false)}
                      />
                      <div
                        className={cn(
                          'z-50 bg-popover shadow-xl p-1.5 border border-border rounded-xl w-64',
                          isMobile ? 'fixed' : 'bottom-full left-0 absolute mb-2'
                        )}
                        style={
                          isMobile && modePopoverPos
                            ? { left: modePopoverPos.left, bottom: modePopoverPos.bottom }
                            : undefined
                        }
                      >
                        <div className="px-2 py-1 font-medium text-foreground-subtlest text-xs">
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
                              'flex items-start gap-2 hover:bg-surface-hover px-2 py-1.5 rounded-lg w-full text-[13px] text-left transition-colors',
                              m.id === agentMode && 'bg-surface-hover'
                            )}
                          >
                            <span className="flex flex-col flex-1 min-w-0">
                              <span className="font-medium truncate">{m.label}</span>
                              <span className="text-[11px] text-foreground-subtle truncate">
                                {m.desc}
                              </span>
                            </span>
                            {m.id === agentMode && (
                              <Check className="size-3.5 text-brand shrink-0" />
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
                      ref={modelBtnRef}
                      onClick={() => {
                        if (!modelMenuOpen) setModelSearch('');
                        setModelMenuOpen((o) => !o);
                        setThoughtMenuOpen(false);
                      }}
                      className={cn(
                        'flex justify-between items-center gap-1 hover:bg-surface-hover px-1.5 py-1.5 rounded-lg w-fit h-7 text-[13px] whitespace-nowrap transition-colors',
                        currentProvider?.has_api_key
                          ? 'text-foreground-subtle hover:text-foreground'
                          : 'text-warning hover:text-warning'
                      )}
                      aria-label="切换模型"
                      title="切换模型"
                    >
                      {setModel.isPending ? (
                        <Loader2 className="size-4 animate-spin pointer-events-none" />
                      ) : (
                        <ProviderLogo
                          providerId={currentProviderId}
                          name={currentProvider?.name}
                          className="size-4 pointer-events-none shrink-0"
                        />
                      )}
                      <span className="min-w-0 max-w-[8rem] truncate">
                        {currentModelId || '默认模型'}
                      </span>
                      <ChevronDown className="size-3.5 text-foreground-subtlest pointer-events-none" />
                    </button>
                    {modelMenuOpen && (
                      <>
                        <div
                          className="z-40 fixed inset-0"
                          onClick={() => setModelMenuOpen(false)}
                        />
                        {/* 弹层为 flex 纵向布局:标题 + 搜索框固定顶部,模型列表单独滚动,
                            列表滚动时搜索框保持可见 */}
                        <div
                          className={cn(
                            'z-50 flex flex-col bg-popover shadow-xl p-1.5 border border-border rounded-xl w-72 max-h-80',
                            isMobile ? 'fixed' : 'right-0 bottom-full absolute mb-2'
                          )}
                          style={
                            isMobile && modelPopoverPos
                              ? { left: modelPopoverPos.left, bottom: modelPopoverPos.bottom }
                              : undefined
                          }
                        >
                          <div className="flex justify-between items-center px-2 py-1 font-medium text-foreground-subtlest text-xs">
                            <span>选择模型</span>
                            {currentModelId && (
                              <span className="text-[11px] text-foreground-subtle truncate">
                                当前: {currentModelId}
                              </span>
                            )}
                          </div>
                          <div className="px-1 pb-1">
                            <div className="flex items-center gap-1.5 bg-surface px-2 py-1 border border-border rounded-lg">
                              <Search className="size-3.5 text-foreground-subtlest shrink-0" />
                              <input
                                value={modelSearch}
                                onChange={(e) => setModelSearch(e.target.value)}
                                placeholder="搜索模型"
                                className="bg-transparent outline-none w-full text-[13px] text-foreground placeholder:text-foreground-subtlest"
                              />
                              {modelSearch && (
                                <button
                                  type="button"
                                  onClick={() => setModelSearch('')}
                                  className="text-foreground-subtlest hover:text-foreground transition-colors shrink-0"
                                  aria-label="清空搜索"
                                >
                                  <X className="size-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                          <div data-testid="model-menu-list" className="flex-1 min-h-0 overflow-y-auto">
                            {/* 最近使用的模型置顶,方便在常用模型间快速切换 */}
                            {recentModelEntries.length > 0 && (
                              <div className="pb-1">
                                <div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 font-medium text-[11px] text-foreground-subtlest">
                                  <History className="size-3" />
                                  <span>最近使用</span>
                                </div>
                                {recentModelEntries.map((m) => {
                                  const isSelected =
                                    m.id === currentModelId && m.providerId === currentProviderId;
                                  return (
                                    // 行容器:主体是「切换模型」按钮,右侧附「从最近使用移除」按钮。
                                    // 删除按钮悬停行时显示(触屏无 hover,保持常驻),点击不关闭菜单可连续删除
                                    <div
                                      key={`recent-${m.providerId}/${m.id}`}
                                      className={cn(
                                        'group/recent flex items-center gap-1 hover:bg-surface-hover rounded-lg transition-colors',
                                        isSelected && 'bg-surface-hover'
                                      )}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => handleModelChange(m.id, m.providerId)}
                                        className="flex flex-1 items-center gap-2 px-2 py-1.5 rounded-lg min-w-0 text-[13px] text-left transition-colors"
                                      >
                                        <span className="flex-1 min-w-0 font-medium truncate">
                                          {m.name || m.id}
                                        </span>
                                        {/* 最近使用跨 provider,补充展示 provider 名便于区分同名模型 */}
                                        <span className="max-w-24 text-[11px] text-foreground-subtlest truncate shrink-0">
                                          {m.providerName}
                                        </span>
                                        {isSelected && (
                                          <Check className="size-3.5 text-brand shrink-0" />
                                        )}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          useAgentStore
                                            .getState()
                                            .removeRecentModel({ model: m.id, provider: m.providerId })
                                        }
                                        aria-label={`从最近使用中移除 ${m.name || m.id}(${m.providerName})`}
                                        title="从最近使用中移除"
                                        className="hover:bg-surface opacity-60 md:focus-visible:opacity-100 md:group-hover/recent:opacity-100 md:opacity-0 focus-visible:opacity-100 mr-1 p-1 rounded-md text-foreground-subtlest hover:text-foreground transition-all shrink-0"
                                      >
                                        <X className="size-3" />
                                      </button>
                                    </div>
                                  );
                                })}
                                <div className="mx-2 mt-1 border-border border-t" />
                              </div>
                            )}
                            {filteredModelGroups.length === 0 ? (
                              <div className="px-2 py-2 text-[13px] text-foreground-subtle">
                                {modelGroups.length === 0
                                  ? '暂无可用的模型。可在「设置」中配置 API Key 后拉取模型。'
                                  : '未找到匹配的模型。'}
                              </div>
                            ) : (
                            filteredModelGroups.map((g) => (
                              <div key={g.providerId}>
                                <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 font-medium text-[11px] text-foreground-subtlest">
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
                                        'flex items-center gap-2 hover:bg-surface-hover px-2 py-1.5 rounded-lg w-full text-[13px] text-left transition-colors',
                                        isSelected && 'bg-surface-hover'
                                      )}
                                    >
                                      <span className="flex-1 min-w-0 font-medium truncate">
                                        {m.name || m.id}
                                      </span>
                                      {isSelected && (
                                        <Check className="size-3.5 text-brand shrink-0" />
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            ))
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                  {/* 思考等级 */}
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      ref={thoughtBtnRef}
                      onClick={() => {
                        setThoughtMenuOpen((o) => !o);
                        setModelMenuOpen(false);
                      }}
                      className="flex justify-between items-center gap-1 hover:bg-surface-hover px-1.5 py-1.5 rounded-lg w-fit h-7 text-[13px] text-foreground-subtle hover:text-foreground whitespace-nowrap transition-colors"
                      aria-label="思考等级"
                      title="思考等级"
                    >
                      <Brain className="size-4 text-current pointer-events-none" />
                      <span className="whitespace-nowrap">{thought.label}</span>
                      <ChevronDown className="size-3.5 text-foreground-subtlest pointer-events-none" />
                    </button>
                    {thoughtMenuOpen && (
                      <>
                        <div
                          className="z-40 fixed inset-0"
                          onClick={() => setThoughtMenuOpen(false)}
                        />
                        <div
                          className={cn(
                            'z-50 bg-popover shadow-xl p-1.5 border border-border rounded-xl w-40',
                            isMobile ? 'fixed' : 'right-0 bottom-full absolute mb-2'
                          )}
                          style={
                            isMobile && thoughtPopoverPos
                              ? { left: thoughtPopoverPos.left, bottom: thoughtPopoverPos.bottom }
                              : undefined
                          }
                        >
                          <div className="px-2 py-1 font-medium text-foreground-subtlest text-xs">
                            思考等级
                          </div>
                          {THOUGHT_LEVELS.map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => handleThoughtChange(t.id)}
                              className={cn(
                                'flex items-center gap-2 hover:bg-surface-hover px-2 py-1.5 rounded-lg w-full text-[13px] text-left transition-colors',
                                t.id === currentThoughtId && 'bg-surface-hover'
                              )}
                            >
                              <span className="flex-1 min-w-0 font-medium truncate">
                                {t.label}
                              </span>
                              {t.id === currentThoughtId && (
                                <Check className="size-3.5 text-brand shrink-0" />
                              )}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  {/* 语音输入(本地离线模型:中文 SenseVoice / 英文 Moonshine,分段模拟流式) */}
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={dictation.toggle}
                      disabled={dictation.state === 'transcribing'}
                      className={cn(
                        'rounded-lg shrink-0',
                        dictation.state === 'recording'
                          ? 'text-destructive hover:text-destructive'
                          : 'text-foreground-subtle hover:text-foreground'
                      )}
                      aria-label="语音输入"
                      title={
                        dictation.state === 'recording'
                          ? `停止并完成识别(${dictation.seconds}s)`
                          : dictation.state === 'transcribing'
                            ? '识别中…'
                            : '语音输入'
                      }
                    >
                      {dictation.state === 'transcribing' ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Mic
                          className={cn(
                            'size-4',
                            dictation.state === 'recording' && 'animate-pulse'
                          )}
                        />
                      )}
                      <span className="sr-only">语音输入</span>
                    </Button>
                    {dictation.state === 'recording' && (
                      <span className="flex items-center gap-1 text-[11px] tabular-nums text-destructive shrink-0">
                        <span className="bg-destructive rounded-full size-1.5 animate-pulse" />
                        {dictation.seconds}s
                      </span>
                    )}
                    {dictation.state !== 'idle' && dictation.modelProgress != null && (
                      <span className="text-[11px] tabular-nums text-foreground-subtle shrink-0">
                        模型 {Math.round(dictation.modelProgress * 100)}%
                      </span>
                    )}
                  </div>
                  {/* 发送 / 停止 */}
                  {running ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      onClick={onStop}
                      className="gap-1 bg-destructive hover:bg-destructive/90 rounded-lg text-destructive-foreground shrink-0"
                      aria-label="停止"
                      title="停止"
                    >
                      <Square className="fill-current size-3.5" />
                      <span className="sr-only">停止</span>
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      size="icon-sm"
                      disabled={(!value.trim() && attachments.length === 0 && contextItems.length === 0) || disabled}
                      className="gap-1 bg-brand hover:bg-brand/80 rounded-lg text-foreground-inverse shrink-0"
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
                  <div className="flex-1 bg-surface-hover rounded-full min-w-0 h-0.5 overflow-hidden">
                    <div
                      className="rounded-full h-full transition-[width] duration-500"
                      style={{
                        width: `${contextPct}%`,
                        backgroundColor: usageColor(contextPct / 100),
                      }}
                    />
                  </div>
                  <span
                    className="tabular-nums text-[10px] leading-none shrink-0"
                    style={{ color: usageColor(contextPct / 100) }}
                  >
                    {formatTokenCount(contextUsed)} / {formatTokenCount(contextWindow)}
                  </span>
                  <span
                    className="tabular-nums text-[10px] leading-none shrink-0"
                    style={{ color: usageColor(callCount / 100) }}
                    title={`调用次数:${callCount}`}
                  >
                    {callCount} 次
                  </span>
                </div>
              )}
              {(modelErr || dictation.error) && (
                <div className="flex items-center gap-2 px-1 text-destructive text-xs" role="alert">
                  <span className="min-w-0 flex-1">{modelErr || dictation.error}</span>
                  {!modelErr && dictation.errorAction === 'open-settings' && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void openMicSettings()}
                      className="shrink-0 text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                    >
                      打开权限设置
                    </Button>
                  )}
                </div>
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
      className="z-[100] fixed bg-popover shadow-xl p-1 border border-border rounded-xl max-h-64 overflow-y-auto"
      style={{ left: popoverPos.left, bottom: popoverPos.bottom, width: popoverPos.width }}
    >
      <div className="px-2 py-1 font-medium text-foreground-subtlest text-xs">
        {type === 'file' ? '提及文件' : type === 'skill' ? '使用技能' : type === 'command' ? '使用命令' : '关联对话'}
      </div>
      {results.map((r, i) => (
        <button
          key={r.id}
          type="button"
          onMouseEnter={() => setActiveIndex(i)}
          onClick={() => onSelect(r)}
          className={cn(
            'flex items-center gap-2 px-2 py-1.5 rounded-lg w-full text-[13px] text-left transition-colors',
            i === activeIndex ? 'bg-surface-hover' : 'hover:bg-surface-hover',
          )}
        >
          {type === 'file' ? (
            <FileText className="size-3.5 text-muted-foreground shrink-0" />
          ) : type === 'skill' ? (
            <Sparkles className="size-3.5 text-brand shrink-0" />
          ) : type === 'command' ? (
            <Zap className="size-3.5 text-warning shrink-0" />
          ) : (
            <Brain className="size-3.5 text-foreground-subtle shrink-0" />
          )}
          <span className="flex flex-col flex-1 min-w-0">
            <span className="font-medium truncate">{r.label}</span>
            {r.description && (
              <span className="text-[11px] text-foreground-subtle truncate">
                {r.description}
              </span>
            )}
          </span>
          {i === activeIndex && (
            <Check className="size-3.5 text-brand shrink-0" />
          )}
        </button>
      ))}
    </div>
  );
}
