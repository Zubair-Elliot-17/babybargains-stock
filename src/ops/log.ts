// One structured JSON line per command; Vercel captures stdout as searchable logs.

export interface CommandLog {
  requestId: string;
  role?: string;
  branchId?: string;
  command: string;
  commandId?: string;
  outcome: "ok" | "replayed" | "rejected" | "error";
  ms: number;
  errorClass?: string;
  errorCode?: string;
}

export function logCommand(entry: CommandLog): void {
  const line = JSON.stringify({ level: entry.outcome === "error" ? "error" : "info", at: new Date().toISOString(), ...entry });
  if (entry.outcome === "error") console.error(line);
  else console.log(line);
}
