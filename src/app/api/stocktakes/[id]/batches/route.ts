import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/auth/session";
import { Forbidden } from "@/domain/errors";
import { batchChoices } from "@/domain/ledger/read";
import { currentSession, errorResponse } from "@/lib/command";
import { getDb } from "@/lib/db";

// Batch codes for a batch-tracked SKU at the clerk's branch. Codes only: the count stays blind.
export async function GET(req: Request) {
  try {
    const session = requireRole(await currentSession(), "clerk");
    if (!session.branchId) throw new Forbidden("Sign in again and pick a branch");
    const sku = z.string().min(1).max(120).parse(new URL(req.url).searchParams.get("sku"));
    return NextResponse.json({ batches: await batchChoices(await getDb(), session.branchId, sku) });
  } catch (err) {
    return errorResponse(err);
  }
}
