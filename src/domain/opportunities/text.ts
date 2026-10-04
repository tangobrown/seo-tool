/**
 * Guard for LLM-written recommendation text (§9.6: never a source of numbers). Every number in the
 * rewritten text must already appear in the template text or the evidence; otherwise we keep the
 * template wording.
 */
export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));
}

export function onlyKnownNumbers(rewritten: string[], source: string[]): boolean {
  const known = new Set(source.flatMap(numbersIn));
  return rewritten.flatMap(numbersIn).every((n) => known.has(n));
}
