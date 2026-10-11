import { notFound } from "next/navigation";
import { cols } from "@/domain/collections";
import { NotFound } from "@/domain/errors";
import { computeStocktakePlan } from "@/domain/ledger/read";
import { sortForReview } from "@/domain/ledger/stocktake";
import { getDb } from "@/lib/db";
import { ReviewScreen, type ReviewLine } from "@/components/stocktakes/ReviewScreen";

export const metadata = { title: "Review stocktake · BabyBargains Stock" };

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  let plan;
  try {
    plan = await computeStocktakePlan(cols(db), id);
  } catch (err) {
    if (err instanceof NotFound) notFound();
    throw err;
  }
  const branch = await cols(db).branches.findOne({ _id: plan.stocktake.branchId });
  const lines: ReviewLine[] = sortForReview(plan.lines).map((l) => {
    const full = plan.lines.find((x) => x.key === l.key)!;
    return {
      key: l.key, sku: l.sku, productName: full.productName, batchCode: full.batchCode, counted: l.counted, expected: l.expected,
      variance: l.variance, valuePence: l.valuePence, flagged: l.flagged, clampedBy: l.clampedBy, countedAt: full.countedAt.toISOString(),
    };
  });
  const st = plan.stocktake;
  return (
    <ReviewScreen
      stocktakeId={st._id}
      branchName={branch?.name ?? st.branchId}
      status={st.status}
      clerkLabel={st.clerkLabel}
      submittedAt={st.submittedAt?.toISOString() ?? null}
      approvedAt={st.approvedAt?.toISOString() ?? null}
      lines={lines}
    />
  );
}
