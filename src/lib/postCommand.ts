// Client side of a command route: one commandId per attempt, kept until it succeeds so a resend never
// runs twice; a reused id (body changed since) gets a fresh one for the next try.
export async function postCommand<T>(url: string, body: object, id: { current: string }): Promise<{ result: T } | { error: string; code?: string; details?: unknown }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: id.current, ...body }) });
    const data = await res.json().catch(() => null);
    if (data?.error?.code === "COMMAND_ID_REUSED") {
      id.current = crypto.randomUUID();
      return { error: "That request was already sent. Try again." };
    }
    if (!res.ok) return { error: data?.error?.message ?? "Couldn't save. Retry", code: data?.error?.code, details: data?.error?.details };
    id.current = crypto.randomUUID();
    return { result: data.result as T };
  } catch {
    return { error: "Couldn't reach the server. Retry" };
  }
}
