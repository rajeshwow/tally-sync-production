import { resolveConfiguredTallyCompanies } from "./company-registry";
import {
  markHistoricalSyncProgressInCrm,
  pushCostCentersToCrm,
  pushLedgersToCrm,
  pushOutstandingsToCrm,
  pushPurchaseOrdersToCrm,
  pushSalesOrdersToCrm,
  pushDeliveryChallansToCrm,
  pushStockItemsToCrm,
  updateTallyConnectionInCrm,
  updateTallySyncStateInCrm,
  type PushProgressEvent,
} from "./crm.client";

import {
  parseAccountGroups,
  enrichLedgersWithGroupHierarchy,
  parseCostCenters,
  parseLedgers,
  parseOutstandings,
  parsePurchaseOrders,
  parseSalesOrders,
  parseStockGroups,
  parseStockItems,
  parseDeliveryChallans,
} from "./mapper";

import {
  fetchAccountGroupsXml,
  fetchCostCentersXml,
  fetchLedgersXml,
  fetchOutstandingsXml,
  fetchPurchaseOrdersXml,
  fetchSalesOrdersXml,
  fetchDeliveryChallansXml,
  fetchStockGroupsXml,
  fetchStockItemsXml,
  fetchTallyCompaniesXml,
  type TallyDateRange,
} from "./tally.client";

import {
  addSyncEvent,
  completeCompany,
  completeRange,
  finishSyncProgress,
  getSyncProgress,
  setActiveCompany,
  setActiveRange,
  startSyncProgress,
  upsertModuleProgress,
} from "./sync-progress.store";

import {
  clearHistoricalSyncCheckpoints,
  getSyncCheckpoint,
  listHistoricalSyncCheckpoints,
  markSyncCheckpoint,
} from "./sync-checkpoint.store";

let isHistoricalSyncRunning = false;

type HistoricalSyncRequest = {
  /**
   * Optional legacy input. Prefer fromDate.
   * If fromDate is missing and startYear exists, fromDate becomes `${startYear}0401`.
   */
  startYear?: number;
  /** Tally date format: YYYYMMDD. Example: 20160401 */
  fromDate?: string;
  /** Tally date format: YYYYMMDD. Defaults to today. */
  toDate?: string;
  companyName?: string;
  /** Clear historical checkpoints and run everything again. */
  forceRestart?: boolean;
};

type NormalizedHistoricalSyncRequest = {
  fromDate: string;
  toDate: string;
  companyName: string;
  forceRestart: boolean;
};

type HistoricalSyncStatus = {
  status: "idle" | "running" | "success" | "failed";
  isRunning: boolean;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  request: NormalizedHistoricalSyncRequest | null;
  lastResult: any;
};

const historicalSyncStatus: HistoricalSyncStatus = {
  status: "idle",
  isRunning: false,
  startedAt: null,
  completedAt: null,
  error: null,
  request: null,
  lastResult: null,
};

type TallyCompanyForSync = {
  name: string;
  guid?: string | null;
  state?: string | null;
  country?: string | null;
  booksFrom?: string | null;
  startingFrom?: string | null;
};

type HistoricalCompanyPlan = {
  company: TallyCompanyForSync;
  fromDate: string;
  toDate: string;
  dateRanges: TallyDateRange[];
};

function decodeXml(value: string) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, `"`)
    .replace(/&apos;/g, "'");
}

function readTag(block: string, tag: string): string {
  const match = block.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );

  return decodeXml(match?.[1]?.trim() || "");
}

function readAttr(block: string, tag: string, attr: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i"));

  return decodeXml(match?.[1]?.trim() || "");
}

function parseTallyCompanies(xml: string): TallyCompanyForSync[] {
  const text = String(xml || "");
  const companyBlocks = text.match(/<COMPANY[\s\S]*?<\/COMPANY>/gi) || [];

  const companies = companyBlocks
    .map((block) => {
      const attrName = readAttr(block, "COMPANY", "NAME");
      const tagName = readTag(block, "NAME");

      return {
        name: attrName || tagName,
        guid: readTag(block, "GUID") || null,
        state: readTag(block, "STATENAME") || null,
        country: readTag(block, "COUNTRYOFRESIDENCE") || null,
        booksFrom: readTag(block, "BOOKSFROM") || null,
        startingFrom: readTag(block, "STARTINGFROM") || null,
      };
    })
    .filter((company) => Boolean(company.name));

  const unique = new Map<string, TallyCompanyForSync>();

  for (const company of companies) {
    const key = company.guid || company.name.toLowerCase().trim();

    if (!unique.has(key)) {
      unique.set(key, company);
    }
  }

  return Array.from(unique.values());
}

function parseEnvCompanies(): TallyCompanyForSync[] {
  return String(process.env.TALLY_COMPANIES || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({
      name,
      guid: null,
    }));
}

async function getCompaniesForHistoricalSync(): Promise<TallyCompanyForSync[]> {
  const companies = await resolveConfiguredTallyCompanies();

  console.log("[HISTORICAL SYNC] Safe configured companies resolved:", companies);

  return companies;
}

