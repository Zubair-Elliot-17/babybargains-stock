import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { normaliseBatchCode } from "@/domain/ledger/read";
import { assertRecallable, quarantineBatch } from "@/domain/ledger/write";
import { CommandId, handleCommand } from "@/lib/command";

const BatchCode = z.string().trim().min(1).max(40).transform(normaliseBatchCode);
const Input = z.object({ commandId: CommandId, batchCode: BatchCode, confirmCode: BatchCode });

export async function POST(req: Request) {
  return handleCommand(req, {
    name: "quarantine",
    role: "manager",
    actionClass: "quarantine",
    input: Input,
    precheck: (input) => {
      if (input.confirmCode !== input.batchCode) {
        throw new DomainError("CONFIRM_MISMATCH", `Type ${input.batchCode} to confirm`, 400);
      }
      assertRecallable(input.batchCode);
    },
    run: (c, s, ctx, input) => quarantineBatch(c, s, ctx, { batchCode: input.batchCode }),
  });
}
