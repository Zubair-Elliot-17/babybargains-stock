// Pure, so the browser can check codes from a supplier's delivery note with the server's rule.
export function normaliseBatchCode(raw: string): string {
  return raw.normalize("NFKC").trim().toUpperCase();
}

// Printable label codes only: an invisible or control character would make a lookalike batch a recall misses.
export const BATCH_CODE = /^[A-Z0-9][A-Z0-9 ._/-]{0,39}$/;
