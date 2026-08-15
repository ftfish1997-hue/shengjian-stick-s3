const SUPPLEMENT_CONTEXT_PATTERN = /(吃|服用|补充)([^，。！？；\n]{0,10})芯片/g;

export function cleanTranscript(rawText: string): string {
  const normalized = rawText.replace(/\s+/g, " ").trim();

  // “芯片”和“锌片”同音。只在明确的食用/服用语境中纠正，避免改坏
  // “这个芯片的功耗”之类真实的技术表达。
  return normalized.replace(
    SUPPLEMENT_CONTEXT_PATTERN,
    (_match, verb: string, middle: string) => `${verb}${middle}锌片`,
  );
}
