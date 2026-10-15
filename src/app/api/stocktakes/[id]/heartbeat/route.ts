import { z } from "zod";
import { stocktakeHeartbeat } from "@/domain/ledger/write";
import { DeviceId } from "@/domain/schemas";
import { CommandId, handleCommand } from "@/lib/command";

// A count screen reports its queued counts (and "I'm done"); the answer is the team's status.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCommand(req, {
    target: id,
    name: "stocktakeHeartbeat",
    role: "clerk",
    actionClass: "count",
    input: z.object({ commandId: CommandId, deviceId: DeviceId, pending: z.number().int().min(0).max(10_000), done: z.boolean() }),
    run: (c, s, ctx, input, session) =>
      stocktakeHeartbeat(c, s, ctx, { stocktakeId: id, sid: session.sid, device: input.deviceId, pending: input.pending, done: input.done }),
  });
}