function normalizeName(value: any) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeTallyDate(value?: string | null): string | null {
  const raw = String(value || "").trim();

  if (!raw) return null;

  const monthMap: Record<string, string> = {
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    may: "05",
    jun: "06",
    june: "06",
    jul: "07",
    july: "07",
    aug: "08",
    august: "08",
    sep: "09",
    sept: "09",
    september: "09",
    oct: "10",
    october: "10",
    nov: "11",
    november: "11",
    dec: "12",
    december: "12",
  };

  const tallyTextDate = raw.match(
    /^(\d{1,2})[-/\s]+([a-zA-Z]{3,9})[-/\s]+(\d{2,4})$/,
  );

  if (tallyTextDate) {
    const day = tallyTextDate[1].padStart(2, "0");
    const month = monthMap[tallyTextDate[2].toLowerCase()];
    let year = Number(tallyTextDate[3]);

    if (!month) return null;

    if (year < 100) {
      year = year >= 70 ? 1900 + year : 2000 + year;
    }

    if (year > 1900) {
      return `${year}${month}${day}`;
    }
  }

  const compact = raw.replace(/[^0-9]/g, "");

  if (/^\d{8}$/.test(compact)) {
    // YYYYMMDD
    if (Number(compact.slice(0, 4)) > 1900) return compact;

    // DDMMYYYY fallback
    return `${compact.slice(4, 8)}${compact.slice(2, 4)}${compact.slice(0, 2)}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return formatTallyDate(parsed);
  }

  return null;
}

function parseTallyDate(value: string): Date {
  const normalized = normalizeTallyDate(value);

  if (!normalized) {
    throw new Error(`Invalid Tally date: ${value}`);
  }

  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(4, 6)) - 1;
  const day = Number(normalized.slice(6, 8));

  return new Date(year, month, day);
}

function resolveRequestFromDate(input?: HistoricalSyncRequest) {
  const directFromDate = normalizeTallyDate(input?.fromDate);
  if (directFromDate) return directFromDate;

  const envFromDate =
    normalizeTallyDate(process.env.HISTORICAL_SYNC_FROM_DATE) ||
    normalizeTallyDate(process.env.TALLY_FROM_DATE);

  if (envFromDate) return envFromDate;

  if (input?.startYear) {
    return `${Number(input.startYear)}0401`;
  }

  return "";
}

function resolveRequestToDate(input?: HistoricalSyncRequest) {
  return (
    normalizeTallyDate(input?.toDate) ||
    normalizeTallyDate(process.env.HISTORICAL_SYNC_TO_DATE) ||
    normalizeTallyDate(process.env.TALLY_TO_DATE) ||
    formatTallyDate(new Date())
  );
}

function isHistoricalAutoDetectEnabled() {
  return (
    String(process.env.HISTORICAL_SYNC_AUTO_DETECT_FROM_DATE || "true")
      .trim()
      .toLowerCase() !== "false"
  );
}

function getHistoricalAutoDetectFromDate() {
  const direct =
    normalizeTallyDate(process.env.HISTORICAL_SYNC_SCAN_FROM_DATE) ||
    normalizeTallyDate(process.env.HISTORICAL_SCAN_FROM_DATE);

  if (direct) return direct;

  const minYear = Number(process.env.HISTORICAL_SYNC_MIN_YEAR || 2000);

  if (!Number.isFinite(minYear) || minYear < 1900) {
    return "20000401";
  }

  return `${minYear}0401`;
}

function getDetectionChunkMonths() {
  return Math.max(
    1,
    Number(process.env.HISTORICAL_SYNC_DETECT_CHUNK_MONTHS || 12),
  );
}

function buildDetectionDateRanges(input: {
  fromDate: string;
  toDate: string;
}): TallyDateRange[] {
  const fromDate = parseTallyDate(input.fromDate);
  const toDate = parseTallyDate(input.toDate);

  if (fromDate > toDate) {
    throw new Error(
      `Historical detection fromDate cannot be greater than toDate: ${input.fromDate} > ${input.toDate}`,
    );
  }

  const ranges: TallyDateRange[] = [];
  const chunkMonths = getDetectionChunkMonths();

  let rangeStart = new Date(fromDate);

  while (rangeStart <= toDate) {
    const rangeEnd = new Date(
      rangeStart.getFullYear(),
      rangeStart.getMonth() + chunkMonths,
      0,
    );

    ranges.push({
      fromDate: formatTallyDate(rangeStart),
      toDate: formatTallyDate(rangeEnd > toDate ? toDate : rangeEnd),
    });

    rangeStart = new Date(
      rangeEnd.getFullYear(),
      rangeEnd.getMonth(),
      rangeEnd.getDate() + 1,
    );
  }

  return ranges;
}

type HistoricalModuleName = "sales-orders" | "purchase-orders" | "outstandings" | "delivery-challans";

type RangeGuardResult<T> = {
  moduleName: HistoricalModuleName;
  requestedFromDate: string;
  requestedToDate: string;
  parsedRecords: T[];
  inRangeRecords: T[];
  outOfRangeRecords: T[];
  recordsWithoutDate: T[];
  minReturnedDate: string | null;
  maxReturnedDate: string | null;
  firstInRangeDate: string | null;
};

function getRecordVoucherDate(record: any): string | null {
  return normalizeTallyDate(
    record?.voucherDate ||
      record?.voucher_date ||
      record?.date ||
      record?.DATE ||
      record?.VOUCHERDATE ||
      record?.billDate ||
      record?.bill_date,
  );
}

function getDateStatsFromRecords(records: any[]) {
  const dates = records
    .map((record) => getRecordVoucherDate(record))
    .filter(Boolean)
    .sort() as string[];

  return {
    minReturnedDate: dates[0] || null,
    maxReturnedDate: dates[dates.length - 1] || null,
  };
}

function applyHistoricalRangeGuard<T extends Record<string, any>>(input: {
  moduleName: HistoricalModuleName;
  records: T[];
  dateRange: TallyDateRange;
  companyName: string;
}): RangeGuardResult<T> {
  const parsedRecords = Array.isArray(input.records) ? input.records : [];

  const inRangeRecords: T[] = [];
  const outOfRangeRecords: T[] = [];
  const recordsWithoutDate: T[] = [];

  for (const record of parsedRecords) {
    const recordDate = getRecordVoucherDate(record);

    if (!recordDate) {
      recordsWithoutDate.push(record);
      continue;
    }

    if (
      recordDate >= input.dateRange.fromDate &&
      recordDate <= input.dateRange.toDate
    ) {
      inRangeRecords.push(record);
    } else {
      outOfRangeRecords.push(record);
    }
  }

  const { minReturnedDate, maxReturnedDate } =
    getDateStatsFromRecords(parsedRecords);

  const firstInRangeDate =
    inRangeRecords
      .map((record) => getRecordVoucherDate(record))
      .filter(Boolean)
      .sort()[0] || null;

  if (parsedRecords.length > 0 && inRangeRecords.length === 0) {
  } else if (outOfRangeRecords.length > 0 || recordsWithoutDate.length > 0) {
  }

  return {
    moduleName: input.moduleName,
    requestedFromDate: input.dateRange.fromDate,
    requestedToDate: input.dateRange.toDate,
    parsedRecords,
    inRangeRecords,
    outOfRangeRecords,
    recordsWithoutDate,
    minReturnedDate,
    maxReturnedDate,
    firstInRangeDate,
  };
}

function logHistoricalRangeGuardSummary<T>(guard: RangeGuardResult<T>) {
  console.log("[HISTORICAL][RANGE FILTER]", {
    module: guard.moduleName,
    fromDate: guard.requestedFromDate,
    toDate: guard.requestedToDate,
    raw: guard.parsedRecords.length,
    inRange: guard.inRangeRecords.length,
    outOfRange: guard.outOfRangeRecords.length,
    withoutDate: guard.recordsWithoutDate.length,
  });
}

function getEarliestDate(...dates: Array<string | null | undefined>) {
  return dates.filter(Boolean).sort()[0] || null;
}

async function detectTransactionRecordCountForRange(input: {
  company: TallyCompanyForSync;
  dateRange: TallyDateRange;
}) {
  const { company, dateRange } = input;

  const result = {
    salesOrders: 0,
    purchaseOrders: 0,
    outstandings: 0,

    salesOrdersParsed: 0,
    purchaseOrdersParsed: 0,
    outstandingsParsed: 0,

    salesOrdersOutOfRange: 0,
    purchaseOrdersOutOfRange: 0,
    outstandingsOutOfRange: 0,

    salesOrdersWithoutDate: 0,
    purchaseOrdersWithoutDate: 0,
    outstandingsWithoutDate: 0,

    firstSalesOrderDate: null as string | null,
    firstPurchaseOrderDate: null as string | null,
    firstOutstandingDate: null as string | null,
    firstValidDate: null as string | null,

    minReturnedDate: null as string | null,
    maxReturnedDate: null as string | null,

    // SO/PO are date-range reliable transaction proofs.
    primaryTotal: 0,

    // Outstanding is fallback only after strict voucherDate validation.
    fallbackTotal: 0,

    total: 0,
    errors: [] as string[],
  };

  try {
    const salesOrdersXml = await fetchSalesOrdersXml(company.name, dateRange);
    const parsedSalesOrders = parseSalesOrders(String(salesOrdersXml || ""));

    const guardedSalesOrders = applyHistoricalRangeGuard({
      moduleName: "sales-orders",
      companyName: company.name,
      records: parsedSalesOrders,
      dateRange,
    });

    result.salesOrders = guardedSalesOrders.inRangeRecords.length;
    result.salesOrdersParsed = guardedSalesOrders.parsedRecords.length;
    result.salesOrdersOutOfRange = guardedSalesOrders.outOfRangeRecords.length;
    result.salesOrdersWithoutDate =
      guardedSalesOrders.recordsWithoutDate.length;
    result.firstSalesOrderDate = guardedSalesOrders.firstInRangeDate;

    result.minReturnedDate = getEarliestDate(
      result.minReturnedDate,
      guardedSalesOrders.minReturnedDate,
    );

    result.maxReturnedDate =
      [result.maxReturnedDate, guardedSalesOrders.maxReturnedDate]
        .filter(Boolean)
        .sort()
        .pop() || null;
  } catch (error: any) {
    result.errors.push(`sales-orders: ${error?.message || "failed"}`);
  }

  try {
    const purchaseOrdersXml = await fetchPurchaseOrdersXml(
      company.name,
      dateRange,
    );

    const parsedPurchaseOrders = parsePurchaseOrders(
      String(purchaseOrdersXml || ""),
    );

    const guardedPurchaseOrders = applyHistoricalRangeGuard({
      moduleName: "purchase-orders",
      companyName: company.name,
      records: parsedPurchaseOrders,
      dateRange,
    });

    result.purchaseOrders = guardedPurchaseOrders.inRangeRecords.length;
    result.purchaseOrdersParsed = guardedPurchaseOrders.parsedRecords.length;
    result.purchaseOrdersOutOfRange =
      guardedPurchaseOrders.outOfRangeRecords.length;
    result.purchaseOrdersWithoutDate =
      guardedPurchaseOrders.recordsWithoutDate.length;
    result.firstPurchaseOrderDate = guardedPurchaseOrders.firstInRangeDate;

    result.minReturnedDate = getEarliestDate(
      result.minReturnedDate,
      guardedPurchaseOrders.minReturnedDate,
    );

    result.maxReturnedDate =
      [result.maxReturnedDate, guardedPurchaseOrders.maxReturnedDate]
        .filter(Boolean)
        .sort()
        .pop() || null;
  } catch (error: any) {
    result.errors.push(`purchase-orders: ${error?.message || "failed"}`);
  }

  try {
    const outstandingsXml = await fetchOutstandingsXml(company.name, dateRange);
    const parsedOutstandings = parseOutstandings(String(outstandingsXml || ""));

    const guardedOutstandings = applyHistoricalRangeGuard({
      moduleName: "outstandings",
      companyName: company.name,
      records: parsedOutstandings,
      dateRange,
    });

    result.outstandings = guardedOutstandings.inRangeRecords.length;
    result.outstandingsParsed = guardedOutstandings.parsedRecords.length;
    result.outstandingsOutOfRange =
      guardedOutstandings.outOfRangeRecords.length;
    result.outstandingsWithoutDate =
      guardedOutstandings.recordsWithoutDate.length;
    result.firstOutstandingDate = guardedOutstandings.firstInRangeDate;

    result.minReturnedDate = getEarliestDate(
      result.minReturnedDate,
      guardedOutstandings.minReturnedDate,
    );

    result.maxReturnedDate =
      [result.maxReturnedDate, guardedOutstandings.maxReturnedDate]
        .filter(Boolean)
        .sort()
        .pop() || null;
  } catch (error: any) {
    result.errors.push(`outstandings: ${error?.message || "failed"}`);
  }

  result.firstValidDate = getEarliestDate(
    result.firstSalesOrderDate,
    result.firstPurchaseOrderDate,
    result.firstOutstandingDate,
  );

  result.primaryTotal = result.salesOrders + result.purchaseOrders;
  result.fallbackTotal = result.outstandings;
  result.total = result.primaryTotal + result.fallbackTotal;

  return result;
}

async function detectCompanyFirstRecordFromDate(input: {
  company: TallyCompanyForSync;
  toDate: string;
}) {
  if (!isHistoricalAutoDetectEnabled()) {
    return null;
  }

  const scanFromDate = getHistoricalAutoDetectFromDate();

  const ranges = buildDetectionDateRanges({
    fromDate: scanFromDate,
    toDate: input.toDate,
  });

  let firstOutstandingFallbackDate: string | null = null;

  for (const dateRange of ranges) {
    const count = await detectTransactionRecordCountForRange({
      company: input.company,
      dateRange,
    });

    if (!firstOutstandingFallbackDate && count.firstOutstandingDate) {
      firstOutstandingFallbackDate = count.firstOutstandingDate;
    }

    if (count.primaryTotal > 0 && count.firstValidDate) {
      return count.firstValidDate;
    }
  }

  if (firstOutstandingFallbackDate) {
    console.warn(
      "[HISTORICAL SYNC] Auto-detect using outstanding fallback actual voucher date",
      {
        company: input.company.name,
        actualFirstOutstandingDate: firstOutstandingFallbackDate,
        reason:
          "No Sales Order/Purchase Order found during scan, but in-range Outstanding records were found.",
      },
    );

    return firstOutstandingFallbackDate;
  }

  console.warn(
    "[HISTORICAL SYNC] Auto-detect found no valid historical records",
    {
      company: input.company.name,
      scanFromDate,
      toDate: input.toDate,
      note: "If Tally returned records outside requested ranges, they were ignored by range guard.",
    },
  );

  return null;
}

async function resolveCompanyHistoricalFromDate(
  company: TallyCompanyForSync,
  request: NormalizedHistoricalSyncRequest,
) {
  const requestFromDate = normalizeTallyDate(request.fromDate);

  // 1. Highest priority: curl/env se jo fromDate aaye, wahi use karo
  if (requestFromDate) {
    console.log("[HISTORICAL SYNC] Using explicit fromDate", {
      company: company.name,
      fromDate: requestFromDate,
    });

    return requestFromDate;
  }

  // 2. Agar explicit fromDate nahi hai, tab auto-detect try karo
  const detectedFromDate = await detectCompanyFirstRecordFromDate({
    company,
    toDate: request.toDate,
  });

  if (detectedFromDate) {
    console.log("[HISTORICAL SYNC] Using auto-detected fromDate", {
      company: company.name,
      fromDate: detectedFromDate,
    });

    return detectedFromDate;
  }

  // 3. Tally company booksFrom fallback
  const companyBooksFrom =
    normalizeTallyDate(company.booksFrom) ||
    normalizeTallyDate(company.startingFrom) ||
    "";

  if (companyBooksFrom) {
    console.warn("[HISTORICAL SYNC] Using company booksFrom fallback", {
      company: company.name,
      booksFrom: companyBooksFrom,
    });

    return companyBooksFrom;
  }

  // 4. Final fallback: env min year se start karo, crash mat karo
  const fallbackFromDate = getHistoricalAutoDetectFromDate();

  console.warn("[HISTORICAL SYNC] Using fallback fromDate from min year", {
    company: company.name,
    fallbackFromDate,
  });

  return fallbackFromDate;
}

function enrichOutstandingsWithLedgerGuid(outstandings: any[], ledgers: any[]) {
  const ledgerByName = new Map<string, any>();

  for (const ledger of ledgers) {
    const key = normalizeName(ledger.name);

    if (key && ledger.guid) {
      ledgerByName.set(key, ledger);
    }
  }

  return outstandings.map((row) => {
    const key = normalizeName(row.ledgerName);
    const matchedLedger = ledgerByName.get(key);

    return {
      ...row,
      ledgerGuid: row.ledgerGuid || matchedLedger?.guid || null,
      ledgerMasterId: row.ledgerMasterId || matchedLedger?.masterId || null,
      ledgerAlterId: row.ledgerAlterId || matchedLedger?.alterId || null,
    };
  });
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

function getRangeChunkMonths() {
  return Math.max(1, Number(process.env.HISTORICAL_SYNC_RANGE_MONTHS || 1));
}

function buildHistoricalDateRanges(input: {
  fromDate: string;
  toDate?: string;
}): TallyDateRange[] {
  const fromDate = parseTallyDate(input.fromDate);
  const toDate = parseTallyDate(input.toDate || formatTallyDate(new Date()));

  if (fromDate > toDate) {
    throw new Error(
      `Historical fromDate cannot be greater than toDate: ${input.fromDate} > ${input.toDate}`,
    );
  }

  const ranges: TallyDateRange[] = [];
  const chunkMonths = getRangeChunkMonths();
  let rangeStart = new Date(fromDate);

  while (rangeStart <= toDate) {
    const rangeEnd = new Date(
      rangeStart.getFullYear(),
      rangeStart.getMonth() + chunkMonths,
      0,
    );

    ranges.push({
      fromDate: formatTallyDate(rangeStart),
      toDate: formatTallyDate(rangeEnd > toDate ? toDate : rangeEnd),
    });

    rangeStart = new Date(
      rangeEnd.getFullYear(),
      rangeEnd.getMonth(),
      rangeEnd.getDate() + 1,
    );
  }

  return ranges;
}

function normalizeHistoricalRequest(
  input?: HistoricalSyncRequest,
): NormalizedHistoricalSyncRequest {
  return {
    fromDate: resolveRequestFromDate(input),
    toDate: resolveRequestToDate(input),
    companyName: input?.companyName || "",
    forceRestart: Boolean(input?.forceRestart),
  };
}

function setHistoricalSyncStatus(
  patch: Partial<HistoricalSyncStatus>,
): HistoricalSyncStatus {
  Object.assign(historicalSyncStatus, patch);
  return getHistoricalSyncStatus();
}

function buildHistoricalLiveProgress(progress: any) {
  const modules = Array.isArray(progress.modules) ? progress.modules : [];

  const activeModule =
    modules.find((item: any) =>
      ["fetching", "parsed", "uploading"].includes(item.status),
    ) ||
    modules.find((item: any) => item.status === "failed") ||
    null;

  const activeModuleIndex = activeModule
    ? modules.findIndex((item: any) => item.key === activeModule.key) + 1
    : Math.min(progress.summary.modulesCompleted || 0, modules.length);

  const modulesCompleted = modules.filter((item: any) =>
    ["success", "skipped"].includes(item.status),
  ).length;

  const modulesFailed = modules.filter(
    (item: any) => item.status === "failed",
  ).length;

  return {
    runId: progress.runId,
    mode: progress.mode,
    status: progress.status,
    isRunning: progress.isRunning,

    startedAt: progress.startedAt,
    completedAt: progress.completedAt,
    error: progress.error,

    currentCompany: {
      step: `${progress.activeCompany.index || 0}/${progress.activeCompany.total || 0}`,
      index: progress.activeCompany.index || 0,
      total: progress.activeCompany.total || 0,
      name: progress.activeCompany.name || null,
      guid: progress.activeCompany.guid || null,
    },

    currentRange: {
      step: `${progress.activeRange.index || 0}/${progress.activeRange.total || 0}`,
      index: progress.activeRange.index || 0,
      total: progress.activeRange.total || 0,
      fromDate: progress.activeRange.fromDate || null,
      toDate: progress.activeRange.toDate || null,
    },

    currentModule: activeModule
      ? {
          step: `${activeModuleIndex}/${modules.length}`,
          index: activeModuleIndex,
          total: modules.length,
          name: activeModule.moduleName,
          companyName: activeModule.companyName || null,
          companyGuid: activeModule.companyGuid || null,
          fromDate: activeModule.fromDate || null,
          toDate: activeModule.toDate || null,
          status: activeModule.status,

          pulledRecords: activeModule.totalRecords || 0,
          uploadedRecords: activeModule.uploadedRecords || 0,
          pendingRecords: activeModule.pendingRecords || 0,
          failedRecords: activeModule.failedRecords || 0,

          batch: `${activeModule.currentBatch || 0}/${activeModule.totalBatches || 0}`,
          currentBatch: activeModule.currentBatch || 0,
          totalBatches: activeModule.totalBatches || 0,
          uploadedBatches: activeModule.uploadedBatches || 0,
          failedBatches: activeModule.failedBatches || 0,

          startedAt: activeModule.startedAt || null,
          completedAt: activeModule.completedAt || null,
          error: activeModule.error || null,
        }
      : null,

    summary: {
      companies: `${progress.summary.companiesCompleted || 0}/${progress.summary.companiesTotal || 0}`,
      ranges: `${progress.summary.rangesCompleted || 0}/${progress.summary.rangesTotal || 0}`,
      modules: `${modulesCompleted}/${modules.length}`,
      modulesTotal: modules.length,
      modulesCompleted,
      modulesFailed,

      pulledRecords: progress.summary.totalRecords || 0,
      uploadedRecords: progress.summary.uploadedRecords || 0,
      pendingRecords: progress.summary.pendingRecords || 0,
      failedRecords: progress.summary.failedRecords || 0,

      progressPercent: progress.summary.progressPercent || 0,
    },

    recentEvents: Array.isArray(progress.events)
      ? progress.events.slice(0, 15)
      : [],
  };
}

export function getHistoricalSyncStatus(): any {
  const progress = getSyncProgress();
  const checkpoints = listHistoricalSyncCheckpoints();

  return {
    ...historicalSyncStatus,
    live: buildHistoricalLiveProgress(progress),
    progress,
    checkpoints: {
      total: checkpoints.length,
      success: checkpoints.filter((item) => item.status === "success").length,
      failed: checkpoints.filter((item) => item.status === "failed").length,
      running: checkpoints.filter((item) => item.status === "running").length,
      records: checkpoints.slice(-50),
    },
  };
}

function createCrmPushProgressHandler() {
  return (event: PushProgressEvent) => {
    const statusByEvent: Record<PushProgressEvent["type"], any> = {
      module_start: "uploading",
      batch_start: "uploading",
      batch_success: "uploading",
      batch_failed: "failed",
      module_complete: "success",
    };

    upsertModuleProgress({
      moduleName: event.moduleName,
      companyName: event.companyName || null,
      companyGuid: event.companyGuid || null,
      fromDate: event.fromDate || null,
      toDate: event.toDate || null,
      status: statusByEvent[event.type],
      totalRecords: event.totalRecords,
      uploadedRecords: event.uploadedRecords,
      failedRecords: event.failedRecords,
      pendingRecords: event.pendingRecords,
      batchSize: event.batchSize,
      totalBatches: event.totalBatches,
      uploadedBatches: event.uploadedBatches,
      failedBatches: event.failedBatches,
      currentBatch: event.batchNo || 0,
      completedAt:
        event.type === "module_complete" ? new Date().toISOString() : null,
      error: event.errorMessage || null,
    });

    if (event.type === "batch_success") {
      const _co = event.companyName ? ` [${event.companyName}]` : "";
      const _dr =
        event.fromDate && event.toDate
          ? ` (${event.fromDate}→${event.toDate})`
          : "";
      console.log(
        `[HISTORICAL]${_co} ${event.moduleName.padEnd(18)} ✅ Batch ${event.batchNo}/${event.totalBatches}${_dr} — ${event.uploadedRecords}/${event.totalRecords} records`,
      );
      addSyncEvent({
        level: "info",
        message: `${event.moduleName}: batch ${event.batchNo}/${event.totalBatches} uploaded`,
        companyName: event.companyName || null,
        moduleName: event.moduleName,
        fromDate: event.fromDate || null,
        toDate: event.toDate || null,
        details: {
          uploadedRecords: event.uploadedRecords,
          pendingRecords: event.pendingRecords,
        },
      });
    }

    if (event.type === "batch_failed") {
      const _co = event.companyName ? ` [${event.companyName}]` : "";
      const _dr =
        event.fromDate && event.toDate
          ? ` (${event.fromDate}→${event.toDate})`
          : "";
      console.error(
        `[HISTORICAL]${_co} ${event.moduleName.padEnd(18)} ❌ Batch ${event.batchNo}/${event.totalBatches}${_dr} FAILED — ${event.errorMessage || "unknown error"}`,
      );
      addSyncEvent({
        level: "error",
        message: `${event.moduleName}: batch ${event.batchNo}/${event.totalBatches} failed`,
        companyName: event.companyName || null,
        moduleName: event.moduleName,
        fromDate: event.fromDate || null,
        toDate: event.toDate || null,
        details: event.errorMessage || null,
      });
    }
  };
}

const HISTORICAL_MASTER_MODULES = ["ledgers", "stock-items", "cost-centers"];

const HISTORICAL_RANGE_MODULES = [
  "sales-orders",
  "purchase-orders",
  "outstandings",
];

function seedHistoricalProgressModules(input: {
  plans: HistoricalCompanyPlan[];
}) {
  for (const plan of input.plans) {
    for (const moduleName of HISTORICAL_MASTER_MODULES) {
      upsertModuleProgress({
        moduleName,
        companyName: plan.company.name,
        companyGuid: plan.company.guid,
        status: "pending",
      });
    }

    for (const dateRange of plan.dateRanges) {
      for (const moduleName of HISTORICAL_RANGE_MODULES) {
        upsertModuleProgress({
          moduleName,
          companyName: plan.company.name,
          companyGuid: plan.company.guid,
          fromDate: dateRange.fromDate,
          toDate: dateRange.toDate,
          status: "pending",
        });
      }
    }
  }

  const rangesTotal = input.plans.reduce(
    (sum, plan) => sum + plan.dateRanges.length,
    0,
  );

  const modulesTotal = input.plans.reduce(
    (sum, plan) =>
      sum +
      HISTORICAL_MASTER_MODULES.length +
      plan.dateRanges.length * HISTORICAL_RANGE_MODULES.length,
    0,
  );

  addSyncEvent({
    level: "info",
    message: "Historical sync plan prepared",
    details: {
      companies: input.plans.length,
      rangesTotal,
      modulesTotal,
    },
  });
}

function getHistoricalModuleCheckpoint(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  fromDate?: string | null;
  toDate?: string | null;
}) {
  return getSyncCheckpoint({
    mode: "historical",
    companyName: input.company.name,
    companyGuid: input.company.guid,
    moduleName: input.moduleName,
    fromDate: input.fromDate || null,
    toDate: input.toDate || null,
  });
}

function shouldSkipHistoricalModule(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  fromDate?: string | null;
  toDate?: string | null;
  totalRecords: number;
}) {
  const checkpoint = getHistoricalModuleCheckpoint(input);

  if (checkpoint?.status !== "success") {
    return false;
  }

  const checkpointRecords = Number(checkpoint.totalRecords || 0);

  /**
   * Important safety guard:
   * Older/current buggy runs may have saved success with 0 records.
   * If this run has records, do not trust that stale checkpoint.
   */
  if (input.totalRecords > 0 && checkpointRecords <= 0) {
    addSyncEvent({
      level: "warn",
      message: `${input.moduleName} checkpoint ignored because it had 0 records but current parse found ${input.totalRecords}`,
      companyName: input.company.name,
      moduleName: input.moduleName,
      fromDate: input.fromDate || null,
      toDate: input.toDate || null,
      details: {
        checkpointRecords,
        currentRecords: input.totalRecords,
      },
    });

    return false;
  }

  return true;
}

function markHistoricalModuleSkipped(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  fromDate?: string | null;
  toDate?: string | null;
  totalRecords?: number;
}) {
  const totalRecords = input.totalRecords || 0;

  upsertModuleProgress({
    moduleName: input.moduleName,
    companyName: input.company.name,
    companyGuid: input.company.guid,
    fromDate: input.fromDate || null,
    toDate: input.toDate || null,
    status: "skipped",
    totalRecords,
    uploadedRecords: totalRecords,
    pendingRecords: 0,
    failedRecords: 0,
    completedAt: new Date().toISOString(),
  });

  addSyncEvent({
    level: "info",
    message: `${input.moduleName} skipped because checkpoint already exists`,
    companyName: input.company.name,
    moduleName: input.moduleName,
    fromDate: input.fromDate || null,
    toDate: input.toDate || null,
  });
}

function markHistoricalModuleRunning(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  fromDate?: string | null;
  toDate?: string | null;
}) {
  markSyncCheckpoint({
    mode: "historical",
    companyName: input.company.name,
    companyGuid: input.company.guid,
    moduleName: input.moduleName,
    fromDate: input.fromDate || null,
    toDate: input.toDate || null,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null,
  });
}

function markHistoricalModuleSuccess(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  fromDate?: string | null;
  toDate?: string | null;
  totalRecords?: number;
  uploadedRecords?: number;
}) {
  markSyncCheckpoint({
    mode: "historical",
    companyName: input.company.name,
    companyGuid: input.company.guid,
    moduleName: input.moduleName,
    fromDate: input.fromDate || null,
    toDate: input.toDate || null,
    status: "success",
    totalRecords: input.totalRecords || 0,
    uploadedRecords: input.uploadedRecords ?? input.totalRecords ?? 0,
    failedRecords: 0,
    completedAt: new Date().toISOString(),
    errorMessage: null,
  });
}

function markHistoricalModuleFailed(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  fromDate?: string | null;
  toDate?: string | null;
  totalRecords?: number;
  uploadedRecords?: number;
  failedRecords?: number;
  errorMessage?: string | null;
}) {
  markSyncCheckpoint({
    mode: "historical",
    companyName: input.company.name,
    companyGuid: input.company.guid,
    moduleName: input.moduleName,
    fromDate: input.fromDate || null,
    toDate: input.toDate || null,
    status: "failed",
    totalRecords: input.totalRecords || 0,
    uploadedRecords: input.uploadedRecords || 0,
    failedRecords: input.failedRecords || 0,
    completedAt: new Date().toISOString(),
    errorMessage: input.errorMessage || "Historical module sync failed",
  });
}

async function uploadHistoricalModule(input: {
  moduleName: string;
  company: TallyCompanyForSync;
  records: any[];
  fromDate?: string | null;
  toDate?: string | null;
  batchSize: any;
  push: (records: any[], options: any) => Promise<any>;
}) {
  const { moduleName, company, records, fromDate, toDate } = input;
  const totalRecords = Array.isArray(records) ? records.length : 0;

  if (
    shouldSkipHistoricalModule({
      moduleName,
      company,
      fromDate,
      toDate,
      totalRecords,
    })
  ) {
    markHistoricalModuleSkipped({
      moduleName,
      company,
      fromDate,
      toDate,
      totalRecords,
    });

    return {
      skipped: true,
      moduleName,
      totalRecords,
      uploadedRecords: totalRecords,
    };
  }

  markHistoricalModuleRunning({ moduleName, company, fromDate, toDate });

  try {
    const result = await input.push(records, {
      companyName: company.name,
      companyGuid: company.guid,
      syncMode: "historical",
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      batchSize: input.batchSize,
      onProgress: createCrmPushProgressHandler(),
    });

    if (totalRecords > 0) {
      markHistoricalModuleSuccess({
        moduleName,
        company,
        fromDate,
        toDate,
        totalRecords,
        uploadedRecords: result?.uploadedRecords ?? totalRecords,
      });
    } else {
      addSyncEvent({
        level: "info",
        message: `${moduleName} had 0 parsed records; checkpoint not saved so future historical runs can pick newly available data`,
        companyName: company.name,
        moduleName,
        fromDate: fromDate || null,
        toDate: toDate || null,
      });
    }

    return result;
  } catch (error: any) {
    markHistoricalModuleFailed({
      moduleName,
      company,
      fromDate,
      toDate,
      totalRecords,
      errorMessage: error?.message || "Historical module sync failed",
    });

    throw error;
  }
}

async function buildHistoricalCompanyPlans(input: {
  companies: TallyCompanyForSync[];
  request: NormalizedHistoricalSyncRequest;
}): Promise<HistoricalCompanyPlan[]> {
  const plans: HistoricalCompanyPlan[] = [];

  for (const company of input.companies) {
    const fromDate = await resolveCompanyHistoricalFromDate(
      company,
      input.request,
    );

    if (!fromDate) {
      throw new Error(
        `Historical fromDate missing for company "${company.name}". Auto-detect could not find records. Send {"fromDate":"YYYYMMDD"} or set HISTORICAL_SYNC_FROM_DATE.`,
      );
    }

    const dateRanges = buildHistoricalDateRanges({
      fromDate,
      toDate: input.request.toDate,
    });

    plans.push({
      company,
      fromDate,
      toDate: input.request.toDate,
      dateRanges,
    });
  }

  return plans;
}

async function syncCompanyMasters(company: TallyCompanyForSync) {
  console.log("[HISTORICAL SYNC] Masters started", {
    company: company.name,
  });

  await updateTallyConnectionInCrm({
    companyName: company.name,
    companyGuid: company.guid,
  });

  upsertModuleProgress({
    moduleName: "ledgers",
    companyName: company.name,
    companyGuid: company.guid,
    status: "fetching",
  });

  const [accountGroupsXml, ledgersXml] = await Promise.all([
    fetchAccountGroupsXml(company.name),
    fetchLedgersXml(company.name),
  ]);
  const accountGroups = parseAccountGroups(String(accountGroupsXml || ""));
  const ledgers = attachCompany(
    enrichLedgersWithGroupHierarchy(parseLedgers(String(ledgersXml || "")), accountGroups),
    company,
  );

  upsertModuleProgress({
    moduleName: "ledgers",
    companyName: company.name,
    companyGuid: company.guid,
    status: "parsed",
    totalRecords: ledgers.length,
    pendingRecords: ledgers.length,
  });

  const ledgerResult = await pushLedgersToCrm(ledgers, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: "historical",
    batchSize: process.env.BATCH_SIZE_LEDGERS || 10,
    onProgress: createCrmPushProgressHandler(),
  });

  upsertModuleProgress({
    moduleName: "stock-items",
    companyName: company.name,
    companyGuid: company.guid,
    status: "fetching",
  });

  const stockGroupsXml = await fetchStockGroupsXml(company.name);
  const stockGroups = parseStockGroups(String(stockGroupsXml || ""));

  addSyncEvent({
    level: "info",
    moduleName: "stock-items",
    companyName: company.name,
    message: `Parsed ${stockGroups.length} stock groups for category mapping`,
    details: {
      companyGuid: company.guid,
      stockGroups: stockGroups.length,
    },
  });

  const stockItemsXml = await fetchStockItemsXml(company.name);
  const stockItems = attachCompany(
    parseStockItems(String(stockItemsXml || ""), stockGroups),
    company,
  );

  upsertModuleProgress({
    moduleName: "stock-items",
    companyName: company.name,
    companyGuid: company.guid,
    status: "parsed",
    totalRecords: stockItems.length,
    pendingRecords: stockItems.length,
  });

  const stockItemResult = await pushStockItemsToCrm(stockItems, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: "historical",
    batchSize: process.env.BATCH_SIZE_STOCK_ITEMS || 10,
    onProgress: createCrmPushProgressHandler(),
  });

  upsertModuleProgress({
    moduleName: "cost-centers",
    companyName: company.name,
    companyGuid: company.guid,
    status: "fetching",
  });

  const costCentersXml = await fetchCostCentersXml(company.name);
  const costCenters = attachCompany(
    parseCostCenters(String(costCentersXml || "")),
    company,
  );

  upsertModuleProgress({
    moduleName: "cost-centers",
    companyName: company.name,
    companyGuid: company.guid,
    status: "parsed",
    totalRecords: costCenters.length,
    pendingRecords: costCenters.length,
  });

  const costCenterResult = await pushCostCentersToCrm(costCenters, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: "historical",
    batchSize: process.env.BATCH_SIZE_COST_CENTERS || 10,
    onProgress: createCrmPushProgressHandler(),
  });

  console.log("[HISTORICAL SYNC] Masters completed", {
    company: company.name,
    ledgers: ledgers.length,
    stockItems: stockItems.length,
    costCenters: costCenters.length,
  });

  return {
    ledgers,
    results: {
      ledgers: ledgerResult,
      stockItems: stockItemResult,
      costCenters: costCenterResult,
    },
    counts: {
      ledgers: ledgers.length,
      stockItems: stockItems.length,
      costCenters: costCenters.length,
    },
  };
}

async function syncCompanyTransactionsByRange(input: {
  company: TallyCompanyForSync;
  dateRange: TallyDateRange;
  ledgers: any[];
}) {
  const { company, dateRange, ledgers } = input;

  console.log("[HISTORICAL SYNC] Range started", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
  });

  await markHistoricalSyncProgressInCrm({
    companyName: company.name,
    companyGuid: company.guid,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    status: "started",
  });

  try {
    /**
     * SALES VOUCHERS
     *
     * Important:
     * Tally XML date filter is not reliable in every company/report context.
     * So after parsing, we MUST locally filter by voucherDate.
     * Only in-range records should be uploaded to CRM.
     */
    upsertModuleProgress({
      moduleName: "sales-orders",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "fetching",
    });

    const salesOrdersXml = await fetchSalesOrdersXml(company.name, dateRange);
    const parsedSalesOrders = parseSalesOrders(String(salesOrdersXml || ""));

    const guardedSalesOrders = applyHistoricalRangeGuard({
      moduleName: "sales-orders",
      companyName: company.name,
      records: parsedSalesOrders,
      dateRange,
    });

    logHistoricalRangeGuardSummary(guardedSalesOrders);

    const salesOrders = attachCompany(
      guardedSalesOrders.inRangeRecords,
      company,
    );

    upsertModuleProgress({
      moduleName: "sales-orders",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "parsed",
      totalRecords: salesOrders.length,
      pendingRecords: salesOrders.length,
    });

    const salesOrderResult = await uploadHistoricalModule({
      moduleName: "sales-orders",
      company,
      records: salesOrders,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: process.env.BATCH_SIZE_SALES_ORDERS || 5,
      push: pushSalesOrdersToCrm,
    });

    /**
     * PURCHASE VOUCHERS
     */
    upsertModuleProgress({
      moduleName: "purchase-orders",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "fetching",
    });

    const purchaseOrdersXml = await fetchPurchaseOrdersXml(
      company.name,
      dateRange,
    );

    const parsedPurchaseOrders = parsePurchaseOrders(
      String(purchaseOrdersXml || ""),
    );

    const guardedPurchaseOrders = applyHistoricalRangeGuard({
      moduleName: "purchase-orders",
      companyName: company.name,
      records: parsedPurchaseOrders,
      dateRange,
    });

    logHistoricalRangeGuardSummary(guardedPurchaseOrders);

    const purchaseOrders = attachCompany(
      guardedPurchaseOrders.inRangeRecords,
      company,
    );

    upsertModuleProgress({
      moduleName: "purchase-orders",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "parsed",
      totalRecords: purchaseOrders.length,
      pendingRecords: purchaseOrders.length,
    });

    const purchaseOrderResult = await uploadHistoricalModule({
      moduleName: "purchase-orders",
      company,
      records: purchaseOrders,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: process.env.BATCH_SIZE_PURCHASE_ORDERS || 5,
      push: pushPurchaseOrdersToCrm,
    });

    /**
     * OUTSTANDINGS
     */
    upsertModuleProgress({
      moduleName: "outstandings",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "fetching",
    });

    const outstandingsXml = await fetchOutstandingsXml(company.name, dateRange);
    const parsedOutstandings = parseOutstandings(String(outstandingsXml || ""));

    const guardedOutstandings = applyHistoricalRangeGuard({
      moduleName: "outstandings",
      companyName: company.name,
      records: parsedOutstandings,
      dateRange,
    });

    logHistoricalRangeGuardSummary(guardedOutstandings);

    const outstandings = attachCompany(
      enrichOutstandingsWithLedgerGuid(
        guardedOutstandings.inRangeRecords,
        ledgers,
      ),
      company,
    );

    upsertModuleProgress({
      moduleName: "outstandings",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "parsed",
      totalRecords: outstandings.length,
      pendingRecords: outstandings.length,
    });

    const outstandingResult = await uploadHistoricalModule({
      moduleName: "outstandings",
      company,
      records: outstandings,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: process.env.BATCH_SIZE_OUTSTANDINGS || 5,
      push: pushOutstandingsToCrm,
    });

    /**
     * DELIVERY CHALLANS
     */
    upsertModuleProgress({
      moduleName: "delivery-challans",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "fetching",
    });

    const deliveryChallansXml = await fetchDeliveryChallansXml(
      company.name,
      dateRange,
    );

    const parsedDeliveryChallans = parseDeliveryChallans(
      String(deliveryChallansXml || ""),
    );

    const guardedDeliveryChallans = applyHistoricalRangeGuard({
      moduleName: "delivery-challans",
      companyName: company.name,
      records: parsedDeliveryChallans,
      dateRange,
    });

    logHistoricalRangeGuardSummary(guardedDeliveryChallans);

    const deliveryChallans = attachCompany(
      guardedDeliveryChallans.inRangeRecords,
      company,
    );

    upsertModuleProgress({
      moduleName: "delivery-challans",
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "parsed",
      totalRecords: deliveryChallans.length,
      pendingRecords: deliveryChallans.length,
    });

    const deliveryChallanResult = await uploadHistoricalModule({
      moduleName: "delivery-challans",
      company,
      records: deliveryChallans,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      batchSize: process.env.BATCH_SIZE_DELIVERY_CHALLANS || 5,
      push: pushDeliveryChallansToCrm,
    });

    await markHistoricalSyncProgressInCrm({
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "success",
    });

    completeRange({
      companyName: company.name,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
    });

    console.log("[HISTORICAL SYNC] Range completed", {
      company: company.name,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,

      salesOrdersRaw: guardedSalesOrders.parsedRecords.length,
      salesOrders: salesOrders.length,
      salesOrdersOutOfRange: guardedSalesOrders.outOfRangeRecords.length,
      salesOrdersWithoutDate: guardedSalesOrders.recordsWithoutDate.length,

      purchaseOrdersRaw: guardedPurchaseOrders.parsedRecords.length,
      purchaseOrders: purchaseOrders.length,
      purchaseOrdersOutOfRange: guardedPurchaseOrders.outOfRangeRecords.length,
      purchaseOrdersWithoutDate:
        guardedPurchaseOrders.recordsWithoutDate.length,

      outstandingsRaw: guardedOutstandings.parsedRecords.length,
      outstandings: outstandings.length,
      outstandingsOutOfRange: guardedOutstandings.outOfRangeRecords.length,
      outstandingsWithoutDate: guardedOutstandings.recordsWithoutDate.length,
    });

    return {
      dateRange,
      salesOrders: {
        rawCount: guardedSalesOrders.parsedRecords.length,
        count: salesOrders.length,
        outOfRange: guardedSalesOrders.outOfRangeRecords.length,
        withoutDate: guardedSalesOrders.recordsWithoutDate.length,
        result: salesOrderResult,
      },
      purchaseOrders: {
        rawCount: guardedPurchaseOrders.parsedRecords.length,
        count: purchaseOrders.length,
        outOfRange: guardedPurchaseOrders.outOfRangeRecords.length,
        withoutDate: guardedPurchaseOrders.recordsWithoutDate.length,
        result: purchaseOrderResult,
      },
      outstandings: {
        rawCount: guardedOutstandings.parsedRecords.length,
        count: outstandings.length,
        outOfRange: guardedOutstandings.outOfRangeRecords.length,
        withoutDate: guardedOutstandings.recordsWithoutDate.length,
        result: outstandingResult,
      },
      deliveryChallans: {
        rawCount: guardedDeliveryChallans.parsedRecords.length,
        count: deliveryChallans.length,
        outOfRange: guardedDeliveryChallans.outOfRangeRecords.length,
        withoutDate: guardedDeliveryChallans.recordsWithoutDate.length,
        result: deliveryChallanResult,
      },
    };
  } catch (error: any) {
    await markHistoricalSyncProgressInCrm({
      companyName: company.name,
      companyGuid: company.guid,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      status: "failed",
      errorMessage: error?.message || "Historical sync failed",
    });

    addSyncEvent({
      level: "error",
      message: `Range failed: ${dateRange.fromDate} to ${dateRange.toDate}`,
      companyName: company.name,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      details: error?.message || "Historical sync failed",
    });

    throw error;
  }
}

export async function runHistoricalSync(input?: HistoricalSyncRequest) {
  if (isHistoricalSyncRunning) {
    return {
      skipped: true,
      message: "Previous historical sync is still running",
    };
  }

  isHistoricalSyncRunning = true;

  const startedAt = new Date().toISOString();
  const request = normalizeHistoricalRequest(input);

  setHistoricalSyncStatus({
    status: "running",
    isRunning: true,
    startedAt,
    completedAt: null,
    error: null,
    request,
    lastResult: null,
  });

  try {
    console.log("[HISTORICAL SYNC] Started", {
      fromDate: request.fromDate || "TALLY_COMPANY_BOOKS_FROM",
      toDate: request.toDate,
      companyName: request.companyName || "ALL",
      forceRestart: request.forceRestart,
    });

    const companies = await getCompaniesForHistoricalSync();

    const selectedCompanies = request.companyName
      ? companies.filter(
          (company) =>
            normalizeName(company.name) === normalizeName(request.companyName),
        )
      : companies;

    if (!selectedCompanies.length) {
      const completedAt = new Date().toISOString();
      const result = {
        skipped: false,
        status: "empty",
        message: "No company found",
      };

      setHistoricalSyncStatus({
        status: "success",
        isRunning: false,
        completedAt,
        error: null,
        lastResult: result,
      });

      return result;
    }

    if (request.forceRestart) {
      for (const company of selectedCompanies) {
        clearHistoricalSyncCheckpoints({
          companyName: company.name,
          companyGuid: company.guid,
        });
      }

      addSyncEvent({
        level: "warn",
        message:
          "Historical sync checkpoints cleared because forceRestart=true",
        details: { companyName: request.companyName || "ALL" },
      });
    }

    const companyPlans = await buildHistoricalCompanyPlans({
      companies: selectedCompanies,
      request,
    });

    const rangesTotal = companyPlans.reduce(
      (sum, plan) => sum + plan.dateRanges.length,
      0,
    );

    startSyncProgress({
      mode: "historical",
      request,
      companiesTotal: selectedCompanies.length,
      rangesTotal,
    });

    seedHistoricalProgressModules({
      plans: companyPlans,
    });

    const companyResults = [];

    for (const [companyIndex, plan] of companyPlans.entries()) {
      const { company, dateRanges } = plan;

      setActiveCompany({
        index: companyIndex + 1,
        total: companyPlans.length,
        name: company.name,
        guid: company.guid,
      });

      const companyStartedAt = new Date().toISOString();

      console.log("[HISTORICAL SYNC] Company started", {
        company: company.name,
        guid: company.guid,
        fromDate: plan.fromDate,
        toDate: plan.toDate,
        ranges: dateRanges.length,
      });

      try {
        const masterResult = await syncCompanyMasters(company);

        const rangeResults = [];

        for (const [rangeIndex, dateRange] of dateRanges.entries()) {
          setActiveRange({
            index: rangeIndex + 1,
            total: dateRanges.length,
            fromDate: dateRange.fromDate,
            toDate: dateRange.toDate,
            companyName: company.name,
          });

          const result = await syncCompanyTransactionsByRange({
            company,
            dateRange,
            ledgers: masterResult.ledgers,
          });

          rangeResults.push(result);
        }

        const companyCompletedAt = new Date().toISOString();

        await updateTallySyncStateInCrm({
          companyName: company.name,
          companyGuid: company.guid,
          syncMode: "historical",
          startedAt: companyStartedAt,
          completedAt: companyCompletedAt,
          status: "success",
        });

        companyResults.push({
          company,
          fromDate: plan.fromDate,
          toDate: plan.toDate,
          masters: masterResult.counts,
          ranges: rangeResults,
        });

        completeCompany(company.name);

        console.log("[HISTORICAL SYNC] Company completed", {
          company: company.name,
          guid: company.guid,
        });
      } catch (error: any) {
        const companyCompletedAt = new Date().toISOString();

        await updateTallySyncStateInCrm({
          companyName: company.name,
          companyGuid: company.guid,
          syncMode: "historical",
          startedAt: companyStartedAt,
          completedAt: companyCompletedAt,
          status: "failed",
          errorMessage: error?.message || "Historical company sync failed",
        });

        throw error;
      }
    }

    const completedAt = new Date().toISOString();

    const result = {
      skipped: false,
      status: "success",
      message: "Historical sync completed",
      startedAt,
      completedAt,
      companies: {
        count: selectedCompanies.length,
        records: selectedCompanies,
      },
      plans: companyPlans.map((plan) => ({
        companyName: plan.company.name,
        companyGuid: plan.company.guid || null,
        fromDate: plan.fromDate,
        toDate: plan.toDate,
        ranges: plan.dateRanges.length,
      })),
      companyResults,
    };

    setHistoricalSyncStatus({
      status: "success",
      isRunning: false,
      completedAt,
      error: null,
      lastResult: result,
    });

    finishSyncProgress({
      status: "success",
      lastResult: result,
    });

    return result;
  } catch (error: any) {
    const completedAt = new Date().toISOString();

    setHistoricalSyncStatus({
      status: "failed",
      isRunning: false,
      completedAt,
      error: error?.message || "Historical sync failed",
      lastResult: null,
    });

    finishSyncProgress({
      status: "failed",
      error: error?.message || "Historical sync failed",
    });

    throw error;
  } finally {
    isHistoricalSyncRunning = false;
  }
}

export function startHistoricalSyncInBackground(input?: HistoricalSyncRequest) {
  if (isHistoricalSyncRunning) {
    return {
      started: false,
      message: "Previous historical sync is still running",
      data: getHistoricalSyncStatus(),
    };
  }

  const request = normalizeHistoricalRequest(input);

  void runHistoricalSync(request).catch((error: any) => {
    console.error("[HISTORICAL SYNC] Background run failed", error);
  });

  return {
    started: true,
    message: "Historical sync started",
    data: {
      ...getHistoricalSyncStatus(),
      request,
    },
  };
}
