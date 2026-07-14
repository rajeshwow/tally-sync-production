import { resolveConfiguredTallyCompanies } from "./company-registry";
import {
  pushDeliveryChallansToCrm,
  pushOutstandingsToCrm,
  pushPurchaseOrdersToCrm,
  pushSalesOrdersToCrm,
} from "./crm.client";

import {
  parseDeliveryChallans,
  parseOutstandings,
  parsePurchaseVouchers,
  parseSalesVouchers,
} from "./mapper";

import {
  clearHistoricalSyncCheckpoints,
  getSyncCheckpoint,
  markSyncCheckpoint,
} from "./sync-checkpoint.store";

import {
  fetchHistoricalDeliveryChallansXml,
  fetchHistoricalOutstandingVouchersXml,
  fetchHistoricalPurchaseVouchersXml,
  fetchHistoricalSalesVouchersXml,
  fetchTallyCompaniesXml,
  postToTally,
  type TallyDateRange,
} from "./tally.client";

type HistoricalTransactionModule =
  | "sales-vouchers"
  | "purchase-vouchers"
  | "outstandings"
  | "delivery-challans";

type HistoricalTransactionsRequest = {
  /** Optional. Tally date format YYYYMMDD. If missing, company BooksFrom/StartingFrom will be used. */
  fromDate?: string;
  /** Optional. Tally date format YYYYMMDD. Defaults to today. */
  toDate?: string;
  /** Optional. If missing, all loaded Tally companies will run. */
  companyName?: string;
  /** Optional. GUID is preferred when the caller already resolved the current company. */
  companyGuid?: string;
  /** Internal use for opened-company daily sync; prevents stale .env allowlist from overriding it. */
  skipConfiguredAllowlist?: boolean;
  /**
   * Optional module filter.
   * Accepted: sales-vouchers, purchase-vouchers, outstandings
   */
  modules?: HistoricalTransactionModule[];
  /** Optional. Clears successful checkpoints for selected module/company before running. */
  forceRestart?: boolean;
  skipCheckpoints?: boolean;
  syncMode?: "historical" | "incremental";
};

type TallyCompanyForTransactions = {
  name: string;
  guid?: string | null;
  booksFrom?: string | null;
  startingFrom?: string | null;
};

type HistoricalTransactionsStatus = {
  status: "idle" | "running" | "success" | "partial_success" | "failed";
  isRunning: boolean;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  request: {
    fromDate: string | null;
    toDate: string;
    companyName: string;
    modules: HistoricalTransactionModule[];
  } | null;
  activeCompany: string | null;
  activeModule: HistoricalTransactionModule | null;
  activeRange: TallyDateRange | null;
  summary: {
    companiesTotal: number;
    companiesCompleted: number;
    modulesTotal: number;
    modulesCompleted: number;
    rangesTotal: number;
    rangesCompleted: number;
    pulledRecords: number;
    uploadedRecords: number;
    skippedDuplicateRecords: number;
    skippedCheckpointRanges: number;
    failedRanges: number;
    outstandingReceivableRows: number;
    outstandingPayableRows: number;
  };
  events: Array<{
    at: string;
    level: "info" | "warn" | "error";
    message: string;
    details?: any;
  }>;
  lastResult: any;
};

type OfficialOutstandingReportType = "receivable" | "payable";

let isHistoricalTransactionsRunning = false;

const DEFAULT_MODULES: HistoricalTransactionModule[] = [
  "sales-vouchers",
  "purchase-vouchers",
  "outstandings",
  "delivery-challans",
];

const historicalTransactionsStatus: HistoricalTransactionsStatus = {
  status: "idle",
  isRunning: false,
  startedAt: null,
  completedAt: null,
  error: null,
  request: null,
  activeCompany: null,
  activeModule: null,
  activeRange: null,
  summary: {
    companiesTotal: 0,
    companiesCompleted: 0,
    modulesTotal: 0,
    modulesCompleted: 0,
    rangesTotal: 0,
    rangesCompleted: 0,
    pulledRecords: 0,
    uploadedRecords: 0,
    skippedDuplicateRecords: 0,
    skippedCheckpointRanges: 0,
    failedRanges: 0,
    outstandingReceivableRows: 0,
    outstandingPayableRows: 0,
  },
  events: [],
  lastResult: null,
};

function nowIso() {
  return new Date().toISOString();
}

function safeStringify(details?: any) {
  if (details === undefined || details === null) return "";

  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTallyRetryAttempts() {
  return Math.max(1, Number(process.env.TALLY_RETRY_ATTEMPTS || 3));
}

async function runWithTallyRetry<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const maxAttempts = getTallyRetryAttempts();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const message = error?.message || "Tally request failed";
      const isLastAttempt = attempt >= maxAttempts;

      addEvent(isLastAttempt ? "error" : "warn", `${label} failed`, {
        attempt,
        maxAttempts,
        message,
        code: error?.code || null,
      });

      if (isLastAttempt) {
        throw error;
      }

      await sleep(1000 * attempt);
    }
  }

  throw new Error(`${label} failed after retry`);
}

function formatLogRange(details?: any) {
  const fromDate = String(details?.fromDate || "");
  const toDate = String(details?.toDate || "");

  if (!fromDate && !toDate) return "";
  if (fromDate === "NO_DATE" || toDate === "NO_DATE") return "NO_DATE";

  const from = normalizeTallyDate(fromDate);
  const to = normalizeTallyDate(toDate);

  if (!from || !to) return `${fromDate || "-"} → ${toDate || "-"}`;

  const monthLabel = `${from.slice(0, 4)}-${from.slice(4, 6)}`;

  return `${monthLabel} (${from} → ${to})`;
}

function formatLogNumber(value: any) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function formatLogAmount(value: any) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return "0";
  return num.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  });
}

