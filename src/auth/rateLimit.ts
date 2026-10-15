import type { Db } from "mongodb";
import { cols } from "@/domain/collections";
import { RateLimited } from "@/domain/errors";

// Per-session hourly budgets by action class (count lines need far more than other writes).
export const BUDGETS = { general: 60, count: 600, quarantine: 1, catalogue: 10 } as const;
export type ActionClass = keyof typeof BUDGETS;
// Per-client-IP hourly budgets, so minting new demo sessions can't reset these limits.
export const IP_BUDGETS: Partial<Record<ActionClass, number>> = { quarantine: 3, catalogue: 5 }; // catalogue: renames the shared demo

const HOUR = 3_600_000;

export async function consume(db: Db, sid: string, actionClass: ActionClass, now = Date.now()): Promise<void> {
  await spend(db, `${sid}:${actionClass}`, BUDGETS[actionClass], now);
}

// ipKey: hashed client IP (see hashIp); classes without an IP budget are free.
export async function consumeIp(db: Db, ipKey: string, actionClass: ActionClass, now = Date.now()): Promise<void> {
  const limit = IP_BUDGETS[actionClass];
  if (limit !== undefined) await spend(db, `ip:${ipKey}:${actionClass}`, limit, now);
}

async function spend(db: Db, key: string, limit: number, now: number): Promise<void> {
  const bucket = Math.floor(now / HOUR);
  const doc = await cols(db).rateLimits.findOneAndUpdate(
    { _id: `${key}:${bucket}` },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * HOUR) } },
    { upsert: true, returnDocument: "after" },
  );
  if (doc && doc.count > limit) throw new RateLimited(new Date((bucket + 1) * HOUR));
}
