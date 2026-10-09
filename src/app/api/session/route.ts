import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { COOKIE, cookieOptions, createSession } from "@/auth/session";
import { errorResponse } from "@/lib/command";

// Demo login: Manager only in Milestone 1 (the clerk shell ships with stocktake in Milestone 2).
const Body = z.object({ role: z.literal("manager") });

export async function POST(req: Request) {
  try {
    const { role } = Body.parse(await req.json());
    const { token } = createSession(role);
    (await cookies()).set(COOKIE, token, cookieOptions);
    return NextResponse.json({ ok: true, next: "/recall?batch=B-4471" });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  (await cookies()).delete(COOKIE);
  return NextResponse.json({ ok: true });
}
