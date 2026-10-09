import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { COOKIE } from "@/auth/session";

export async function POST(req: Request) {
  (await cookies()).delete(COOKIE);
  return NextResponse.redirect(new URL("/login", req.url), 303);
}
