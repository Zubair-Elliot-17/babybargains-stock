import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createSession } from "@/auth/session";
import { getClient, getDb } from "@/lib/db";
import { migrate } from "@/seed/apply";
import { buildWorld } from "./world";

// The recall route driven as Next would call it: a signed manager cookie and a JSON body.

let token = "";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: token }) }) }));

beforeAll(async () => {
  process.env.MONGODB_URI = inject("mongoUri");
  process.env.MONGODB_DB = `t_quarantine_${process.pid}_${Date.now()}`;
  await migrate(await getDb());
  await buildWorld(await getDb());
});
afterAll(async () => {
  await (await getDb()).dropDatabase();
  await (await getClient()).close();
});

const { POST } = await import("@/app/api/quarantine/route");
const recall = (code: string) =>
  POST(new Request("http://x/api/quarantine", { method: "POST", body: JSON.stringify({ commandId: randomUUID(), batchCode: code, confirmCode: code }) }));

it("refuses UNBATCHED with 400 without spending the session's recall budget", async () => {
  token = createSession("manager").token;
  const refused = await recall("unbatched");
  expect(refused.status).toBe(400);
  expect((await refused.json()).error.code).toBe("UNBATCHED_RECALL");
  const real = await recall("B-1");
  expect(real.status).toBe(200);
  expect((await real.json()).result).toMatchObject({ batchCode: "B-1", alreadyRecalled: false });
});
