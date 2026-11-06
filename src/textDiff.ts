export interface TextReplace {
  from: number;
  to: number;
  insert: string;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Returns the smallest single replacement that turns `before` into `after`,
 * or null when they are equal. Never splits a UTF-16 surrogate pair.
 */
export function diffText(before: string, after: string): TextReplace | null {
  if (before === after) return null;

  const min = Math.min(before.length, after.length);
  let start = 0;
  while (start < min && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;

  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--;
    endAfter--;
  }
  if (endBefore < before.length && isLowSurrogate(before.charCodeAt(endBefore)) && endBefore > start) {
    endBefore++;
    endAfter++;
  }

  return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}
