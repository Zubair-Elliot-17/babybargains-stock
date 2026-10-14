import { afterEach, describe, expect, it, vi } from "vitest";
import { postCommand } from "@/lib/postCommand";

// The commandId survives only while the outcome is unknown, so a retry can only be an identical resend.
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("postCommand", () => {
  it("keeps the id when no answer arrives or the server fails, and says the outcome is unknown", async () => {
    const id = { current: "a" };
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await postCommand("/x", {}, id)).toMatchObject({ unknown: true });
    vi.stubGlobal("fetch", reply(500, { error: { code: "INTERNAL" } }));
    expect(await postCommand("/x", {}, id)).toMatchObject({ unknown: true });
    expect(id.current).toBe("a");
  });

  it("rotates the id after a definite answer: success, or a 4xx that stored nothing", async () => {
    const id = { current: "a" };
    vi.stubGlobal("fetch", reply(409, { error: { code: "INSUFFICIENT_STOCK", message: "short", details: [{ sku: "S" }] } }));
    expect(await postCommand("/x", {}, id)).toEqual({ error: "short", code: "INSUFFICIENT_STOCK", details: [{ sku: "S" }] });
    expect(id.current).not.toBe("a");
    const second = id.current;
    vi.stubGlobal("fetch", reply(200, { result: { total: 5 } }));
    expect(await postCommand("/x", {}, id)).toEqual({ result: { total: 5 } });
    expect(id.current).not.toBe(second);
  });
});
