/**
 * 流式朗读的断句器(纯函数)。
 *
 * 输入尚未成句的文本缓冲,输出完整句子列表与剩余未成句部分。
 * 规则:
 * - 句末标点 `。！？!?…;` 与换行 `\n` 视为句子边界(空白候选不输出);
 * - 代码块围栏(行首 ``` 配对)内内容不朗读、不切句;围栏标记连同内容保留在
 *   rest 中,使围栏状态可跨增量调用重建(rest 必然以 ``` 开头,下一轮重新进入围栏态);
 * - 单句超过 MAX_SENTENCE_CHARS 字符强制切分(防长句无停顿);
 * - 未成句的尾部(含围栏内容)原样返回,等待下一轮增量或 run 结束时的冲刷。
 */

export const MAX_SENTENCE_CHARS = 100;
const SENTENCE_END = /[。！？!?…;.]/;
const FENCE_MARK = '```';

export function splitSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let inFence = false;
  let cur = '';
  let fenceBuf = '';
  let atLineStart = true;
  const emit = (s: string) => {
    if (s.trim()) sentences.push(s);
  };
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (atLineStart && buf.startsWith(FENCE_MARK, i)) {
      inFence = !inFence;
      if (inFence) {
        fenceBuf += FENCE_MARK;
      } else {
        fenceBuf = ''; // 围栏闭合:丢弃围栏内容(永不朗读)
      }
      i += FENCE_MARK.length - 1;
      atLineStart = false;
      continue;
    }
    if (ch === '\n') {
      atLineStart = true;
      if (inFence) {
        fenceBuf += ch;
        continue;
      }
      cur += ch;
      emit(cur);
      cur = '';
      continue;
    }
    atLineStart = false;
    if (inFence) {
      fenceBuf += ch;
      continue;
    }
    cur += ch;
    if (SENTENCE_END.test(ch) || cur.length >= MAX_SENTENCE_CHARS) {
      emit(cur);
      cur = '';
    }
  }
  return { sentences, rest: cur + fenceBuf };
}