function buildCleanConsoleLog(
  level: "info" | "warn" | "error",
  message: string,
  details?: any,
) {
  const icon = level === "error" ? "❌" : level === "warn" ? "⚠️" : "✅";

  const range = formatLogRange(details);

  /**
   * Hide noisy start logs. Status API still keeps these events.
   */
  if (
    [
      "Sales voucher range started",
      "Purchase voucher range started",
      "Outstanding receivable report fetch started",
      "Outstanding payable report fetch started",
    ].includes(message)
  ) {
    return null;
  }

  if (message === "Historical transaction sync started") {
    return `🚀 Historical TX started | modules=${(details?.modules || []).join(", ") || "all"} | outstanding=official-report`;
  }

  if (message === "Loaded Tally companies found") {
    return `✅ Companies loaded | count=${details?.companies?.length || 0}`;
  }

  if (message === "Company transaction sync started") {
    return `▶️ Company sync started | from=${details?.fromDate || "-"} | to=${details?.toDate || "-"} | ranges=${details?.salesPurchaseRanges || 0} | chunkMonths=${details?.rangeMonths || 1}`;
  }

  if (message === "Transaction range started") {
    return `📅 Range started | ${range}`;
  }

  if (message === "Historical transaction range skipped by checkpoint") {
    return `⏭️ Skipped | ${details?.moduleName || "-"} | ${range} | alreadyUploaded=${formatLogNumber(details?.uploadedRecords)}`;
  }

  if (
    message === "Historical transaction range failed but sync will continue"
  ) {
    return `❌ Range failed | ${details?.moduleName || "-"} | ${range} | continuing | error=${details?.error || "unknown"}`;
  }

  if (message === "Historical checkpoints cleared") {
    return `🧹 Checkpoints cleared | modules=${(details?.modules || []).join(", ") || "-"} | company=${details?.companyName || "ALL"}`;
  }

  if (message === "Sales voucher range collected") {
    return `✅ SO collected | ${range} | raw=${formatLogNumber(details?.raw)} | inRange=${formatLogNumber(details?.inRange)} | push=${formatLogNumber(details?.pushRecords)} | dup=${formatLogNumber(details?.duplicates)}`;
  }

  if (message === "Sales voucher range pushed") {
    return `✅ SO pushed    | ${range} | pushed=${formatLogNumber(details?.pushed)} | uploaded=${formatLogNumber(details?.uploaded)} | batches=${formatLogNumber(details?.batches)}`;
  }

  if (message === "Purchase voucher range collected") {
    return `✅ PO collected | ${range} | raw=${formatLogNumber(details?.raw)} | inRange=${formatLogNumber(details?.inRange)} | push=${formatLogNumber(details?.pushRecords)} | dup=${formatLogNumber(details?.duplicates)}`;
  }

  if (message === "Purchase voucher range pushed") {
    return `✅ PO pushed    | ${range} | pushed=${formatLogNumber(details?.pushed)} | uploaded=${formatLogNumber(details?.uploaded)} | batches=${formatLogNumber(details?.batches)}`;
  }

  if (message === "Transaction range completed") {
    return `✅ Range done   | ${range} | SO=${details?.salesParsed ?? "-"} | PO=${details?.purchaseParsed ?? "-"}`;
  }

  if (message === "Official outstanding report sync started") {
    return `▶️ Outstanding started | source=Bills Receivable + Bills Payable`;
  }

  if (message === "Official outstanding reports parsed") {
    return `✅ Outstanding parsed | receivable=${formatLogNumber(details?.receivableRows)} | payable=${formatLogNumber(details?.payableRows)}`;
  }

  if (message === "Official outstanding monthly buckets prepared") {
    return `✅ Outstanding buckets | raw=${formatLogNumber(details?.rawRows)} | push=${formatLogNumber(details?.totalRows)} | dateFiltered=${formatLogNumber(details?.dateGuardExcludedRows)} | buckets=${details?.buckets?.length || 0} | dup=${formatLogNumber(details?.duplicates)}`;
  }

  if (message === "Outstanding range collected") {
    return `✅ OS collected | ${range} | receivable=${formatLogNumber(details?.receivable)} | payable=${formatLogNumber(details?.payable)} | total=${formatLogNumber(details?.total)} | amount=${formatLogAmount(details?.amount)}`;
  }

  if (message === "Outstanding range pushed") {
    return `✅ OS pushed    | ${range} | pushed=${formatLogNumber(details?.pushed)} | uploaded=${formatLogNumber(details?.uploaded)} | batches=${formatLogNumber(details?.batches)}`;
  }

  if (message === "Company transaction sync completed") {
    return `🏁 Company done | SO uploaded=${formatLogNumber(details?.salesUploaded)} | PO uploaded=${formatLogNumber(details?.purchaseUploaded)} | OS uploaded=${formatLogNumber(details?.outstandingUploaded)}`;
  }

  if (message === "Historical transaction sync completed") {
    return `✅ SUCCESS | Historical TX completed | pulled=${formatLogNumber(details?.summary?.pulledRecords)} | uploaded=${formatLogNumber(details?.summary?.uploadedRecords)} | skipped=${formatLogNumber(details?.summary?.skippedCheckpointRanges)} | duplicates=${formatLogNumber(details?.summary?.skippedDuplicateRecords)}`;
  }

  if (message === "Historical transaction sync completed with failures") {
    return `⚠️ PARTIAL | Historical TX completed with failures | failed=${formatLogNumber(details?.failed)} | pulled=${formatLogNumber(details?.summary?.pulledRecords)} | uploaded=${formatLogNumber(details?.summary?.uploadedRecords)} | skipped=${formatLogNumber(details?.summary?.skippedCheckpointRanges)}`;
  }

  if (level === "error") {
    return `❌ ${message} | module=${details?.activeModule || "-"} | range=${formatLogRange(details?.activeRange)} | error=${details?.error || "unknown"}`;
  }

  if (level === "warn") {
    return `⚠️ ${message} | ${details?.message || details?.error || ""}`;
  }

  return `${icon} ${message}`;
}

function addEvent(
  level: "info" | "warn" | "error",
  message: string,
  details?: any,
) {
  const line = buildCleanConsoleLog(level, message, details);

  if (line) {
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  historicalTransactionsStatus.events.unshift({
    at: nowIso(),
    level,
    message,
    details,
  });

  historicalTransactionsStatus.events =
    historicalTransactionsStatus.events.slice(0, 150);
}

function patchStatus(patch: Partial<HistoricalTransactionsStatus>) {
  Object.assign(historicalTransactionsStatus, patch);
  return getHistoricalTransactionsSyncStatus();
}

function escapeXml(value: any) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value: string) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, `"`)
    .replace(/&apos;/g, "'")
    .replace(/&#x?[0-9a-fA-F]+;/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
}

function readTag(block: string, tag: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(block || "").match(
    new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, "i"),
  );

  return decodeXml(match?.[1]?.trim() || "");
}

function readAttr(block: string, tag: string, attr: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(block || "").match(
    new RegExp(`<${escapedTag}\\b[^>]*\\b${escapedAttr}="([^"]*)"`, "i"),
  );

  return decodeXml(match?.[1]?.trim() || "");
}

function stripXml(value: any) {
  return decodeXml(String(value || "").replace(/<[^>]+>/g, ""))
    .replace(/Not Applicable/gi, "")
    .replace(/Not Found/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCompanies(xml: string): TallyCompanyForTransactions[] {
  const blocks = String(xml || "").match(/<COMPANY[\s\S]*?<\/COMPANY>/gi) || [];

  const companies = blocks
    .map((block) => ({
      name: readAttr(block, "COMPANY", "NAME") || readTag(block, "NAME"),
      guid: readTag(block, "GUID") || null,
      booksFrom: readTag(block, "BOOKSFROM") || null,
      startingFrom: readTag(block, "STARTINGFROM") || null,
    }))
    .filter((company) => Boolean(company.name));

  const unique = new Map<string, TallyCompanyForTransactions>();

  for (const company of companies) {
    const key = normalizeName(company.guid || company.name);
    if (!unique.has(key)) unique.set(key, company);
  }

  return Array.from(unique.values());
}

function parseEnvCompanies(): TallyCompanyForTransactions[] {
  return String(process.env.TALLY_COMPANIES || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, guid: null }));
}

