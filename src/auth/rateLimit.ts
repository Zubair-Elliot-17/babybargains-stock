import type { Db } from "mongodb";
import { cols } from "@/domain/collections";
import { RateLimited } from "@/domain/errors";

// Per-session hourly budgets by action class (count lines need far more than other writes).
export const BUDGETS = { general: 60, count: 600, quarantine: 1 } as const;
export type ActionClass = keyof typeof BUDGETS;

const HOUR = 3_600_000;

export async function consume(db: Db, sid: string, actionClass: ActionClass, now = Date.now()): Promise<void> {
  const bucket = Math.floor(now / HOUR);
  const doc = await cols(db).rateLimits.findOneAndUpdate(
    { _id: `${sid}:${actionClass}:${bucket}` },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * HOUR) } },
    { upsert: true, returnDocument: "after" },
  );
  if (doc && doc.count > BUDGETS[actionClass]) throw new RateLimited(new Date((bucket + 1) * HOUR));
}
