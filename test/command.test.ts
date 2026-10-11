import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createSession } from "@/auth/session";
import { handleCommand } from "@/lib/command";
import { getClient, getDb } from "@/lib/db";

// The shared route pipeline, driven as a route handler would: a signed session cookie and a JSON body.

let token = "";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: token }) }) }));

beforeAll(() => {
  process.env.MONGODB_URI = inject("mongoUri");
  process.env.MONGODB_DB = `t_cmd_${process.pid}_${Date.now()}`;
});
afterAll(async () => {
  await (await getDb()).dropDatabase();
  await (await getClient()).close();
});

let calls = 0;
const Input = z.object({ commandId: z.string(), n: z.number() });
const post = (name: string, body: unknown) =>
  handleCommand(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), {
    name,
    role: "manager",
    actionClass: "general",
    input: Input,
    run: async (_c, _s, _ctx, input) => ({ n: input.n, call: ++calls }),
  });

describe("commandId reuse", () => {
  it("replays the original result for the same command and body", async () => {
    token = createSession("manager").token;
    const commandId = randomUUID();
    const first = await (await post("demo", { commandId, n: 1 })).json();
    const again = await post("demo", { commandId, n: 1 });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ result: first.result, replayed: true });
  });

  it.each([
    ["a different body", "demo", { n: 2 }, false],
    ["a different command", "other", { n: 1 }, false],
    ["a different session", "demo", { n: 1 }, true],
  ] as const)("refuses %s with 409 COMMAND_ID_REUSED and runs nothing", async (_what, name, body, newSession) => {
    token = createSession("manager").token;
    const commandId = randomUUID();
    await post("demo", { commandId, n: 1 });
    const before = calls;
    if (newSession) token = createSession("manager").token;
    const res = await post(name, { commandId, ...body });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("COMMAND_ID_REUSED");
    expect(calls).toBe(before);
  });
});
