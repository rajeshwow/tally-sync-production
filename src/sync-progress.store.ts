export type SyncMode = "historical" | "incremental";
export type SyncRunStatus =
  | "idle"
  | "running"
  | "success"
  | "failed"
  | "cancelled";
export type SyncModuleStatus =
  | "pending"
  | "fetching"
  | "parsed"
  | "uploading"
  | "success"
  | "failed"
  | "skipped";

export type SyncDateRange = {
  fromDate?: string | null;
  toDate?: string | null;
};

export type SyncProgressEvent = {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
  companyName?: string | null;
  moduleName?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  details?: any;
};

export type SyncModuleProgress = {
  key: string;
  moduleName: string;
  companyName?: string | null;
  companyGuid?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  status: SyncModuleStatus;
  totalRecords: number;
  uploadedRecords: number;
  failedRecords: number;
  pendingRecords: number;
  batchSize: number;
  totalBatches: number;
  uploadedBatches: number;
  failedBatches: number;
  currentBatch: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

export type SyncProgressSnapshot = {
  runId: string | null;
  mode: SyncMode | null;
  status: SyncRunStatus;
  isRunning: boolean;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  request: any;
  activeCompany: {
    index: number;
    total: number;
    name: string | null;
    guid?: string | null;
  };
  activeRange: {
    index: number;
    total: number;
    fromDate: string | null;
    toDate: string | null;
  };
  activeModule: string | null;
  summary: {
    companiesTotal: number;
    companiesCompleted: number;
    rangesTotal: number;
    rangesCompleted: number;
    modulesTotal: number;
    modulesCompleted: number;
    totalRecords: number;
    uploadedRecords: number;
    failedRecords: number;
    pendingRecords: number;
    progressPercent: number;
  };
  modules: SyncModuleProgress[];
  events: SyncProgressEvent[];
  lastResult: any;
};

type InternalSyncProgress = Omit<SyncProgressSnapshot, "modules"> & {
  modules: Record<string, SyncModuleProgress>;
};

function nowIso() {
  return new Date().toISOString();
}

function createRunId(mode: SyncMode) {
  return `${mode}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function createEmptyProgress(): InternalSyncProgress {
  return {
    runId: null,
    mode: null,
    status: "idle",
    isRunning: false,
    startedAt: null,
    completedAt: null,
    error: null,
    request: null,
    activeCompany: { index: 0, total: 0, name: null, guid: null },
    activeRange: { index: 0, total: 0, fromDate: null, toDate: null },
    activeModule: null,
    summary: {
      companiesTotal: 0,
      companiesCompleted: 0,
      rangesTotal: 0,
      rangesCompleted: 0,
      modulesTotal: 0,
      modulesCompleted: 0,
      totalRecords: 0,
      uploadedRecords: 0,
      failedRecords: 0,
      pendingRecords: 0,
      progressPercent: 0,
    },
    modules: {},
    events: [],
    lastResult: null,
  };
}

let progress = createEmptyProgress();

function recalculateSummary() {
  const modules = Object.values(progress.modules);

  const totalRecords = modules.reduce(
    (sum, item) => sum + item.totalRecords,
    0,
  );
  const uploadedRecords = modules.reduce(
    (sum, item) => sum + item.uploadedRecords,
    0,
  );
  const failedRecords = modules.reduce(
    (sum, item) => sum + item.failedRecords,
    0,
  );
  const modulesCompleted = modules.filter(
    (item) => item.status === "success" || item.status === "skipped",
  ).length;

  progress.summary.modulesTotal = modules.length;
  progress.summary.modulesCompleted = modulesCompleted;
  progress.summary.totalRecords = totalRecords;
  progress.summary.uploadedRecords = uploadedRecords;
  progress.summary.failedRecords = failedRecords;
  progress.summary.pendingRecords = Math.max(
    totalRecords - uploadedRecords - failedRecords,
    0,
  );
  progress.summary.progressPercent =
    totalRecords > 0
      ? Number(((uploadedRecords / totalRecords) * 100).toFixed(2))
      : 0;
}

export function makeModuleKey(input: {
  companyName?: string | null;
  moduleName: string;
  fromDate?: string | null;
  toDate?: string | null;
}) {
  return [
    input.companyName || "company",
    input.moduleName,
    input.fromDate || "master",
    input.toDate || "master",
  ]
    .join("|")
    .toLowerCase();
}

export function startSyncProgress(input: {
  mode: SyncMode;
  request?: any;
  companiesTotal?: number;
  rangesTotal?: number;
}) {
  progress = createEmptyProgress();
  progress.runId = createRunId(input.mode);
  progress.mode = input.mode;
  progress.status = "running";
  progress.isRunning = true;
  progress.startedAt = nowIso();
  progress.request = input.request || null;
  progress.summary.companiesTotal = input.companiesTotal || 0;
  progress.summary.rangesTotal = input.rangesTotal || 0;

  addSyncEvent({
    level: "info",
    message: `${input.mode} sync started`,
    details: input.request || null,
  });

  return getSyncProgress();
}

export function patchSyncProgress(patch: Partial<InternalSyncProgress>) {
  progress = {
    ...progress,
    ...patch,
    summary: {
      ...progress.summary,
      ...(patch.summary || {}),
    },
    activeCompany: {
      ...progress.activeCompany,
      ...(patch.activeCompany || {}),
    },
    activeRange: {
      ...progress.activeRange,
      ...(patch.activeRange || {}),
    },
  };

  recalculateSummary();
  return getSyncProgress();
}

export function setActiveCompany(input: {
  index: number;
  total: number;
  name: string;
  guid?: string | null;
}) {
  progress.activeCompany = { ...input };

  addSyncEvent({
    level: "info",
    message: `Company started: ${input.name}`,
    companyName: input.name,
  });

  return getSyncProgress();
}

export function completeCompany(name: string) {
  progress.summary.companiesCompleted += 1;

  addSyncEvent({
    level: "info",
    message: `Company completed: ${name}`,
    companyName: name,
  });

  recalculateSummary();
  return getSyncProgress();
}

export function setActiveRange(input: {
  index: number;
  total: number;
  fromDate: string;
  toDate: string;
  companyName?: string | null;
}) {
  progress.activeRange = {
    index: input.index,
    total: input.total,
    fromDate: input.fromDate,
    toDate: input.toDate,
  };

  addSyncEvent({
    level: "info",
    message: `Range started: ${input.fromDate} to ${input.toDate}`,
    companyName: input.companyName || null,
    fromDate: input.fromDate,
    toDate: input.toDate,
  });

  return getSyncProgress();
}

export function completeRange(input: {
  companyName?: string | null;
  fromDate: string;
  toDate: string;
}) {
  progress.summary.rangesCompleted += 1;

  addSyncEvent({
    level: "info",
    message: `Range completed: ${input.fromDate} to ${input.toDate}`,
    companyName: input.companyName || null,
    fromDate: input.fromDate,
    toDate: input.toDate,
  });

  recalculateSummary();
  return getSyncProgress();
}

export function upsertModuleProgress(
  input: Partial<SyncModuleProgress> & {
    moduleName: string;
    companyName?: string | null;
    companyGuid?: string | null;
    fromDate?: string | null;
    toDate?: string | null;
  },
) {
  const key = input.key || makeModuleKey(input);
  const existing = progress.modules[key];
  const startedAt = existing?.startedAt || nowIso();

  progress.modules[key] = {
    key,
    moduleName: input.moduleName,
    companyName: input.companyName ?? existing?.companyName ?? null,
    companyGuid: input.companyGuid ?? existing?.companyGuid ?? null,
    fromDate: input.fromDate ?? existing?.fromDate ?? null,
    toDate: input.toDate ?? existing?.toDate ?? null,
    status: input.status ?? existing?.status ?? "pending",
    totalRecords: input.totalRecords ?? existing?.totalRecords ?? 0,
    uploadedRecords: input.uploadedRecords ?? existing?.uploadedRecords ?? 0,
    failedRecords: input.failedRecords ?? existing?.failedRecords ?? 0,
    pendingRecords: input.pendingRecords ?? existing?.pendingRecords ?? 0,
    batchSize: input.batchSize ?? existing?.batchSize ?? 0,
    totalBatches: input.totalBatches ?? existing?.totalBatches ?? 0,
    uploadedBatches: input.uploadedBatches ?? existing?.uploadedBatches ?? 0,
    failedBatches: input.failedBatches ?? existing?.failedBatches ?? 0,
    currentBatch: input.currentBatch ?? existing?.currentBatch ?? 0,
    startedAt,
    completedAt: input.completedAt ?? existing?.completedAt ?? null,
    error: input.error ?? existing?.error ?? null,
  };

  progress.activeModule = input.moduleName;

  recalculateSummary();
  return getSyncProgress();
}

export function addSyncEvent(input: Omit<SyncProgressEvent, "at">) {
  progress.events.unshift({
    at: nowIso(),
    ...input,
  });

  progress.events = progress.events.slice(0, 80);

  return getSyncProgress();
}

export function finishSyncProgress(input: {
  status: "success" | "failed" | "cancelled";
  error?: string | null;
  lastResult?: any;
}) {
  progress.status = input.status;
  progress.isRunning = false;
  progress.completedAt = nowIso();
  progress.error = input.error || null;
  progress.lastResult = input.lastResult ?? progress.lastResult;

  addSyncEvent({
    level: input.status === "success" ? "info" : "error",
    message: `Sync ${input.status}`,
    details: input.error || null,
  });

  recalculateSummary();
  return getSyncProgress();
}

export function getSyncProgress(): SyncProgressSnapshot {
  recalculateSummary();

  return {
    ...progress,
    activeCompany: { ...progress.activeCompany },
    activeRange: { ...progress.activeRange },
    summary: { ...progress.summary },
    modules: Object.values(progress.modules),
    events: [...progress.events],
  };
}
