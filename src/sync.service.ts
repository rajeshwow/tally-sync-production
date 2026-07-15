import { resolveConfiguredTallyCompanies } from "./company-registry";
import {
  pushCostCentersToCrm,
  pushLedgersToCrm,
  pushStockItemsToCrm,
  updateTallyConnectionInCrm,
  updateTallySyncStateInCrm,
} from "./crm.client";
import {
  enrichLedgersWithGroupHierarchy,
  parseAccountGroups,
  parseCostCenters,
  parseLedgers,
  parseStockGroups,
  parseStockItems,
} from "./mapper";
import { TallyCompanySelection } from "./tally-company-selector";
import {
  fetchAccountGroupsXml,
  fetchCostCentersXml,
  fetchLedgersXml,
  fetchStockGroupsXml,
  fetchStockItemsXml,
} from "./tally.client";

let isSyncRunning = false;

type TallyCompanyForSync = {
  name: string;
  guid?: string | null;
  state?: string | null;
  country?: string | null;
  booksFrom?: string | null;
  startingFrom?: string | null;
};

function normalizeName(value: any) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function attachCompany<T extends Record<string, any>>(
  records: T[],
  company: TallyCompanyForSync,
): T[] {
  return records.map((record) => ({
    ...record,

    tallyCompanyName: company.name,
    tallyCompanyGuid: company.guid || null,

    tally_company_name: company.name,
    tally_company_guid: company.guid || null,
  }));
}

function formatTallyDate(date: Date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  return `${yyyy}${mm}${dd}`;
}

function getTodayStartDate() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function subtractDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() - days);
  return next;
}

function buildIncrementalDateRange(lastSuccessfulSyncAt?: string | null) {
  const today = new Date();
  const lookbackDays = getNumberEnv("DAILY_SYNC_LOOKBACK_DAYS", 3);

  let fromDate = lastSuccessfulSyncAt
    ? new Date(lastSuccessfulSyncAt)
    : getTodayStartDate();

  if (Number.isNaN(fromDate.getTime())) {
    fromDate = getTodayStartDate();
  }

  if (lastSuccessfulSyncAt && lookbackDays > 0) {
    fromDate = subtractDays(fromDate, lookbackDays);
  }

  return {
    fromDate: formatTallyDate(fromDate),
    toDate: formatTallyDate(today),
  };
}

async function syncOneCompany(company: TallyCompanyForSync) {
  const startedAt = new Date().toISOString();

  console.log(`[TALLY] Masters sync started: ${company.name}`);

  await updateTallyConnectionInCrm({
    companyName: company.name,
    companyGuid: company.guid,
  });

  try {
    const [accountGroupsXml, ledgersXml] = await Promise.all([
      fetchAccountGroupsXml(company.name),
      fetchLedgersXml(company.name),
    ]);
    const accountGroups = parseAccountGroups(String(accountGroupsXml || ""));
    const ledgerXmlText = String(ledgersXml || "");
    const ledgers = attachCompany(
      enrichLedgersWithGroupHierarchy(
        parseLedgers(ledgerXmlText),
        accountGroups,
      ),
      company,
    );

    const ledgerResult = await pushLedgersToCrm(ledgers, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      batchSize: getNumberEnv("BATCH_SIZE_LEDGERS", 20),
    });

    const costCentersXml = await fetchCostCentersXml(company.name);
    const costCenters = attachCompany(
      parseCostCenters(costCentersXml),
      company,
    );

    const costCenterResult = await pushCostCentersToCrm(costCenters, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      batchSize: getNumberEnv("BATCH_SIZE_COST_CENTERS", 20),
    });

    const stockGroupsXml = await fetchStockGroupsXml(company.name);
    const stockGroups = parseStockGroups(String(stockGroupsXml || ""));

    console.log("[TALLY] Stock groups parsed", {
      company: company.name,
      count: stockGroups.length,
    });

    const stockItemsXml = await fetchStockItemsXml(company.name);
    const stockXmlText = String(stockItemsXml || "");

    const stockItems = attachCompany(
      parseStockItems(stockXmlText, stockGroups),
      company,
    );

    const stockItemResult = await pushStockItemsToCrm(stockItems, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      batchSize: getNumberEnv("BATCH_SIZE_STOCK_ITEMS", 20),
    });

    const completedAt = new Date().toISOString();

    await updateTallySyncStateInCrm({
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      startedAt,
      completedAt,
      status: "success",
    });

    console.log(`[TALLY] Masters sync completed: ${company.name}`);

    return {
      company,
      ledgers: {
        count: ledgers.length,
        result: ledgerResult,
      },
      stockItems: {
        count: stockItems.length,
        result: stockItemResult,
      },
      costCenters: {
        count: costCenters.length,
        result: costCenterResult,
      },
    };
  } catch (error: any) {
    const completedAt = new Date().toISOString();

    await updateTallySyncStateInCrm({
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "incremental",
      startedAt,
      completedAt,
      status: "failed",
      errorMessage: error?.message || "Masters sync failed",
    });

    throw error;
  }
}

