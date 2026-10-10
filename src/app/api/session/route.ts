import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { COOKIE, cookieOptions, createSession } from "@/auth/session";
import { cols } from "@/domain/collections";
import { NotFound } from "@/domain/errors";
import { errorResponse } from "@/lib/command";
import { getDb } from "@/lib/db";

// Demo login. Clerks are bound to the branch they pick here (design D25).
const Body = z.discriminatedUnion("role", [
  z.object({ role: z.literal("manager") }),
  z.object({ role: z.literal("clerk"), branchId: z.string().min(1).max(40) }),
]);

export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    if (body.role === "clerk") {
      const branch = await cols(await getDb()).branches.findOne({ _id: body.branchId });
      if (!branch) throw new NotFound("Unknown branch");
    }
    const { token } = createSession(body.role, body.role === "clerk" ? body.branchId : undefined);
    (await cookies()).set(COOKIE, token, cookieOptions);
    return NextResponse.json({ ok: true, next: body.role === "clerk" ? "/count" : "/recall?batch=B-4471" });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  (await cookies()).delete(COOKIE);
  return NextResponse.json({ ok: true });
}