async function getCompaniesForSync(selection: {
  companyName?: string | null;
  companyGuid?: string | null;
  skipConfiguredAllowlist?: boolean;
} = {}): Promise<TallyCompanyForTransactions[]> {
  const companies = await resolveConfiguredTallyCompanies(selection);

  addEvent("info", "Tally companies resolved for sync", {
    companies: companies.map((company) => ({
      name: company.name,
      guid: company.guid || null,
      booksFrom: company.booksFrom || null,
      startingFrom: company.startingFrom || null,
    })),
  });

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

  const textDate = raw.match(
    /^(\d{1,2})[-/\s]+([a-zA-Z]{3,9})[-/\s]+(\d{2,4})$/,
  );

  if (textDate) {
    const day = textDate[1].padStart(2, "0");
    const month = monthMap[textDate[2].toLowerCase()];
    let year = Number(textDate[3]);

    if (!month) return null;
    if (year < 100) year = year >= 70 ? 1900 + year : 2000 + year;
    if (year > 1900) return `${year}${month}${day}`;
  }

  const compact = raw.replace(/[^0-9]/g, "");

  if (/^\d{8}$/.test(compact)) {
    if (Number(compact.slice(0, 4)) > 1900) return compact;
    return `${compact.slice(4, 8)}${compact.slice(2, 4)}${compact.slice(0, 2)}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return formatTallyDate(parsed);

  return null;
}

function parseTallyDate(value: string): Date {
  const normalized = normalizeTallyDate(value);

  if (!normalized) {
    throw new Error(`Invalid Tally date: ${value}`);
  }

  return new Date(
    Number(normalized.slice(0, 4)),
    Number(normalized.slice(4, 6)) - 1,
    Number(normalized.slice(6, 8)),
  );
}

function formatTallyDate(date: Date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}${String(date.getDate()).padStart(2, "0")}`;
}

function formatIsoDate(value?: string | null) {
  const normalized = normalizeTallyDate(value);
  if (!normalized) return null;

  return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(
    6,
    8,
  )}`;
}

function todayTallyDate() {
  return formatTallyDate(new Date());
}

function toTallyDisplayDate(value?: string | null) {
  const normalized = normalizeTallyDate(value);
  if (!normalized) return "";

  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const day = Number(normalized.slice(6, 8));
  const month = Number(normalized.slice(4, 6));
  const year = normalized.slice(0, 4);

  return `${day}-${monthNames[month - 1]}-${year}`;
}

function getCompanyStartDate(company: TallyCompanyForTransactions) {
  return (
    normalizeTallyDate(company.booksFrom) ||
    normalizeTallyDate(company.startingFrom) ||
    normalizeTallyDate(process.env.HISTORICAL_TRANSACTION_FALLBACK_FROM_DATE) ||
    normalizeTallyDate(process.env.HISTORICAL_SYNC_SCAN_FROM_DATE) ||
    "20000401"
  );
}

function getRangeChunkMonths() {
  return Math.max(
    1,
    Number(process.env.HISTORICAL_TRANSACTION_RANGE_MONTHS || 1),
  );
}

function buildDateRanges(input: {
  fromDate: string;
  toDate: string;
  chunkMonths?: number;
}): TallyDateRange[] {
  const fromDate = parseTallyDate(input.fromDate);
  const toDate = parseTallyDate(input.toDate);
  const chunkMonths = Math.max(1, Number(input.chunkMonths || 1));

  if (fromDate > toDate) {
    throw new Error(
      `Historical transaction fromDate cannot be greater than toDate: ${input.fromDate} > ${input.toDate}`,
    );
  }

  const ranges: TallyDateRange[] = [];
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

function buildDateRangesFromRecords(
  records: any[],
): Array<TallyDateRange & { key: string }> {
  const dates = (records || [])
    .map((record) =>
      normalizeTallyDate(record?.voucherDate || record?.billDate),
    )
    .filter(Boolean)
    .sort() as string[];

  if (!dates.length) return [];

  const minDate = parseTallyDate(dates[0]);
  const maxDate = parseTallyDate(dates[dates.length - 1]);

  return buildDateRanges({
    fromDate: formatTallyDate(minDate),
    toDate: formatTallyDate(maxDate),
    chunkMonths: 1,
  }).map((range) => ({
    ...range,
    key: range.fromDate.slice(0, 6),
  }));
}

function getRecordDate(record: any): string | null {
  return normalizeTallyDate(
    record?.voucherDate ||
      record?.voucher_date ||
      record?.date ||
      record?.billDate ||
      record?.bill_date,
  );
}

function filterByRange(records: any[], dateRange: TallyDateRange) {
  const inRange: any[] = [];
  const outOfRange: any[] = [];
  const withoutDate: any[] = [];

  for (const record of Array.isArray(records) ? records : []) {
    const recordDate = getRecordDate(record);

    if (!recordDate) {
      withoutDate.push(record);
      continue;
    }

    if (recordDate >= dateRange.fromDate && recordDate <= dateRange.toDate) {
      inRange.push(record);
    } else {
      outOfRange.push(record);
    }
  }

  return { inRange, outOfRange, withoutDate };
}

function normalizeVoucherType(value?: string | null) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isSalesVoucher(record: any) {
  const type = normalizeVoucherType(record?.voucherType || record?.voucher_type_name || record?.voucherTypeName);
  return !type.includes("order");
}

function isPurchaseVoucher(record: any) {
  const type = normalizeVoucherType(record?.voucherType || record?.voucher_type_name || record?.voucherTypeName);
  return !type.includes("order");
}

function attachCompany<T extends Record<string, any>>(
  records: T[],
  company: TallyCompanyForTransactions,
): T[] {
  return records.map((record) => ({
    ...record,
    tallyCompanyName: company.name,
    tallyCompanyGuid: company.guid || null,
    tally_company_name: company.name,
    tally_company_guid: company.guid || null,
    syncStrategy: "historical_transactions",
    sync_strategy: "historical_transactions",
  }));
}

function toNumber(value?: string | number | null) {
  if (value === undefined || value === null || value === "") return 0;

  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");

  const num = Number(cleaned);

  return Number.isFinite(num) ? num : 0;
}

function toAbsNumber(value?: string | number | null) {
  return Math.abs(toNumber(value));
}

function getVoucherDedupeKey(
  record: any,
  company: TallyCompanyForTransactions,
) {
  const companyKey = company.guid || company.name;
  const type =
    record?.voucherType ||
    record?.voucher_type_name ||
    record?.voucherTypeName ||
    "";
  const guid =
    record?.voucherGuid ||
    record?.voucher_guid ||
    record?.tallyGuid ||
    record?.tally_guid ||
    record?.guid ||
    "";
  const voucherKey = record?.voucherKey || record?.voucher_key || "";
  const voucherNo =
    record?.voucherNumber || record?.voucher_number || record?.voucherNo || "";
  const voucherDate = getRecordDate(record) || "";
  const party = record?.partyName || record?.party_name || "";
  const amount =
    record?.totalAmount || record?.total_amount || record?.amount || "";

  return [
    normalizeName(companyKey),
    normalizeName(type),
    normalizeName(
      guid || voucherKey || `${voucherNo}|${voucherDate}|${party}|${amount}`,
    ),
  ].join("::");
}

function getOutstandingDedupeKey(
  record: any,
  company: TallyCompanyForTransactions,
) {
  const companyKey = company.guid || company.name;

  return [
    normalizeName(companyKey),
    normalizeName(record?.billType || record?.bill_type || ""),
    normalizeName(record?.ledgerName || record?.ledger_name || ""),
    normalizeName(record?.billRef || record?.bill_ref || ""),
  ].join("::");
}

function uniqueBy<T>(
  records: T[],
  getKey: (record: T) => string,
): { records: T[]; duplicateCount: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicateCount = 0;

  for (const record of Array.isArray(records) ? records : []) {
    const key = getKey(record);

    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(key);
    unique.push(record);
  }

  return { records: unique, duplicateCount };
}

function getErrorMessage(error: any) {
  return (
    error?.response?.data?.message ||
    error?.response?.data?.error ||
    error?.message ||
    "Unknown error"
  );
}

function getResultTotalRecords(result: any) {
  return Number(result?.pushed ?? result?.parsed ?? result?.inRange ?? 0) || 0;
}

function getResultUploadedRecords(result: any) {
  return Number(result?.uploaded ?? result?.uploadedRecords ?? 0) || 0;
}

async function runCheckpointedTxRange(input: {
  company: TallyCompanyForTransactions;
  moduleName: HistoricalTransactionModule;
  dateRange: TallyDateRange;
  run: () => Promise<any>;
  skipCheckpoint?: boolean;
}) {
  const checkpointBase = {
    mode: "historical" as const,
    companyName: input.company.name,
    companyGuid: input.company.guid || null,
    moduleName: input.moduleName,
    fromDate: input.dateRange.fromDate,
    toDate: input.dateRange.toDate,
  };

  if (input.skipCheckpoint && input.moduleName !== "outstandings") {
    try {
      return { status: "success" as const, result: await input.run(), error: null, checkpoint: null };
    } catch (error: any) {
      const message = getErrorMessage(error);
      historicalTransactionsStatus.summary.failedRanges += 1;
      return { status: "failed" as const, result: null, error: message, checkpoint: null };
    }
  }

  if (input.moduleName === "outstandings") {
    try {
      const result = await input.run();

      return {
        status: "success" as const,
        result,
        error: null,
        checkpoint: null,
      };
    } catch (error: any) {
      const message = getErrorMessage(error);

      historicalTransactionsStatus.summary.failedRanges += 1;

      addEvent(
        "error",
        "Historical outstanding snapshot failed but sync will continue",
        {
          company: input.company.name,
          moduleName: input.moduleName,
          fromDate: input.dateRange.fromDate,
          toDate: input.dateRange.toDate,
          error: message,
        },
      );

      return {
        status: "failed" as const,
        result: null,
        error: message,
        checkpoint: null,
      };
    }
  }

  const existing = getSyncCheckpoint(checkpointBase);

  if (existing?.status === "success") {
    historicalTransactionsStatus.summary.skippedCheckpointRanges += 1;

    addEvent("info", "Historical transaction range skipped by checkpoint", {
      company: input.company.name,
      moduleName: input.moduleName,
      fromDate: input.dateRange.fromDate,
      toDate: input.dateRange.toDate,
      uploadedRecords: existing.uploadedRecords || 0,
    });

    return {
      status: "skipped" as const,
      result: null,
      error: null,
      checkpoint: existing,
    };
  }

  markSyncCheckpoint({
    ...checkpointBase,
    status: "running",
    totalRecords: existing?.totalRecords || 0,
    uploadedRecords: existing?.uploadedRecords || 0,
    failedRecords: existing?.failedRecords || 0,
    startedAt: nowIso(),
    completedAt: null,
    errorMessage: null,
  });

  try {
    const result = await input.run();
    const totalRecords = getResultTotalRecords(result);
    const uploadedRecords = getResultUploadedRecords(result);

    markSyncCheckpoint({
      ...checkpointBase,
      status: "success",
      totalRecords,
      uploadedRecords,
      failedRecords: 0,
      completedAt: nowIso(),
      errorMessage: null,
    });

    return {
      status: "success" as const,
      result,
      error: null,
      checkpoint: null,
    };
  } catch (error: any) {
    const message = getErrorMessage(error);

    historicalTransactionsStatus.summary.failedRanges += 1;

    markSyncCheckpoint({
      ...checkpointBase,
      status: "failed",
      totalRecords: existing?.totalRecords || 0,
      uploadedRecords: existing?.uploadedRecords || 0,
      failedRecords: 1,
      completedAt: nowIso(),
      errorMessage: message,
    });

    addEvent(
      "error",
      "Historical transaction range failed but sync will continue",
      {
        company: input.company.name,
        moduleName: input.moduleName,
        fromDate: input.dateRange.fromDate,
        toDate: input.dateRange.toDate,
        error: message,
      },
    );

    return {
      status: "failed" as const,
      result: null,
      error: message,
      checkpoint: null,
    };
  }
}

function getEnabledModules(
  modules?: HistoricalTransactionModule[],
): HistoricalTransactionModule[] {
  if (!Array.isArray(modules) || !modules.length) return DEFAULT_MODULES;

  const allowed = new Set(DEFAULT_MODULES);
  const normalized = modules.filter((moduleName) => allowed.has(moduleName));

  return normalized.length ? normalized : DEFAULT_MODULES;
}

function shouldFilterOfficialOutstandingByToDate() {
  return (
    String(process.env.OUTSTANDING_REPORT_FILTER_TO_DATE || "false")
      .trim()
      .toLowerCase() === "true"
  );
}

function buildOfficialOutstandingReportXml(input: {
  companyName?: string | null;
  reportType: OfficialOutstandingReportType;
  fromDate: string;
  toDate: string;
}) {
  const reportName =
    input.reportType === "receivable" ? "Bills Receivable" : "Bills Payable";

  const fromDisplay = toTallyDisplayDate(input.fromDate);
  const toDisplay = toTallyDisplayDate(input.toDate);

  return `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>${escapeXml(reportName)}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        ${
          input.companyName
            ? `<SVCURRENTCOMPANY>${escapeXml(input.companyName)}</SVCURRENTCOMPANY>`
            : ""
        }

        <SVFROMDATE TYPE="Date">${escapeXml(fromDisplay)}</SVFROMDATE>
        <SVTODATE TYPE="Date">${escapeXml(toDisplay)}</SVTODATE>
        <SVCURRENTDATE TYPE="Date">${escapeXml(toDisplay)}</SVCURRENTDATE>

        <SVFromDate TYPE="Date">${escapeXml(fromDisplay)}</SVFromDate>
        <SVToDate TYPE="Date">${escapeXml(toDisplay)}</SVToDate>
        <SVCurrentDate TYPE="Date">${escapeXml(toDisplay)}</SVCurrentDate>

        <EXPLODEFLAG>Yes</EXPLODEFLAG>
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>
`.trim();
}

async function fetchOfficialOutstandingReportXml(input: {
  companyName?: string | null;
  reportType: OfficialOutstandingReportType;
  fromDate: string;
  toDate: string;
}) {
  const reportName =
    input.reportType === "receivable" ? "Bills Receivable" : "Bills Payable";

  addEvent("info", `Outstanding ${input.reportType} report fetch started`, {
    company: input.companyName || "CURRENT_COMPANY",
    reportName,
    fromDate: input.fromDate,
    toDate: input.toDate,
  });

  const xml = buildOfficialOutstandingReportXml(input);

  return runWithTallyRetry(
    `Official outstanding ${input.reportType} report fetch`,
    () => postToTally(xml),
  );
}

function parseOfficialBillWiseOutstandingReport(input: {
  xml: string;
  billType: OfficialOutstandingReportType;
  company: TallyCompanyForTransactions;
}) {
  const source = String(input.xml || "").replace(/\u0000/g, "");
  const rows: any[] = [];

  /**
   * RDP Tally official Bills Receivable/Payable report can return:
   *
   * <BILLFIXED>...</BILLFIXED>
   * <CCM_BILL...></CCM_BILL...>
   * <BILLCL>...</BILLCL>
   * <BILLDUE>...</BILLDUE>
   * <BILLOVERDUE>...</BILLOVERDUE>
   *
   * So do not expect BILLCL directly after BILLFIXED.
   */
  const segments =
    source.match(/<BILLFIXED\b[\s\S]*?(?=<BILLFIXED\b|<\/ENVELOPE>|$)/gi) || [];

  for (const segment of segments) {
    const fixedBlock =
      segment.match(/<BILLFIXED\b[\s\S]*?<\/BILLFIXED>/i)?.[0] || segment;

    const ledgerName = stripXml(readTag(fixedBlock, "BILLPARTY"));
    const billRef = stripXml(readTag(fixedBlock, "BILLREF"));
    const billDateRaw = stripXml(readTag(fixedBlock, "BILLDATE"));

    const billCloseRaw =
      stripXml(readTag(segment, "BILLCL")) ||
      stripXml(readTag(segment, "BILLCLOSING")) ||
      stripXml(readTag(segment, "CLOSINGBALANCE")) ||
      stripXml(readTag(segment, "PENDINGAMOUNT"));

    const dueDateRaw =
      stripXml(readTag(segment, "BILLDUE")) ||
      stripXml(readTag(segment, "BILLDUEDATE")) ||
      stripXml(readTag(segment, "DUEDATE"));

    const overdueDaysRaw = stripXml(readTag(segment, "BILLOVERDUE"));

    const pendingAmount = toAbsNumber(billCloseRaw);
    const billDate = normalizeTallyDate(billDateRaw);
    const dueDate = normalizeTallyDate(dueDateRaw) || billDate;

    if (!ledgerName || !billRef || pendingAmount <= 0) {
      continue;
    }

    rows.push({
      ledgerName,
      ledgerGuid: null,

      voucherGuid: null,
      voucherNo: billRef,
      voucherNumber: billRef,
      voucherType:
        input.billType === "receivable" ? "Bills Receivable" : "Bills Payable",

      voucherDate: formatIsoDate(billDate),
      dueDate: formatIsoDate(dueDate),

      billType: input.billType,
      openingAmount: pendingAmount,
      billAmount: pendingAmount,
      pendingAmount,
      outstandingAmount: pendingAmount,

      costCenterName: null,
      cost_center_name: null,
      costCategory: null,
      cost_category: null,
      costCenterAmount: 0,
      cost_center_amount: 0,
      costCenterAllocations: [],
      cost_center_allocations: [],

      overdueDays: toAbsNumber(overdueDaysRaw),
      drCr: toNumber(billCloseRaw) < 0 ? "Cr" : "Dr",
      partyType: null,

      tallyGuid: null,
      tally_guid: null,

      ledger_guid: null,
      ledger_name: ledgerName,

      voucher_guid: null,
      voucher_number: billRef,
      voucher_no: billRef,

      voucherTypeName:
        input.billType === "receivable" ? "Bills Receivable" : "Bills Payable",
      voucher_type_name:
        input.billType === "receivable" ? "Bills Receivable" : "Bills Payable",

      voucher_date: formatIsoDate(billDate),
      due_date: formatIsoDate(dueDate),

      bill_ref: billRef,
      bill_type: input.billType,

      reportName:
        input.billType === "receivable" ? "Bills Receivable" : "Bills Payable",
      report_name:
        input.billType === "receivable" ? "Bills Receivable" : "Bills Payable",

      rawTallyData: segment,
      raw_tally_data: segment,

      tallyCompanyName: input.company.name,
      tallyCompanyGuid: input.company.guid || null,
      tally_company_name: input.company.name,
      tally_company_guid: input.company.guid || null,
    });
  }

  return rows;
}

function applyOfficialOutstandingDateGuard(input: {
  records: any[];
  fromDate: string;
  toDate: string;
}) {
  const shouldFilterToDate = shouldFilterOfficialOutstandingByToDate();

  return (input.records || []).filter((record) => {
    const billDate = normalizeTallyDate(
      record?.voucherDate || record?.billDate,
    );

    if (!billDate) return true;

    /**
     * Bills Receivable / Bills Payable is an outstanding snapshot as of the
     * selected Tally date. An older invoice can still be pending today, so it
     * must not be removed only because its bill date is before fromDate.
     *
     * Optional future-date filtering is retained through
     * OUTSTANDING_REPORT_FILTER_TO_DATE=true.
     */
    if (shouldFilterToDate && billDate > input.toDate) return false;

    return true;
  });
}

function groupOutstandingRecordsByMonth(records: any[]) {
  const ranges = buildDateRangesFromRecords(records);
  const result: Array<TallyDateRange & { records: any[]; key: string }> = [];

  for (const range of ranges) {
    result.push({
      ...range,
      records: (records || []).filter((record) => {
        const date = normalizeTallyDate(
          record?.voucherDate || record?.billDate,
        );
        return Boolean(date && date >= range.fromDate && date <= range.toDate);
      }),
    });
  }

  const withoutDate = (records || []).filter(
    (record) => !normalizeTallyDate(record?.voucherDate || record?.billDate),
  );

  if (withoutDate.length) {
    result.push({
      fromDate: "NO_DATE",
      toDate: "NO_DATE",
      key: "NO_DATE",
      records: withoutDate,
    } as any);
  }

  return result;
}

function groupVoucherRecordsByRanges(records: any[], ranges: TallyDateRange[]) {
  return ranges.map((range) => ({
    ...range,
    key: range.fromDate.slice(0, 6),
    records: (records || []).filter((record) => {
      const date = getRecordDate(record);
      return Boolean(date && date >= range.fromDate && date <= range.toDate);
    }),
  }));
}

async function collectSalesVouchersForCompany(input: {
  company: TallyCompanyForTransactions;
  fromDate: string;
  toDate: string;
  ranges: TallyDateRange[];
}) {
  const { company, fromDate, toDate, ranges } = input;

  historicalTransactionsStatus.activeModule = "sales-vouchers";
  historicalTransactionsStatus.activeRange = { fromDate, toDate };

  const xml = await runWithTallyRetry(
    `Sales voucher full period ${company.name} ${fromDate}-${toDate}`,
    () => fetchHistoricalSalesVouchersXml(company.name, { fromDate, toDate }),
  );

  const parsed = parseSalesVouchers(String(xml || "")).filter(isSalesVoucher);
  const guarded = filterByRange(parsed, { fromDate, toDate });
  const withCompany = attachCompany(guarded.inRange, company);
  const unique = uniqueBy(withCompany, (record) =>
    getVoucherDedupeKey(record, company),
  );

  historicalTransactionsStatus.summary.pulledRecords += parsed.length;
  historicalTransactionsStatus.summary.skippedDuplicateRecords +=
    unique.duplicateCount;

  addEvent("info", "Sales voucher full period collected", {
    company: company.name,
    fromDate,
    toDate,
    raw: parsed.length,
    inRange: guarded.inRange.length,
    outOfRange: guarded.outOfRange.length,
    withoutDate: guarded.withoutDate.length,
    duplicates: unique.duplicateCount,
    pushRecords: unique.records.length,
  });

  return {
    parsed: parsed.length,
    inRange: guarded.inRange.length,
    outOfRange: guarded.outOfRange.length,
    withoutDate: guarded.withoutDate.length,
    duplicates: unique.duplicateCount,
    records: unique.records,
    buckets: groupVoucherRecordsByRanges(unique.records, ranges),
  };
}

async function collectPurchaseVouchersForCompany(input: {
  company: TallyCompanyForTransactions;
  fromDate: string;
  toDate: string;
  ranges: TallyDateRange[];
}) {
  const { company, fromDate, toDate, ranges } = input;

  historicalTransactionsStatus.activeModule = "purchase-vouchers";
  historicalTransactionsStatus.activeRange = { fromDate, toDate };

  const xml = await runWithTallyRetry(
    `Purchase voucher full period ${company.name} ${fromDate}-${toDate}`,
    () =>
      fetchHistoricalPurchaseVouchersXml(company.name, { fromDate, toDate }),
  );

  const parsed = parsePurchaseVouchers(String(xml || "")).filter(
    isPurchaseVoucher,
  );
  const guarded = filterByRange(parsed, { fromDate, toDate });
  const withCompany = attachCompany(guarded.inRange, company);
  const unique = uniqueBy(withCompany, (record) =>
    getVoucherDedupeKey(record, company),
  );

  historicalTransactionsStatus.summary.pulledRecords += parsed.length;
  historicalTransactionsStatus.summary.skippedDuplicateRecords +=
    unique.duplicateCount;

  addEvent("info", "Purchase voucher full period collected", {
    company: company.name,
    fromDate,
    toDate,
    raw: parsed.length,
    inRange: guarded.inRange.length,
    outOfRange: guarded.outOfRange.length,
    withoutDate: guarded.withoutDate.length,
    duplicates: unique.duplicateCount,
    pushRecords: unique.records.length,
  });

  return {
    parsed: parsed.length,
    inRange: guarded.inRange.length,
    outOfRange: guarded.outOfRange.length,
    withoutDate: guarded.withoutDate.length,
    duplicates: unique.duplicateCount,
    records: unique.records,
    buckets: groupVoucherRecordsByRanges(unique.records, ranges),
  };
}

async function pushSalesVoucherBucket(input: {
  company: TallyCompanyForTransactions;
  dateRange: TallyDateRange;
  records: any[];
  syncMode?: "historical" | "incremental";
}) {
  const { company, dateRange, records } = input;

  historicalTransactionsStatus.activeModule = "sales-vouchers";
  historicalTransactionsStatus.activeRange = dateRange;

  addEvent("info", "Sales voucher range collected", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    raw: records.length,
    inRange: records.length,
    outOfRange: 0,
    withoutDate: 0,
    duplicates: 0,
    pushRecords: records.length,
  });

  const result = await pushSalesOrdersToCrm(records, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: input.syncMode || "historical",
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    batchSize: process.env.BATCH_SIZE_SALES_ORDERS || 5,
  });

  const uploaded = Number(result?.uploadedRecords || records.length || 0);
  historicalTransactionsStatus.summary.uploadedRecords += uploaded;

  addEvent("info", "Sales voucher range pushed", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    pushed: records.length,
    uploaded,
    batches: result?.totalBatches ?? null,
  });

  return {
    module: "sales-vouchers",
    dateRange,
    parsed: records.length,
    inRange: records.length,
    pushed: records.length,
    uploaded,
    duplicates: 0,
    result,
  };
}

async function pushPurchaseVoucherBucket(input: {
  company: TallyCompanyForTransactions;
  dateRange: TallyDateRange;
  records: any[];
  syncMode?: "historical" | "incremental";
}) {
  const { company, dateRange, records } = input;

  historicalTransactionsStatus.activeModule = "purchase-vouchers";
  historicalTransactionsStatus.activeRange = dateRange;

  addEvent("info", "Purchase voucher range collected", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    raw: records.length,
    inRange: records.length,
    outOfRange: 0,
    withoutDate: 0,
    duplicates: 0,
    pushRecords: records.length,
  });

  const result = await pushPurchaseOrdersToCrm(records, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: input.syncMode || "historical",
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    batchSize: process.env.BATCH_SIZE_PURCHASE_ORDERS || 5,
  });

  const uploaded = Number(result?.uploadedRecords || records.length || 0);
  historicalTransactionsStatus.summary.uploadedRecords += uploaded;

  addEvent("info", "Purchase voucher range pushed", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    pushed: records.length,
    uploaded,
    batches: result?.totalBatches ?? null,
  });

  return {
    module: "purchase-vouchers",
    dateRange,
    parsed: records.length,
    inRange: records.length,
    pushed: records.length,
    uploaded,
    duplicates: 0,
    result,
  };
}

async function pushSalesVoucherRange(input: {
  company: TallyCompanyForTransactions;
  dateRange: TallyDateRange;
  syncMode?: "historical" | "incremental";
}) {
  const { company, dateRange } = input;

  historicalTransactionsStatus.activeModule = "sales-vouchers";
  historicalTransactionsStatus.activeRange = dateRange;

  addEvent("info", "Sales voucher range started", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
  });

  const xml = await runWithTallyRetry(
    `Sales voucher range ${company.name} ${dateRange.fromDate}-${dateRange.toDate}`,
    () => fetchHistoricalSalesVouchersXml(company.name, dateRange),
  );
  const parsed = parseSalesVouchers(String(xml || "")).filter(isSalesVoucher);
  const guarded = filterByRange(parsed, dateRange);
  const withCompany = attachCompany(guarded.inRange, company);

  const unique = uniqueBy(withCompany, (record) =>
    getVoucherDedupeKey(record, company),
  );

  historicalTransactionsStatus.summary.pulledRecords += parsed.length;
  historicalTransactionsStatus.summary.skippedDuplicateRecords +=
    unique.duplicateCount;

  addEvent("info", "Sales voucher range collected", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    raw: parsed.length,
    inRange: guarded.inRange.length,
    outOfRange: guarded.outOfRange.length,
    withoutDate: guarded.withoutDate.length,
    duplicates: unique.duplicateCount,
    pushRecords: unique.records.length,
  });

  const result = await pushSalesOrdersToCrm(unique.records, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: input.syncMode || "historical",
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    batchSize: process.env.BATCH_SIZE_SALES_ORDERS || 5,
  });

  const uploaded = Number(
    result?.uploadedRecords || unique.records.length || 0,
  );
  historicalTransactionsStatus.summary.uploadedRecords += uploaded;

  addEvent("info", "Sales voucher range pushed", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    pushed: unique.records.length,
    uploaded,
    batches: result?.totalBatches ?? null,
  });

  return {
    module: "sales-vouchers",
    dateRange,
    parsed: parsed.length,
    inRange: guarded.inRange.length,
    pushed: unique.records.length,
    uploaded,
    duplicates: unique.duplicateCount,
    result,
  };
}

async function pushPurchaseVoucherRange(input: {
  company: TallyCompanyForTransactions;
  dateRange: TallyDateRange;
  syncMode?: "historical" | "incremental";
}) {
  const { company, dateRange } = input;

  historicalTransactionsStatus.activeModule = "purchase-vouchers";
  historicalTransactionsStatus.activeRange = dateRange;

  addEvent("info", "Purchase voucher range started", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
  });

  const xml = await runWithTallyRetry(
    `Purchase voucher range ${company.name} ${dateRange.fromDate}-${dateRange.toDate}`,
    () => fetchHistoricalPurchaseVouchersXml(company.name, dateRange),
  );
  const parsed = parsePurchaseVouchers(String(xml || "")).filter(
    isPurchaseVoucher,
  );
  const guarded = filterByRange(parsed, dateRange);
  const withCompany = attachCompany(guarded.inRange, company);

  const unique = uniqueBy(withCompany, (record) =>
    getVoucherDedupeKey(record, company),
  );

  historicalTransactionsStatus.summary.pulledRecords += parsed.length;
  historicalTransactionsStatus.summary.skippedDuplicateRecords +=
    unique.duplicateCount;

  addEvent("info", "Purchase voucher range collected", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    raw: parsed.length,
    inRange: guarded.inRange.length,
    outOfRange: guarded.outOfRange.length,
    withoutDate: guarded.withoutDate.length,
    duplicates: unique.duplicateCount,
    pushRecords: unique.records.length,
  });

  const result = await pushPurchaseOrdersToCrm(unique.records, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: input.syncMode || "historical",
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    batchSize: process.env.BATCH_SIZE_PURCHASE_ORDERS || 5,
  });

  const uploaded = Number(
    result?.uploadedRecords || unique.records.length || 0,
  );
  historicalTransactionsStatus.summary.uploadedRecords += uploaded;

  addEvent("info", "Purchase voucher range pushed", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    pushed: unique.records.length,
    uploaded,
    batches: result?.totalBatches ?? null,
  });

  return {
    module: "purchase-vouchers",
    dateRange,
    parsed: parsed.length,
    inRange: guarded.inRange.length,
    pushed: unique.records.length,
    uploaded,
    duplicates: unique.duplicateCount,
    result,
  };
}

async function pushDeliveryChallanRange(input: {
  company: TallyCompanyForTransactions;
  dateRange: TallyDateRange;
  syncMode?: "historical" | "incremental";
}) {
  const { company, dateRange } = input;

  historicalTransactionsStatus.activeModule = "delivery-challans";
  historicalTransactionsStatus.activeRange = dateRange;

  addEvent("info", "Delivery note range started", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
  });

  const xml = await runWithTallyRetry(
    `Delivery note range ${company.name} ${dateRange.fromDate}-${dateRange.toDate}`,
    () => fetchHistoricalDeliveryChallansXml(company.name, dateRange),
  );
  const parsed = parseDeliveryChallans(String(xml || ""));
  const guarded = filterByRange(parsed, dateRange);
  const withCompany = attachCompany(guarded.inRange, company);

  const unique = uniqueBy(withCompany, (record) =>
    getVoucherDedupeKey(record, company),
  );

  historicalTransactionsStatus.summary.pulledRecords += parsed.length;
  historicalTransactionsStatus.summary.skippedDuplicateRecords +=
    unique.duplicateCount;

  addEvent("info", "Delivery note range collected", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    raw: parsed.length,
    inRange: guarded.inRange.length,
    outOfRange: guarded.outOfRange.length,
    withoutDate: guarded.withoutDate.length,
    duplicates: unique.duplicateCount,
    pushRecords: unique.records.length,
  });

  const result = await pushDeliveryChallansToCrm(unique.records, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: input.syncMode || "historical",
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    batchSize: process.env.BATCH_SIZE_DELIVERY_CHALLANS || 5,
  });

  const uploaded = Number(
    result?.uploadedRecords || unique.records.length || 0,
  );
  historicalTransactionsStatus.summary.uploadedRecords += uploaded;

  addEvent("info", "Delivery note range pushed", {
    company: company.name,
    fromDate: dateRange.fromDate,
    toDate: dateRange.toDate,
    pushed: unique.records.length,
    uploaded,
    batches: result?.totalBatches ?? null,
  });

  return {
    module: "delivery-challans",
    dateRange,
    parsed: parsed.length,
    inRange: guarded.inRange.length,
    pushed: unique.records.length,
    uploaded,
    duplicates: unique.duplicateCount,
    result,
  };
}

async function pushOfficialOutstandings(input: {
  company: TallyCompanyForTransactions;
  fromDate: string;
  toDate: string;
  syncMode?: "historical" | "incremental";
}) {
  const { company, fromDate, toDate } = input;

  historicalTransactionsStatus.activeModule = "outstandings";
  historicalTransactionsStatus.activeRange = { fromDate, toDate };

  addEvent("info", "Official outstanding report sync started", {
    company: company.name,
    fromDate,
    toDate,
    approach: "Tally official Bills Receivable + Bills Payable report",
    note: "Outstanding report follows Tally current date/period. No full voucher scan is used.",
  });

  const receivableXml = await fetchOfficialOutstandingReportXml({
    companyName: company.name,
    reportType: "receivable",
    fromDate,
    toDate,
  });

  const payableXml = await fetchOfficialOutstandingReportXml({
    companyName: company.name,
    reportType: "payable",
    fromDate,
    toDate,
  });

  const receivableRows = parseOfficialBillWiseOutstandingReport({
    xml: String(receivableXml || ""),
    billType: "receivable",
    company,
  });

  const payableRows = parseOfficialBillWiseOutstandingReport({
    xml: String(payableXml || ""),
    billType: "payable",
    company,
  });

  historicalTransactionsStatus.summary.outstandingReceivableRows +=
    receivableRows.length;
  historicalTransactionsStatus.summary.outstandingPayableRows +=
    payableRows.length;

  addEvent("info", "Official outstanding reports parsed", {
    company: company.name,
    receivableRows: receivableRows.length,
    payableRows: payableRows.length,
  });

  let outstandingRows = [...receivableRows, ...payableRows];

  if (!outstandingRows.length) {
    addEvent(
      "warn",
      "Official outstanding report returned zero rows, voucher fallback started",
      {
        company: company.name,
        fromDate,
        toDate,
      },
    );

    const fallbackXml = await runWithTallyRetry(
      `Outstanding voucher fallback ${company.name} ${fromDate}-${toDate}`,
      () =>
        fetchHistoricalOutstandingVouchersXml(company.name, {
          fromDate,
          toDate,
        }),
    );

    outstandingRows = parseOutstandings(String(fallbackXml || ""));

    addEvent("info", "Outstanding voucher fallback parsed", {
      company: company.name,
      rows: outstandingRows.length,
      fromDate,
      toDate,
    });
  }

  const guarded = applyOfficialOutstandingDateGuard({
    records: outstandingRows,
    fromDate,
    toDate,
  });

  const withCompany = attachCompany(guarded, company);

  const unique = uniqueBy(withCompany, (record) =>
    getOutstandingDedupeKey(record, company),
  );

  /**
   * Count only the final unique records that are actually queued for CRM.
   * Raw receivable/payable counts are already available separately in
   * outstandingReceivableRows and outstandingPayableRows.
   */
  historicalTransactionsStatus.summary.pulledRecords += unique.records.length;
  historicalTransactionsStatus.summary.skippedDuplicateRecords +=
    unique.duplicateCount;

  if (
    unique.records.length === 0 &&
    String(process.env.ALLOW_EMPTY_OUTSTANDING_SNAPSHOT || "false").toLowerCase() !== "true"
  ) {
    throw new Error(
      `Outstanding snapshot for ${company.name} returned zero records. Closure was blocked for safety. Set ALLOW_EMPTY_OUTSTANDING_SNAPSHOT=true only after verifying Tally has genuinely zero open bills.`,
    );
  }

  const snapshotStartedAt = nowIso();
  const snapshotId = `${company.guid || normalizeName(company.name)}:${toDate}:${Date.now()}`;

  addEvent("info", "Outstanding current snapshot prepared", {
    company: company.name,
    fromDate,
    toDate,
    receivable: unique.records.filter((row) => row.billType === "receivable" || row.bill_type === "receivable").length,
    payable: unique.records.filter((row) => row.billType === "payable" || row.bill_type === "payable").length,
    total: unique.records.length,
    snapshotId,
  });

  const result = await pushOutstandingsToCrm(unique.records, {
    companyName: company.name,
    companyGuid: company.guid,
    syncMode: input.syncMode || "historical",
    fromDate,
    toDate,
    batchSize: process.env.BATCH_SIZE_OUTSTANDINGS || 5,
    snapshotId,
    snapshotStartedAt,
    isFullSnapshot: true,
  });
  const uploaded = Number(result?.uploadedRecords ?? unique.records.length ?? 0);
  historicalTransactionsStatus.summary.uploadedRecords += uploaded;

  return {
    module: "outstandings",
    parsed: outstandingRows.length,
    receivableRows: receivableRows.length,
    payableRows: payableRows.length,
    pushed: unique.records.length,
    uploaded,
    duplicates: unique.duplicateCount,
    snapshotId,
    result,
  };
}

async function syncCompanyTransactions(input: {
  company: TallyCompanyForTransactions;
  fromDate: string;
  toDate: string;
  modules: HistoricalTransactionModule[];
  skipCheckpoints?: boolean;
  syncMode?: "historical" | "incremental";
}) {
  const { company, fromDate, toDate, modules } = input;
  const rangeMonths = getRangeChunkMonths();
  const shouldSyncSales = modules.includes("sales-vouchers");
  const shouldSyncPurchase = modules.includes("purchase-vouchers");
  const shouldSyncDeliveryChallans = modules.includes("delivery-challans");
  const shouldRunVoucherRanges =
    shouldSyncSales || shouldSyncPurchase || shouldSyncDeliveryChallans;

  const ranges = shouldRunVoucherRanges
    ? buildDateRanges({
        fromDate,
        toDate,
        chunkMonths: rangeMonths,
      })
    : [];

  const companyResult: any = {
    company: {
      name: company.name,
      guid: company.guid || null,
      booksFrom: company.booksFrom || null,
      startingFrom: company.startingFrom || null,
    },
    fromDate,
    toDate,
    ranges: ranges.length,
    salesVouchers: [],
    purchaseVouchers: [],
    deliveryChallans: [],
    outstandings: null,
    skipped: [],
    errors: [],
  };

  historicalTransactionsStatus.activeCompany = company.name;
  historicalTransactionsStatus.summary.rangesTotal +=
    ranges.length *
    modules.filter(
      (m) =>
        m === "sales-vouchers" ||
        m === "purchase-vouchers" ||
        m === "delivery-challans",
    ).length;

  addEvent("info", "Company transaction sync started", {
    company: company.name,
    fromDate,
    toDate,
    modules,
    salesPurchaseRanges: ranges.length,
    rangeMonths,
  });

  for (const dateRange of ranges) {
    addEvent("info", "Transaction range started", {
      company: company.name,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      modules: modules.filter(
        (m) =>
          m === "sales-vouchers" ||
          m === "purchase-vouchers" ||
          m === "delivery-challans",
      ),
    });

    let salesResult: any = null;
    let purchaseResult: any = null;
    let deliveryChallansResult: any = null;

    if (shouldSyncSales) {
      const salesRun = await runCheckpointedTxRange({
        company,
        moduleName: "sales-vouchers",
        dateRange,
        run: () =>
          pushSalesVoucherRange({ company, dateRange, syncMode: input.syncMode }),
        skipCheckpoint: input.skipCheckpoints,
      });

      if (salesRun.status === "success") {
        salesResult = salesRun.result;
        companyResult.salesVouchers.push(salesResult);
        historicalTransactionsStatus.summary.modulesCompleted += 1;
        historicalTransactionsStatus.summary.rangesCompleted += 1;
      }

      if (salesRun.status === "skipped") {
        companyResult.skipped.push({
          moduleName: "sales-vouchers",
          fromDate: dateRange.fromDate,
          toDate: dateRange.toDate,
        });
        historicalTransactionsStatus.summary.modulesCompleted += 1;
        historicalTransactionsStatus.summary.rangesCompleted += 1;
      }

      if (salesRun.status === "failed") {
        companyResult.errors.push({
          moduleName: "sales-vouchers",
          fromDate: dateRange.fromDate,
          toDate: dateRange.toDate,
          error: salesRun.error,
        });
      }
    }

    if (shouldSyncPurchase) {
      const purchaseRun = await runCheckpointedTxRange({
        company,
        moduleName: "purchase-vouchers",
        dateRange,
        run: () =>
          pushPurchaseVoucherRange({ company, dateRange, syncMode: input.syncMode }),
        skipCheckpoint: input.skipCheckpoints,
      });

      if (purchaseRun.status === "success") {
        purchaseResult = purchaseRun.result;
        companyResult.purchaseVouchers.push(purchaseResult);
        historicalTransactionsStatus.summary.modulesCompleted += 1;
        historicalTransactionsStatus.summary.rangesCompleted += 1;
      }

      if (purchaseRun.status === "skipped") {
        companyResult.skipped.push({
          moduleName: "purchase-vouchers",
          fromDate: dateRange.fromDate,
          toDate: dateRange.toDate,
        });
        historicalTransactionsStatus.summary.modulesCompleted += 1;
        historicalTransactionsStatus.summary.rangesCompleted += 1;
      }

      if (purchaseRun.status === "failed") {
        companyResult.errors.push({
          moduleName: "purchase-vouchers",
          fromDate: dateRange.fromDate,
          toDate: dateRange.toDate,
          error: purchaseRun.error,
        });
      }
    }

    if (shouldSyncDeliveryChallans) {
      const dcRun = await runCheckpointedTxRange({
        company,
        moduleName: "delivery-challans",
        dateRange,
        run: () =>
          pushDeliveryChallanRange({ company, dateRange, syncMode: input.syncMode }),
        skipCheckpoint: input.skipCheckpoints,
      });

      if (dcRun.status === "success") {
        deliveryChallansResult = dcRun.result;
        companyResult.deliveryChallans.push(deliveryChallansResult);
        historicalTransactionsStatus.summary.modulesCompleted += 1;
        historicalTransactionsStatus.summary.rangesCompleted += 1;
      }

      if (dcRun.status === "skipped") {
        companyResult.skipped.push({
          moduleName: "delivery-challans",
          fromDate: dateRange.fromDate,
          toDate: dateRange.toDate,
        });
        historicalTransactionsStatus.summary.modulesCompleted += 1;
        historicalTransactionsStatus.summary.rangesCompleted += 1;
      }

      if (dcRun.status === "failed") {
        companyResult.errors.push({
          moduleName: "delivery-challans",
          fromDate: dateRange.fromDate,
          toDate: dateRange.toDate,
          error: dcRun.error,
        });
      }
    }

    addEvent("info", "Transaction range completed", {
      company: company.name,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      salesParsed: salesResult?.parsed ?? null,
      purchaseParsed: purchaseResult?.parsed ?? null,
      deliveryChallansParsed: deliveryChallansResult?.parsed ?? null,
    });
  }

  if (modules.includes("outstandings")) {
    const outstandingRun = await runCheckpointedTxRange({
      company,
      moduleName: "outstandings",
      dateRange: { fromDate, toDate },
      run: () =>
        pushOfficialOutstandings({ company, fromDate, toDate, syncMode: input.syncMode }),
      skipCheckpoint: true,
    });

    if (outstandingRun.status === "success") {
      companyResult.outstandings = outstandingRun.result;
      historicalTransactionsStatus.summary.modulesCompleted += 1;
    }

    if (outstandingRun.status === "skipped") {
      companyResult.skipped.push({
        moduleName: "outstandings",
        fromDate,
        toDate,
      });
      historicalTransactionsStatus.summary.modulesCompleted += 1;
    }

    if (outstandingRun.status === "failed") {
      companyResult.errors.push({
        moduleName: "outstandings",
        fromDate,
        toDate,
        error: outstandingRun.error,
      });
    }
  }

  historicalTransactionsStatus.summary.companiesCompleted += 1;

  addEvent("info", "Company transaction sync completed", {
    company: company.name,
    fromDate,
    toDate,
    salesUploaded: companyResult.salesVouchers.reduce(
      (sum: number, item: any) => sum + Number(item.uploaded || 0),
      0,
    ),
    purchaseUploaded: companyResult.purchaseVouchers.reduce(
      (sum: number, item: any) => sum + Number(item.uploaded || 0),
      0,
    ),
    deliveryChallansUploaded: companyResult.deliveryChallans.reduce(
      (sum: number, item: any) => sum + Number(item.uploaded || 0),
      0,
    ),
    outstandingUploaded: Number(companyResult.outstandings?.uploaded || 0),
  });

  return companyResult;
}

export function getHistoricalTransactionsSyncStatus() {
  return {
    ...historicalTransactionsStatus,
    summary: { ...historicalTransactionsStatus.summary },
    events: [...historicalTransactionsStatus.events],
  };
}

export async function runHistoricalTransactionsSync(
  input?: HistoricalTransactionsRequest,
) {
  if (isHistoricalTransactionsRunning) {
    return {
      skipped: true,
      message: "Previous historical transaction sync is still running",
    };
  }

  isHistoricalTransactionsRunning = true;

  const startedAt = nowIso();
  const toDate = normalizeTallyDate(input?.toDate) || todayTallyDate();
  const modules = getEnabledModules(input?.modules);

  patchStatus({
    status: "running",
    isRunning: true,
    startedAt,
    completedAt: null,
    error: null,
    request: {
      fromDate: normalizeTallyDate(input?.fromDate),
      toDate,
      companyName: input?.companyName || "",
      modules,
    },
    activeCompany: null,
    activeModule: null,
    activeRange: null,
    summary: {
      companiesTotal: 0,
      companiesCompleted: 0,
      modulesTotal: 0,
      modulesCompleted: 0,
      rangesTotal: 0,
      rangesCompleted: 0,
      pulledRecords: 0,
      uploadedRecords: 0,
      skippedDuplicateRecords: 0,
      skippedCheckpointRanges: 0,
      failedRanges: 0,
      outstandingReceivableRows: 0,
      outstandingPayableRows: 0,
    },
    events: [],
    lastResult: null,
  });

  addEvent("info", "Historical transaction sync started", {
    fromDate: input?.fromDate || "COMPANY_BOOKS_FROM",
    toDate,
    companyName: input?.companyName || "ALL",
    modules,
    outstandingApproach:
      "Official Tally Bills Receivable + Bills Payable report",
  });

  if (input?.forceRestart) {
    for (const moduleName of modules) {
      clearHistoricalSyncCheckpoints({
        companyName: input?.companyName || null,
        moduleName,
      });
    }

    addEvent("info", "Historical checkpoints cleared", {
      companyName: input?.companyName || "ALL",
      modules,
    });
  }

  try {
    const companies = await getCompaniesForSync({
      companyName: input?.companyName || null,
      companyGuid: input?.companyGuid || null,
      skipConfiguredAllowlist: Boolean(input?.skipConfiguredAllowlist),
    });

    const selectedCompanies = input?.companyName
      ? companies.filter(
          (company) =>
            normalizeName(company.name) === normalizeName(input.companyName),
        )
      : companies;

    if (!selectedCompanies.length) {
      throw new Error(
        input?.companyName
          ? `No loaded Tally company found for "${input.companyName}"`
          : "No loaded Tally company found",
      );
    }

    historicalTransactionsStatus.summary.companiesTotal =
      selectedCompanies.length;

    const plans = selectedCompanies.map((company) => {
      const fromDate =
        normalizeTallyDate(input?.fromDate) || getCompanyStartDate(company);

      return {
        company,
        fromDate,
        toDate,
      };
    });

    historicalTransactionsStatus.summary.modulesTotal = plans.reduce(
      (sum, plan) => {
        const ranges = buildDateRanges({
          fromDate: plan.fromDate,
          toDate: plan.toDate,
          chunkMonths: getRangeChunkMonths(),
        });

        const rangeModules = modules.filter(
          (m) =>
            m === "sales-vouchers" ||
            m === "purchase-vouchers" ||
            m === "delivery-challans",
        ).length;

        const officialOutstandingModules = modules.includes("outstandings")
          ? 1
          : 0;

        return sum + ranges.length * rangeModules + officialOutstandingModules;
      },
      0,
    );

    const companyResults = [];

    for (const plan of plans) {
      companyResults.push(
        await syncCompanyTransactions({
          company: plan.company,
          fromDate: plan.fromDate,
          toDate: plan.toDate,
          modules,
          skipCheckpoints: Boolean(input?.skipCheckpoints),
          syncMode: input?.syncMode || "historical",
        }),
      );
    }

    const completedAt = nowIso();
    const failedItems = companyResults.flatMap(
      (item: any) => item.errors || [],
    );
    const finalStatus = failedItems.length ? "partial_success" : "success";

    const result = {
      skipped: false,
      status: finalStatus,
      message: failedItems.length
        ? "Historical transaction sync completed with failures"
        : "Historical transaction sync completed",
      startedAt,
      completedAt,
      modules,
      outstandingApproach:
        "Official Tally Bills Receivable + Bills Payable report",
      companies: plans.map((plan) => ({
        name: plan.company.name,
        guid: plan.company.guid || null,
        fromDate: plan.fromDate,
        toDate: plan.toDate,
      })),
      summary: { ...historicalTransactionsStatus.summary },
      failedItems,
      companyResults,
    };

    patchStatus({
      status: finalStatus,
      isRunning: false,
      completedAt,
      error: failedItems.length
        ? `${failedItems.length} historical transaction range(s) failed. Re-run the same route; successful checkpoints will be skipped and failed ranges will retry.`
        : null,
      activeCompany: null,
      activeModule: null,
      activeRange: null,
      lastResult: result,
    });

    if (failedItems.length) {
      addEvent("error", "Historical transaction sync completed with failures", {
        failed: failedItems.length,
        summary: result.summary,
      });
    } else {
      addEvent("info", "Historical transaction sync completed", {
        summary: result.summary,
      });
    }

    return result;
  } catch (error: any) {
    const completedAt = nowIso();

    patchStatus({
      status: "failed",
      isRunning: false,
      completedAt,
      error: error?.message || "Historical transaction sync failed",
      lastResult: null,
    });

    addEvent("error", "Historical transaction sync failed", {
      error: error?.message || "unknown",
      activeCompany: historicalTransactionsStatus.activeCompany,
      activeModule: historicalTransactionsStatus.activeModule,
      activeRange: historicalTransactionsStatus.activeRange,
    });

    throw error;
  } finally {
    isHistoricalTransactionsRunning = false;
  }
}

export function startHistoricalTransactionsSyncInBackground(
  input?: HistoricalTransactionsRequest,
) {
  if (isHistoricalTransactionsRunning) {
    return {
      started: false,
      message: "Previous historical transaction sync is still running",
      data: getHistoricalTransactionsSyncStatus(),
    };
  }

  void runHistoricalTransactionsSync(input).catch((error: any) => {
    console.error("[HISTORICAL TX] Background run failed", error);
  });

  return {
    started: true,
    message: "Historical transaction sync started",
    data: getHistoricalTransactionsSyncStatus(),
  };
}