async function getCompaniesForSync(
  selection: TallyCompanySelection,
): Promise<TallyCompanyForSync[]> {
  return resolveConfiguredTallyCompanies(selection);
}

export async function runFullSync(selection: TallyCompanySelection = {}) {
  if (isSyncRunning) {
    return {
      skipped: true,
      status: "skipped",
      message: "Previous sync is still running",
    };
  }

  isSyncRunning = true;

  try {
    const companies = await getCompaniesForSync(selection);

    if (!companies.length) {
      throw new Error("No Tally company was selected for sync.");
    }

    const companyResults: any[] = [];

    const failedCompanies: Array<{
      company: TallyCompanyForSync;
      error: string;
    }> = [];

    for (const company of companies) {
      try {
        const result = await syncOneCompany(company);

        companyResults.push(result);
      } catch (error: any) {
        const message = error?.message || "Company sync failed";

        failedCompanies.push({
          company,
          error: message,
        });

        console.error("[TALLY] Company sync failed.", {
          company: company.name,
          companyGuid: company.guid,
          message,
        });
      }
    }

    const totals = companyResults.reduce(
      (acc, item) => {
        acc.ledgers += item.ledgers.count;

        acc.stockItems += item.stockItems.count;

        acc.costCenters += item.costCenters.count;

        return acc;
      },
      {
        ledgers: 0,
        stockItems: 0,
        costCenters: 0,
      },
    );

    const status =
      companyResults.length === 0
        ? "failed"
        : failedCompanies.length > 0
          ? "partial_success"
          : "success";

    return {
      skipped: false,
      status,
      syncMode: "incremental",

      companies: {
        count: companies.length,
        successCount: companyResults.length,
        failedCount: failedCompanies.length,
        records: companies,
      },

      totals,
      companyResults,
      failedCompanies,
    };
  } finally {
    isSyncRunning = false;
  }
}

export async function runStockItemsOnlySync(
  selection: TallyCompanySelection = {},
) {
  if (isSyncRunning) {
    return {
      skipped: true,
      status: "skipped",
      message: "Previous sync is still running",
    };
  }

  isSyncRunning = true;

  try {
    const companies = await getCompaniesForSync(selection);

    if (!companies.length) {
      throw new Error("No Tally company was selected for sync.");
    }

    const companyResults: any[] = [];
    const failedCompanies: Array<{
      company: TallyCompanyForSync;
      error: string;
    }> = [];

    for (const company of companies) {
      const startedAt = new Date().toISOString();

      try {
        console.log(`[TALLY] Stock-items-only sync started: ${company.name}`);

        await updateTallyConnectionInCrm({
          companyName: company.name,
          companyGuid: company.guid,
        });

        // Stock Group hierarchy is needed to map category/sub-category.
        const stockGroupsXml = await fetchStockGroupsXml(company.name);
        const stockGroups = parseStockGroups(String(stockGroupsXml || ""));

        console.log("[TALLY] Stock groups parsed", {
          company: company.name,
          count: stockGroups.length,
        });

        const stockItemsXml = await fetchStockItemsXml(company.name);

        const stockItems = attachCompany(
          parseStockItems(String(stockItemsXml || ""), stockGroups),
          company,
        );

        const stockItemResult = await pushStockItemsToCrm(stockItems, {
          companyName: company.name,
          companyGuid: company.guid,
          syncMode: "incremental",
          batchSize: getNumberEnv("BATCH_SIZE_STOCK_ITEMS", 20),
        });

        const completedAt = new Date().toISOString();

        await updateTallySyncStateInCrm({
          companyName: company.name,
          companyGuid: company.guid,
          syncMode: "incremental",
          startedAt,
          completedAt,
          status: "success",
        });

        companyResults.push({
          company,
          ledgers: {
            count: 0,
            result: null,
          },
          costCenters: {
            count: 0,
            result: null,
          },
          stockItems: {
            count: stockItems.length,
            result: stockItemResult,
          },
        });

        console.log(`[TALLY] Stock-items-only sync completed: ${company.name}`);
      } catch (error: any) {
        const message = error?.message || "Stock item sync failed";

        failedCompanies.push({
          company,
          error: message,
        });

        await updateTallySyncStateInCrm({
          companyName: company.name,
          companyGuid: company.guid,
          syncMode: "incremental",
          startedAt,
          completedAt: new Date().toISOString(),
          status: "failed",
          errorMessage: message,
        });

        console.error("[TALLY] Stock-items-only sync failed", {
          company: company.name,
          companyGuid: company.guid,
          message,
        });
      }
    }

    return {
      skipped: false,
      status:
        companyResults.length === 0
          ? "failed"
          : failedCompanies.length
            ? "partial_success"
            : "success",
      syncMode: "incremental",
      companies: {
        count: companies.length,
        successCount: companyResults.length,
        failedCount: failedCompanies.length,
        records: companies,
      },
      totals: {
        ledgers: 0,
        costCenters: 0,
        stockItems: companyResults.reduce(
          (total, item) => total + item.stockItems.count,
          0,
        ),
      },
      companyResults,
      failedCompanies,
    };
  } finally {
    isSyncRunning = false;
  }
}
