import { runHistoricalTransactionsSync } from "./historical-transactions.service";
import { runFullSync } from "./sync.service";

function formatTallyDate(date: Date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

export async function runDailySync() {
  const lookbackDays = Math.max(0, Number(process.env.DAILY_SYNC_LOOKBACK_DAYS || 3));
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - lookbackDays);
  const range = { fromDate: formatTallyDate(from), toDate: formatTallyDate(to) };

  const masters = await runFullSync();
  const transactions = await runHistoricalTransactionsSync({
    ...range,
    modules: ["sales-vouchers", "purchase-vouchers", "outstandings", "delivery-challans"],
    skipCheckpoints: true,
    syncMode: "incremental",
  });

  const transactionStatus = "status" in transactions ? transactions.status : transactions.skipped ? "skipped" : "success";
  const failed = masters?.status === "failed" || transactionStatus === "failed";
  const partial = masters?.status === "partial_success" || transactionStatus === "partial_success";
  return {
    skipped: Boolean(masters?.skipped || transactions?.skipped),
    status: failed ? "failed" : partial ? "partial_success" : "success",
    syncMode: "incremental",
    range,
    masters,
    transactions,
    totals: masters?.totals || {},
    companies: masters?.companies || null,
    failedCompanies: masters?.failedCompanies || [],
  };
}
