import { NextResponse } from "next/server";
import { cols } from "@/domain/collections";
import { getDb } from "@/lib/db";

// Post-deploy smoke check: DB reachable, last reset outcome, ledger invariants.
export async function GET() {
  const started = Date.now();
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    const ops = await cols(db).ops.findOne({ _id: "status" });
    const healthy = Boolean(ops) && ops?.invariantsOk !== false;
    return NextResponse.json(
      {
        ok: healthy,
        db: db.databaseName,
        dbMs: Date.now() - started,
        seededAt: ops?.seededAt ?? null,
        lastResetAt: ops?.lastResetAt ?? null,
        lastResetOk: ops?.lastResetOk ?? null,
        invariantsOk: ops?.invariantsOk ?? null,
        commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null, // lets the smoke check confirm the live domain serves the new deploy
      },
      { status: healthy ? 200 : 503 },
    );
  } catch (err) {
    console.error(JSON.stringify({ level: "error", at: new Date().toISOString(), command: "health", errorClass: err instanceof Error ? err.name : "unknown" }));
    return NextResponse.json({ ok: false, error: "database unreachable" }, { status: 503 });
  }
}
