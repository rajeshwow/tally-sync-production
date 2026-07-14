import { runHistoricalTransactionsSync } from "./historical-transactions.service";
import { runFullSync } from "./sync.service";
import { resolveCurrentTallyCompany } from "./tally-company-selector";

function formatTallyDate(date: Date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

export async function runDailySync() {
  const lookbackDays = Math.max(0, Number(process.env.DAILY_SYNC_LOOKBACK_DAYS || 3));
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - lookbackDays);
  const range = { fromDate: formatTallyDate(from), toDate: formatTallyDate(to) };

  const currentCompany = await resolveCurrentTallyCompany();

  const companySelection = {
    companyName: currentCompany.name,
    companyGuid: currentCompany.guid || null,
    skipConfiguredAllowlist: true,
  };

  console.log("[DAILY SYNC] Using currently opened Tally company", {
    companyName: currentCompany.name,
    companyGuid: currentCompany.guid || null,
  });

  const masters = await runFullSync(companySelection);
  const transactions = await runHistoricalTransactionsSync({
    ...range,
    companyName: currentCompany.name,
    companyGuid: currentCompany.guid || undefined,
    skipConfiguredAllowlist: true,
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
    currentCompany: {
      name: currentCompany.name,
      guid: currentCompany.guid || null,
    },
    masters,
    transactions,
    totals: masters?.totals || {},
    companies: masters?.companies || null,
    failedCompanies: masters?.failedCompanies || [],
  };
}
