import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Forbidden } from "@/domain/errors";

// Signed demo session cookie: base64url(payload).base64url(hmac). Role checks happen server-side.

export const COOKIE = "bb_session";
export const Role = z.enum(["manager", "clerk"]);
export type Role = z.infer<typeof Role>;

const Session = z.object({ sid: z.string(), role: Role, branchId: z.string().optional(), exp: z.number() });
export type Session = z.infer<typeof Session>;

const TTL_MS = 8 * 3_600_000;
let devSecret: string | undefined;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET (32+ chars) is required in production");
  if (!devSecret) {
    devSecret = randomBytes(32).toString("hex");
    console.warn("SESSION_SECRET missing or short; using a random per-process dev secret (sessions reset on restart).");
  }
  return devSecret;
}

const sign = (body: string) => createHmac("sha256", secret()).update(body).digest("base64url");

export function createSession(role: Role, branchId?: string, now = Date.now()): { token: string; session: Session } {
  const session: Session = { sid: randomUUID(), role, branchId, exp: now + TTL_MS };
  const body = Buffer.from(JSON.stringify(session)).toString("base64url");
  return { token: `${body}.${sign(body)}`, session };
}

export function verifySession(token: string | undefined, now = Date.now()): Session | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const parsed = Session.safeParse(JSON.parse(Buffer.from(body, "base64url").toString()));
  if (!parsed.success || parsed.data.exp < now) return null;
  return parsed.data;
}

export function requireRole(session: Session | null, role: Role): Session {
  if (!session) throw new Forbidden("Sign in to continue");
  if (session.role !== role) throw new Forbidden();
  return session;
}

// For manager pages and their layout. A client-side navigation renders only the changed segment, so
// the layout's check does not run for it: every manager page must call this itself.
export async function requireManagerPage(): Promise<Session> {
  const session = verifySession((await cookies()).get(COOKIE)?.value);
  if (!session || session.role !== "manager") redirect("/login");
  return session;
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: TTL_MS / 1000,
};
