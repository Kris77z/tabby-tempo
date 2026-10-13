import { journalDiagnostic, type JournalDiagnostic } from "../../../../scripts/demo-common.js";

export interface GameFiStageDiagnostic { code: string; diagnostic?: JournalDiagnostic }
/** The existing CLIs emit fixed codes plus a diagnostic whitelist. Discard every other stderr line. */
export function parseGameFiStageDiagnostic(stderr: string): GameFiStageDiagnostic | undefined {
  let code: string | undefined, diagnostic: JournalDiagnostic | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    if (!code && /^[A-Z][A-Z0-9_]{2,100}$/.test(line) && line.includes("_")) code = line;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && value.diagnostic) {
        const safe = journalDiagnostic(value);
        if (Object.keys(safe).length) diagnostic = safe;
      }
    } catch { /* Raw errors, URLs and signed material are never forwarded or persisted. */ }
  }
  return code ? { code, ...(diagnostic ? { diagnostic } : {}) } : undefined;
}
