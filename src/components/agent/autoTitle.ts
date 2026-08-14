/**
 * 任务名自动命名逻辑:
 * 「新建任务」创建的会话标题是占位符(「会话 N」/「新任务」),没有语义信息。
 * 当用户向这样的会话发送首条需求时,应自动把任务名更新为需求内容
 * (与直接输入发送时创建会话的命名规则一致:前 20 字)。
 * 用户手动重命名过的会话(非占位标题)不会被覆盖。
 */

/** 占位任务名:自动生成的「会话 N」或「新任务」 */
const PLACEHOLDER_TITLE = /^会话\s*\d+$|^新任务$/;

/** 是否为无语义的占位任务名(空标题/纯空白也视为占位) */
export function isPlaceholderTitle(title: string | undefined | null): boolean {
  const t = title?.trim() ?? '';
  if (!t) return true;
  return PLACEHOLDER_TITLE.test(t);
}

/** 由需求文本计算任务名:取前 20 字(去首尾空白),空则回退「新任务」 */
export function titleFromPrompt(prompt: string): string {
  const t = prompt.trim();
  return t.slice(0, 20) || '新任务';
}

/**
 * 判断是否需要自动重命名。
 * 仅当会话仍是占位标题时返回新标题;否则返回 null(不覆盖用户手动命名)。
 */
export function autoTitleFor(
  prompt: string,
  currentTitle: string | undefined | null,
): string | null {
  if (!isPlaceholderTitle(currentTitle)) return null;
  const title = titleFromPrompt(prompt);
  return title === currentTitle ? null : title;
}
