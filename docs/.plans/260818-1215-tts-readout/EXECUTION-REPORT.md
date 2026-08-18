# Execution Report: TTS 朗读 agent 回复

> Date: 2026-08-18 13:40
>
> Mode: Batch

## Summary

- **Completed**
- 后端新增 `tts.rs` 模块与 `/v1/speech/*` 四端点(开关/模型/单句 WAV 合成),配置 `[tts] enabled` + `[tts] model` 持久化;前端 `useSpeechOutput` 流式按句朗读 + `TtsSection` 设置开关/模型;AGENTS.md 已更新。
- 全量验证:cargo 288 测试、前端 393 测试、`npm run tsc`、`cargo build` 全绿。
- 用真实 piper 中文模型完成端到端合成冒烟(「你好,这是语音朗读测试。」→ 117,948 字节 WAV / 22050Hz / 约 2.7s),验证 sherpa-onnx `rule_fsts` 加载链路可用。

## Phase Results

- Task 1: TTS 模型枚举 + `[tts]` 配置段 — ✅
  - Implemented:`tts.rs` TtsModel(piper 女/男声、HF 高质量)、`config.rs` TtsConfig/set_tts_enabled/set_tts_model/模板
  - Verification:`cargo test -p combo-cli tts`(2 测试通过)
- Task 2: TTS 合成服务 — ✅
  - Implemented:TtsFiles 查找(onnx+tokens+lexicon+rule_fsts)、f32_to_wav、Synthesizer(sherpa-onnx OfflineTts)、TtsService(下载/加载/切换/合成)
  - Verification:`cargo test -p combo-cli --lib tts::`(3 测试通过)
- Task 3: HTTP 端点 + serve 接线 — ✅
  - Implemented:status/config/model/synthesize 四端点、AppState.tts、router merge、integration test 两处字面量
  - Verification:`cargo test -p combo-cli`(288 全过)
- Task 4: 前端 API 层 — ✅
  - Implemented:client.ts `apiRequestBinary`、types.ts Speech 类型、api/index.ts 四个封装
  - Verification:`npm run tsc`
- Task 5: 断句器 ttsSplit — ✅
  - Implemented:`splitSentences`(中英文标点/换行、代码块过滤且围栏状态跨增量、超长强制切分)
  - Verification:`npx vitest run src/lib/ttsSplit.test.ts`(8 测试通过)
- Task 6: useSpeechOutput hook — ✅
  - Implemented:增量消费/断句/队列播放/打断/run 基线(只读本次增量),挂 AppShellInner
  - Verification:`npx vitest run src/hooks/useSpeechOutput.test.tsx` + `npm run tsc`
- Task 7: 设置界面 TtsSection — ✅
  - Implemented:开关(Switch)+ 模型下拉,关开关经 invalidateQueries 联动 hook 停读
  - Verification:`npm run tsc` + `npm test`(393 全过)
- Task 8: 文档 + 全量验证 — ✅
  - Implemented:AGENTS.md TTS 段落、piper 真实模型冒烟测试(#[ignore])
  - Verification:cargo 288 + tsc + 前端 393 全绿;真实合成 2.7s 音频

## Verification Matrix

- Lint: n/a(项目无独立 lint 步骤;`cargo build -p combo-cli` 0 warnings)
- Type check: pass(`npm run tsc`)
- Tests: pass(`cargo test -p combo-cli` 288;`npm test` 393)
- Build: pass(`cargo build -p combo-cli`)
- Manual QA: 部分完成(真实合成端到端验证通过并已播放;浏览器 UI 交互待用户确认)

## Deviations

- `SENTENCE_END` 增加英文句号 `.`(设计只列中文标点,但英文句子无 `.` 永不切句)。
- 端点测试不建 router:`build_router` 私有且 `Router::oneshot` 需 tower::ServiceExt,改为直接调用 handler。
- hook 基线 effect 增加 runId 守卫(防止 messages 依赖下重复基线化吞掉增量)。
- 测试 mock 实现必须经 `vi.fn(impl)` 构造器传入(test-setup 的 `vi.restoreAllMocks()` 会清掉后设的 `.mockImplementation()`)。
- 冒烟测试保留为 tts.rs 内 `#[ignore]` 测试(需 `/tmp/combo-tts-smoke` 模型,不随常规 CI 运行)。

## Blockers and Resolutions

- 旧版 Combo.app(安装版)常驻 18236 端口,与新 serve 双绑定导致路由被旧二进制遮蔽(无 /v1/speech 路由,回落静态 HTML)。Resolution:退出旧应用后新 serve 接管;`kill` 需用 /bin/kill(pvdan/sh 无 kill 内建)。
- 验证期修复(commit `d8eaec1`):①synthesize 首次调用不加载模型(无 prepare 端点)→ 自动 ensure_ready;②enabled 每请求读磁盘 → 改为 TtsService 运行时内存态(启动时从配置加载)。

## Follow-ups

- 手动试听:运行 `bash scripts/dev-backend.sh`,设置中打开「语音朗读」,向 agent 发消息确认中文朗读与打断行为。
- 模型下载走 GitHub release,国内网络建议设 `HTTP(S)_PROXY`(sherpa-onnx 构建时同理,见 AGENTS.md)。

## Changed Files

- `crates/combo-cli/src/tts.rs`(新)TTS 模型/服务/端点/路由
- `crates/combo-cli/src/config.rs` `[tts]` 配置段与读写
- `crates/combo-cli/src/lib.rs` 模块注册
- `crates/combo-cli/src/serve.rs` AppState.tts + 路由
- `crates/combo-cli/src/asr.rs` Phase::name/err_response 改 pub(crate)
- `crates/combo-cli/tests/combo_cli_serve_integration_test.rs` tts 字段
- `src/lib/api/client.ts` apiRequestBinary
- `src/lib/api/index.ts` speech 封装
- `src/lib/api/types.ts` Speech 类型
- `src/lib/ttsSplit.ts` + `ttsSplit.test.ts`(新)断句器
- `src/hooks/useSpeechOutput.ts` + `useSpeechOutput.test.tsx`(新)朗读 hook
- `src/components/shell/AppShell.tsx` hook 挂载
- `src/components/shell/SettingsDialog.tsx` TtsSection
- `AGENTS.md` TTS 文档
- `docs/.plans/260818-1215-tts-readout/SUMMARY.md` 计划与进度
