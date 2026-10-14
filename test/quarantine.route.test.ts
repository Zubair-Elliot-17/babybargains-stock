import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createSession } from "@/auth/session";
import { cols } from "@/domain/collections";
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
const recall = (code: string, ip?: string) =>
  POST(new Request("http://x/api/quarantine", { method: "POST", headers: ip ? { "x-real-ip": ip } : {}, body: JSON.stringify({ commandId: randomUUID(), batchCode: code, confirmCode: code }) }));

it("refuses UNBATCHED with 400 without spending the session's recall budget", async () => {
  token = createSession("manager").token;
  const refused = await recall("unbatched");
  expect(refused.status).toBe(400);
  expect((await refused.json()).error.code).toBe("UNBATCHED_RECALL");
  const real = await recall("B-1");
  expect(real.status).toBe(200);
  expect((await real.json()).result).toMatchObject({ batchCode: "B-1", alreadyRecalled: false });
});

it("caps recalls per client IP, so fresh demo sessions can't reset the limit", async () => {
  const fromIp = async (ip: string) => {
    token = createSession("manager").token; // a new session each time
    return (await recall("B-404", ip)).status; // unknown batch still spends budget, recalls nothing
  };
  expect([await fromIp("203.0.113.7"), await fromIp("203.0.113.7"), await fromIp("203.0.113.7")]).toEqual([404, 404, 404]);
  expect(await fromIp("203.0.113.7")).toBe(429);
  expect(await fromIp("203.0.113.8")).toBe(404);
  const stored = await cols(await getDb()).rateLimits.find({ _id: { $regex: /^ip:/ } }).toArray();
  expect(stored).toHaveLength(2);
  expect(JSON.stringify(stored)).not.toContain("203.0.113"); // hashed, never the raw IP
});
