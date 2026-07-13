import axios, { AxiosError } from "axios";

const CRM_BASE_URL = process.env.CRM_BASE_URL;
const CRM_TENANT_SLUG = process.env.CRM_TENANT_SLUG;
const TALLY_AGENT_TOKEN = process.env.TALLY_AGENT_TOKEN;
const CRM_REQUEST_TIMEOUT_MS = Number(
  process.env.CRM_REQUEST_TIMEOUT_MS || 300000,
);

if (!CRM_BASE_URL) {
  throw new Error("[CRM CLIENT] CRM_BASE_URL is missing in .env");
}

if (!CRM_TENANT_SLUG) {
  throw new Error("[CRM CLIENT] CRM_TENANT_SLUG is missing in .env");
}

if (!TALLY_AGENT_TOKEN) {
  throw new Error("[CRM CLIENT] TALLY_AGENT_TOKEN is missing in .env");
}

const client = axios.create({
  baseURL: `${CRM_BASE_URL.replace(/\/$/, "")}/${CRM_TENANT_SLUG}`,
  timeout: CRM_REQUEST_TIMEOUT_MS,
  headers: {
    Authorization: `Bearer ${TALLY_AGENT_TOKEN}`,
    "Content-Type": "application/json",
  },
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

type SyncMode = "historical" | "incremental";

export type PushProgressEvent = {
  type:
    | "module_start"
    | "batch_start"
    | "batch_success"
    | "batch_failed"
    | "module_complete";
  moduleName: string;
  companyName?: string | null;
  companyGuid?: string | null;
  syncMode: SyncMode;
  fromDate?: string | null;
  toDate?: string | null;
  totalRecords: number;
  batchSize: number;
  totalBatches: number;
  batchNo?: number;
  batchRecords?: number;
  uploadedRecords: number;
  pendingRecords: number;
  failedRecords: number;
  uploadedBatches: number;
  failedBatches: number;
  errorMessage?: string | null;
};

type PushOptions = {
  batchSize?: any;
  companyName?: string;
  companyGuid?: string | null;
  moduleName?: string;
  syncMode?: SyncMode;
  fromDate?: string | null;
  toDate?: string | null;
  snapshotId?: string | null;
  snapshotStartedAt?: string | null;
  isFullSnapshot?: boolean;
  onProgress?: (event: PushProgressEvent) => void;
};

function chunkArray<T>(records: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < records.length; i += size) {
    chunks.push(records.slice(i, i + size));
  }

  return chunks;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBatchSize(value: any, fallback = 20) {
  const batchSize = Number(value);

  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    return fallback;
  }

  return Math.floor(batchSize);
}

function getCrmRetryAttempts() {
  return Math.max(1, Number(process.env.CRM_RETRY_ATTEMPTS || 2));
}

function shouldStripRawTallyData() {
  return (
    String(process.env.CRM_STRIP_RAW_TALLY_DATA || "true")
      .trim()
      .toLowerCase() !== "false"
  );
}

function stripRawTallyData(value: any): any {
  if (!shouldStripRawTallyData()) return value;

  if (Array.isArray(value)) {
    return value.map((item) => stripRawTallyData(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const cleaned: Record<string, any> = {};

  for (const [key, item] of Object.entries(value)) {
    if (key === "rawTallyData" || key === "raw_tally_data") continue;
    cleaned[key] = stripRawTallyData(item);
  }

  return cleaned;
}

function buildCrmPayload(input: {
  moduleName: string;
  batch: any[];
  meta: Record<string, any>;
}) {
  const batch = stripRawTallyData(input.batch);

  const payload: Record<string, any> = {
    records: batch,
    meta: input.meta,
  };

  /**
   * Keep records as primary payload and only one legacy alias.
   * Older version was sending 3-4 duplicate arrays, which made RDP payloads
   * heavy and caused CRM timeouts for real Tally vouchers.
   */
  // if (input.moduleName === "sales-orders") {
  //   payload.salesOrders = batch;
  // }

  if (input.moduleName === "purchase-orders") {
    payload.purchaseOrders = batch;
  }

  if (input.moduleName === "outstandings") {
    payload.outstandings = batch;
  }

  if (input.moduleName === "stock-items") {
    payload.stockItems = batch;
  }

  if (input.moduleName === "delivery-challans") {
    payload.deliveryChallans = batch;
  }

  return payload;
}

function toCrmCount(value: any): number | null {
  if (Array.isArray(value)) return value.length;
  if (value === null || value === undefined || value === "") return null;

  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

function firstCrmCount(...values: any[]): number | null {
  for (const value of values) {
    const count = toCrmCount(value);
    if (count !== null) return count;
  }

  return null;
}

function sumCrmCounts(...values: any[]): number {
  return values.reduce((sum, value) => sum + (toCrmCount(value) ?? 0), 0);
}

function extractCrmSyncCounts(response: any) {
  const data = response?.data || response || {};

  const failed =
    firstCrmCount(
      data.failed,
      data.failedCount,
      data.failed_count,
      data.errors,
      data.errorCount,
      data.error_count,
    ) ?? 0;

  const explicitSuccess = firstCrmCount(
    data.success,
    data.successCount,
    data.success_count,
  );

  const derivedSuccess = sumCrmCounts(
    data.inserted,
    data.insertedCount,
    data.inserted_count,
    data.updated,
    data.updatedCount,
    data.updated_count,
    data.upserted,
    data.upsertedCount,
    data.upserted_count,
    data.synced,
    data.syncedCount,
    data.synced_count,
    data.saved,
    data.savedCount,
    data.saved_count,
    data.skipped,
    data.skippedCount,
    data.skipped_count,
    data.unchanged,
    data.unchangedCount,
    data.unchanged_count,
  );

  const success = explicitSuccess ?? derivedSuccess;

  const total =
    firstCrmCount(
      data.total,
      data.totalRecords,
      data.total_records,
      data.totalCount,
      data.total_count,
      data.count,
    ) ?? success + failed;

  return {
    total,
    success,
    failed,
    jobId: data.job_id || data.jobId || null,
  };
}

function shouldStrictlyValidateModule(moduleName: string) {
  return [
    "sales-orders",
    "purchase-orders",
    "outstandings",
    "stock-items",
  ].includes(moduleName);
}

function validateCrmBatchResult(input: {
  moduleName: string;
  batchLabel: string;
  batchRecords: number;
  response: any;
}) {
  if (!shouldStrictlyValidateModule(input.moduleName)) return;

  const counts = extractCrmSyncCounts(input.response);

  if (input.batchRecords > 0 && counts.failed > 0) {
    throw new Error(
      `[CRM CLIENT] ${input.moduleName} batch ${input.batchLabel} was accepted by CRM but ${counts.failed}/${counts.total || input.batchRecords} records failed in backend. JobId=${counts.jobId || "N/A"}. Check CRM tally_sync_errors for exact DB error.`,
    );
  }

  if (input.batchRecords > 0 && counts.total > 0 && counts.success === 0) {
    throw new Error(
      `[CRM CLIENT] ${input.moduleName} batch ${input.batchLabel} inserted 0/${counts.total} records in backend. JobId=${counts.jobId || "N/A"}. Check CRM tally_sync_errors for exact DB error.`,
    );
  }
}

async function postWithRetry(
  url: string,
  body: any,
  attempt = 1,
): Promise<any> {
  try {
    const response = await client.post(url, body);
    return response.data;
  } catch (error) {
    const err = error as AxiosError<any>;

    const status = err.response?.status;
    const maxAttempts = getCrmRetryAttempts();
    const canRetry =
      attempt < maxAttempts &&
      (!status || status === 408 || status === 429 || status >= 500);

    console.error("[CRM CLIENT] Push failed", {
      url,
      attempt,
      status,
      message: err.message,
      response: err.response?.data,
    });

    if (canRetry) {
      await sleep(200 * attempt);
      return postWithRetry(url, body, attempt + 1);
    }

    throw error;
  }
}

async function pushRecordsToCrm(
  url: string,
  records: any[],
  options: PushOptions = {},
) {
  const safeRecords = Array.isArray(records) ? records : [];
  const batchSize = normalizeBatchSize(options.batchSize, 20);
  const batches = chunkArray(safeRecords, batchSize);
  const moduleName = options.moduleName || url;

  const summary = {
    moduleName,
    companyName: options.companyName || null,
    companyGuid: options.companyGuid || null,
    syncMode: options.syncMode || "incremental",
    fromDate: options.fromDate || null,
    toDate: options.toDate || null,
    totalRecords: safeRecords.length,
    batchSize,
    totalBatches: batches.length,
    successBatches: 0,
    failedBatches: 0,
    uploadedRecords: 0,
    failedRecords: 0,
    pendingRecords: safeRecords.length,
    results: [] as any[],
  };

  const emitProgress = (event: Partial<PushProgressEvent>) => {
    options.onProgress?.({
      type: event.type || "batch_start",
      moduleName,
      companyName: options.companyName || null,
      companyGuid: options.companyGuid || null,
      syncMode: options.syncMode || "incremental",
      fromDate: options.fromDate || null,
      toDate: options.toDate || null,
      totalRecords: safeRecords.length,
      batchSize,
      totalBatches: batches.length,
      uploadedRecords: summary.uploadedRecords,
      pendingRecords: summary.pendingRecords,
      failedRecords: summary.failedRecords,
      uploadedBatches: summary.successBatches,
      failedBatches: summary.failedBatches,
      ...event,
    });
  };

  emitProgress({ type: "module_start" });

  const company = options.companyName ? ` [${options.companyName}]` : "";

  // console.log(
  //   `[SYNC]${company} ${moduleName.padEnd(18)} → ${safeRecords.length} records, ${batches.length} batches`,
  // );

  if (!safeRecords.length) {
    if (options.isFullSnapshot) {
      const meta = {
        company_name: options.companyName || null,
        company_guid: options.companyGuid || null,
        module_name: options.moduleName || null,
        sync_mode: options.syncMode || "incremental",
        from_date: options.fromDate || null,
        to_date: options.toDate || null,
        batch_no: 1,
        total_batches: 1,
        batch_size: 0,
        total_records: safeRecords.length,
        snapshot_id: options.snapshotId || null,
        snapshot_started_at: options.snapshotStartedAt || null,
        snapshot_is_full: true,
        snapshot_final_batch: true,
      };
      const result = await postWithRetry(
        url,
        buildCrmPayload({ moduleName, batch: [], meta }),
      );
      summary.successBatches = 1;
      summary.totalBatches = 1;
      summary.results.push({ batchNo: 1, records: 0, result });
    }
    emitProgress({ type: "module_complete" });
    return summary;
  }

  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    const batchNo = index + 1;

    const batchLabel = `${batchNo}/${batches.length}`;

    // console.log(
    //   `[SYNC]${company} ${moduleName.padEnd(18)} ⏳ Batch ${batchLabel} — ${batch.length} records`,
    // );

    emitProgress({
      type: "batch_start",
      batchNo,
      batchRecords: batch.length,
    });

    try {
      const meta = {
        company_name: options.companyName || null,
        company_guid: options.companyGuid || null,
        module_name: options.moduleName || null,
        sync_mode: options.syncMode || "incremental",
        from_date: options.fromDate || null,
        to_date: options.toDate || null,
        batch_no: batchNo,
        total_batches: batches.length,
        batch_size: batch.length,
        total_records: safeRecords.length,
        snapshot_id: options.snapshotId || null,
        snapshot_started_at: options.snapshotStartedAt || null,
        snapshot_is_full: Boolean(options.isFullSnapshot),
        snapshot_final_batch:
          Boolean(options.isFullSnapshot) && batchNo === batches.length,
      };

      const result = await postWithRetry(
        url,
        buildCrmPayload({ moduleName, batch, meta }),
      );

      validateCrmBatchResult({
        moduleName,
        batchLabel,
        batchRecords: batch.length,
        response: result,
      });

      const crmCounts = extractCrmSyncCounts(result);
      const uploadedRecordCount = crmCounts.success || batch.length;

      summary.successBatches += 1;
      summary.uploadedRecords += uploadedRecordCount;
      summary.pendingRecords = Math.max(
        safeRecords.length - summary.uploadedRecords - summary.failedRecords,
        0,
      );
      summary.results.push({
        batchNo,
        batchLabel,
        records: batch.length,
        total: crmCounts.total,
        success: crmCounts.success,
        failed: crmCounts.failed,
        jobId: crmCounts.jobId,
      });

      // console.log(
      //   `[SYNC]${company} ${moduleName.padEnd(18)} ✅ Batch ${batchLabel} done — ${summary.uploadedRecords}/${safeRecords.length} records uploaded`,
      // );

      emitProgress({
        type: "batch_success",
        batchNo,
        batchRecords: batch.length,
        totalRecords: safeRecords.length,
        uploadedRecords: summary.uploadedRecords,
        pendingRecords: summary.pendingRecords,
      });
    } catch (error: any) {
      summary.failedBatches += 1;
      summary.failedRecords += batch.length;
      summary.pendingRecords = Math.max(
        safeRecords.length - summary.uploadedRecords - summary.failedRecords,
        0,
      );

      emitProgress({
        type: "batch_failed",
        batchNo,
        batchRecords: batch.length,
        errorMessage: error?.message || "CRM batch push failed",
      });

      throw error;
    }
  }

  emitProgress({ type: "module_complete" });

  // console.log(
  //   `[SYNC]${company} ${moduleName.padEnd(18)} ✔ Complete — ${summary.uploadedRecords}/${safeRecords.length} records, ${summary.successBatches}/${batches.length} batches`,
  // );

  return summary;
}

export async function pushLedgersToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/ledgers", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "ledgers",
  });
}

export async function pushStockItemsToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/stock-items", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "stock-items",
  });
}

