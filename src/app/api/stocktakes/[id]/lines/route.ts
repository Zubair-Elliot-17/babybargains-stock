import { z } from "zod";
import { saveCountLine } from "@/domain/ledger/write";
import { CommandId, handleCommand } from "@/lib/command";

// One count entry; commandId doubles as the line id so retries never double count.
// capturedAt is in the body (same on every resend); the send time is a header so resends keep one fingerprint.
const Input = z.object({
  commandId: CommandId,
  sku: z.string().min(1).max(120),
  batchId: z.string().min(1).max(120).optional(),
  counted: z.number().int().min(0).max(9999),
  mode: z.enum(["add", "replace"]),
  capturedAt: z.iso.datetime().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sent = z.iso.datetime().safeParse(req.headers.get("x-sent-at"));
  return handleCommand(req, {
    target: id,
    name: "saveCountLine",
    role: "clerk",
    actionClass: "count",
    input: Input,
    run: (c, s, ctx, input, session) =>
      saveCountLine(c, s, ctx, {
        stocktakeId: id, lineId: input.commandId, sid: session.sid, sku: input.sku, batchId: input.batchId, counted: input.counted, mode: input.mode,
        capturedAt: input.capturedAt ? new Date(input.capturedAt) : undefined,
        sentAt: input.capturedAt && sent.success ? new Date(sent.data) : undefined,
      }),
  });
}
