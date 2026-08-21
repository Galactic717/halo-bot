const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** Which of these names is @-mentioned in the text. Case-insensitive, whole word. */
export function mentionedNames(names: string[], text: string): string[] {
  return names.filter((name) => {
    const escaped = name.replace(SPECIAL, '\\$&');
    return new RegExp(`(^|[^\\w@])@${escaped}\\b`, 'i').test(text);
  });
}
