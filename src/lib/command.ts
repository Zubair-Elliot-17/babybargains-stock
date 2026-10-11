import { createHash, randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { consume, type ActionClass } from "@/auth/rateLimit";
import { COOKIE, requireRole, verifySession, type Role, type Session } from "@/auth/session";
import { cols, type Cols } from "@/domain/collections";
import { DomainError } from "@/domain/errors";
import { assertSameCommand, runCommand, type CommandCtx } from "@/domain/ledger/write";
import { logCommand } from "@/ops/log";
import { getClient, getDb } from "./db";

// Shared route-handler pipeline:
// session → role → Zod → replay of a finished commandId → precheck → rate limit → transaction → log.

export const CommandId = z.string().uuid();

export async function currentSession(): Promise<Session | null> {
  return verifySession((await cookies()).get(COOKIE)?.value);
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof DomainError) {
    return NextResponse.json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
  }
  if (err instanceof z.ZodError) {
    return NextResponse.json({ error: { code: "INVALID_INPUT", message: "Invalid input", details: err.issues } }, { status: 400 });
  }
  return NextResponse.json({ error: { code: "INTERNAL", message: "Couldn't save. Retry" } }, { status: 500 });
}

export async function handleCommand<I extends { commandId: string }, T>(
  req: Request,
  opts: {
    name: string;
    role: Role;
    actionClass: ActionClass;
    input: z.ZodType<I>;
    precheck?: (input: I) => void; // cheap validation that must not spend rate-limit budget
    run: (c: Cols, s: ClientSession, ctx: CommandCtx, input: I, session: Session) => Promise<T>;
  },
): Promise<NextResponse> {
  const started = Date.now();
  const requestId = randomUUID();
  let session: Session | null = null;
  let commandId: string | undefined;
  try {
    session = requireRole(await currentSession(), opts.role);
    const input = opts.input.parse(await req.json());
    commandId = input.commandId;
    const fingerprint = createHash("sha256").update(JSON.stringify([opts.name, session.sid, input])).digest("hex");
    const [client, db] = await Promise.all([getClient(), getDb()]);
    const prior = await cols(db).commandLog.findOne({ _id: commandId, result: { $ne: null } });
    if (prior) {
      assertSameCommand(prior, fingerprint);
      logCommand({ requestId, role: session.role, branchId: session.branchId, command: opts.name, commandId, outcome: "replayed", ms: Date.now() - started });
      return NextResponse.json({ result: prior.result, replayed: true });
    }
    opts.precheck?.(input);
    await consume(db, session.sid, opts.actionClass);
    const ctx: CommandCtx = { commandId, actor: `${session.role}:${session.sid.slice(0, 8)}`, origin: "visitor", fingerprint };
    const { result, replayed } = await runCommand(client, db, opts.name, ctx, (c, s) => opts.run(c, s, ctx, input, session!));
    logCommand({ requestId, role: session.role, branchId: session.branchId, command: opts.name, commandId, outcome: replayed ? "replayed" : "ok", ms: Date.now() - started });
    return NextResponse.json({ result, replayed });
  } catch (err) {
    const known = err instanceof DomainError || err instanceof z.ZodError;
    logCommand({
      requestId, role: session?.role, branchId: session?.branchId, command: opts.name, commandId,
      outcome: known ? "rejected" : "error", ms: Date.now() - started,
      errorClass: err instanceof Error ? err.name : typeof err,
      errorCode: err instanceof DomainError ? err.code : undefined,
    });
    if (!known) console.error(err);
    return errorResponse(err);
  }
}
