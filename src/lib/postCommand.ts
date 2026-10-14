export type CommandOutcome<T> =
  | { result: T }
  | { error: string; code?: string; details?: unknown; unknown?: boolean };

// Client side of a command route. The commandId is kept only while the outcome is unknown (no answer, or a
// 5xx): the caller must then lock its form so a retry resends the identical request, which the server
// replays instead of running twice. A definite answer (success or 4xx, which rolls back) gets a new id.
export async function postCommand<T>(url: string, body: object, id: { current: string }): Promise<CommandOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: id.current, ...body }) });
  } catch {
    return { error: "No answer from the server. It may have been saved: send again to check.", unknown: true };
  }
  const data = await res.json().catch(() => null);
  if (res.status >= 500) return { error: "The server had a problem. It may have been saved: send again to check.", unknown: true };
  id.current = crypto.randomUUID();
  if (res.ok) return { result: data?.result as T };
  return { error: data?.error?.message ?? "Couldn't save. Retry", code: data?.error?.code, details: data?.error?.details };
}