export async function pushOutstandingsToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/outstandings", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "outstandings",
  });
}

export async function pushSalesOrdersToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/sales-orders", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "sales-orders",
  });
}

export async function pushPurchaseOrdersToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/purchase-orders", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "purchase-orders",
  });
}

export async function pushDeliveryChallansToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/delivery-challans", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "delivery-challans",
  });
}

export async function pushCostCentersToCrm(
  records: any[],
  options: PushOptions = {},
) {
  return pushRecordsToCrm("/tally/pull/cost-centers", records, {
    ...options,
    batchSize: options.batchSize || 20,
    moduleName: "cost-centers",
  });
}

export async function updateTallyConnectionInCrm(input: {
  companyName?: string | null;
  companyGuid?: string | null;
  tallyUrl?: string | null;
  direction?: "pull" | "push";
  frequencyMinutes?: number;
  isActive?: boolean;
}) {
  const response = await client.post("/tally/agent/company", {
    company_name: input.companyName || null,
    company_guid: input.companyGuid || null,
    tally_url: input.tallyUrl || process.env.TALLY_URL || null,
    direction: input.direction || "pull",
    frequency_minutes: input.frequencyMinutes || 10,
    is_active: input.isActive ?? true,
  });

  return response.data;
}

export async function getTallySyncStateFromCrm(input: {
  companyName?: string | null;
  companyGuid?: string | null;
}) {
  const response = await client.get("/tally/agent/sync-state", {
    params: {
      company_name: input.companyName || undefined,
      company_guid: input.companyGuid || undefined,
    },
  });

  return response.data;
}

export async function updateTallySyncStateInCrm(input: {
  companyName?: string | null;
  companyGuid?: string | null;
  syncMode: SyncMode;
  startedAt: string;
  completedAt: string;
  status: "success" | "failed";
  errorMessage?: string | null;
}) {
  const response = await client.post("/tally/agent/sync-state", {
    company_name: input.companyName || null,
    company_guid: input.companyGuid || null,
    sync_mode: input.syncMode,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    status: input.status,
    error_message: input.errorMessage || null,
  });

  return response.data;
}

export async function markHistoricalSyncProgressInCrm(input: {
  companyName: string;
  companyGuid?: string | null;
  fromDate: string;
  toDate: string;
  status: "started" | "success" | "failed";
  errorMessage?: string | null;
}) {
  const response = await client.post("/tally/agent/historical-sync-progress", {
    company_name: input.companyName,
    company_guid: input.companyGuid || null,
    from_date: input.fromDate,
    to_date: input.toDate,
    status: input.status,
    error_message: input.errorMessage || null,
  });

  return response.data;
}
