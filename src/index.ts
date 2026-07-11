import cors from "cors";
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cron from "node-cron";
import { updateTallyConnectionInCrm } from "./crm.client";
import {
  getHistoricalSyncStatus,
  startHistoricalSyncInBackground,
} from "./historical-sync.service";
import {
  getHistoricalTransactionsSyncStatus,
  startHistoricalTransactionsSyncInBackground,
} from "./historical-transactions.service";
import { runFullSync } from "./sync.service";
import { runDailySync } from "./daily-sync.service";
import { getTallyCompanyDiagnostics } from "./company-registry";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "./instance-lock";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || process.env.TALLY_AGENT_PORT || 5055);
const SYNC_CRON = process.env.SYNC_CRON || "*/10 * * * *";

acquireSingleInstanceLock("api-and-scheduler");

let isManualSyncRunning = false;
let lastManualSyncAt: string | null = null;
let lastManualSyncStartedAt: string | null = null;
let lastManualSyncCompletedAt: string | null = null;
let lastManualSyncStatus: "idle" | "running" | "success" | "failed" = "idle";
let lastManualSyncError: string | null = null;
let lastManualSyncResult: any = null;

function requireControlToken(req: Request, res: Response, next: NextFunction) {
  const expectedToken = process.env.TALLY_AGENT_TOKEN || "";
  const authHeader = req.headers.authorization || "";

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";

  if (!expectedToken) {
    return res.status(500).json({
      statusCode: 500,
      message: "TALLY_AGENT_TOKEN is missing in tally sync agent",
      data: null,
    });
  }

  if (!token || token !== expectedToken) {
    return res.status(401).json({
      statusCode: 401,
      message: "Invalid tally agent control token",
      data: null,
    });
  }

  return next();
}

function getAgentStatus() {
  return {
    service: "tally-sync-agent",
    status: lastManualSyncStatus,
    is_running: isManualSyncRunning,
    last_manual_sync_at: lastManualSyncAt,
    last_manual_sync_started_at: lastManualSyncStartedAt,
    last_manual_sync_completed_at: lastManualSyncCompletedAt,
    last_error: lastManualSyncError,
    last_result: lastManualSyncResult,
    time: new Date().toISOString(),
  };
}

function isHistoricalSyncActive() {
  const status = getHistoricalSyncStatus();

  return Boolean(status?.isRunning || status?.progress?.isRunning);
}

function isHistoricalTransactionsSyncActive() {
  const status = getHistoricalTransactionsSyncStatus();

  return Boolean(status?.isRunning);
}

function getCompactSyncResult(result: any) {
  if (!result) return null;

  return {
    skipped: result.skipped,
    status: result.status,
    syncMode: result.syncMode,
    companies: {
      count: result.companies?.count || 0,
      successCount: result.companies?.successCount || 0,
      failedCount: result.companies?.failedCount || 0,
    },
    totals: result.totals || {},
    companyResults: Array.isArray(result.companyResults)
      ? result.companyResults.map((item: any) => ({
          company: {
            name: item.company?.name || null,
            guid: item.company?.guid || null,
          },
          ledgers: {
            count: item.ledgers?.count || 0,
            uploadedRecords: item.ledgers?.result?.uploadedRecords || 0,
            failedRecords: item.ledgers?.result?.failedRecords || 0,
            successBatches: item.ledgers?.result?.successBatches || 0,
            failedBatches: item.ledgers?.result?.failedBatches || 0,
          },
          stockItems: {
            count: item.stockItems?.count || 0,
            uploadedRecords: item.stockItems?.result?.uploadedRecords || 0,
            failedRecords: item.stockItems?.result?.failedRecords || 0,
            successBatches: item.stockItems?.result?.successBatches || 0,
            failedBatches: item.stockItems?.result?.failedBatches || 0,
          },
          costCenters: {
            count: item.costCenters?.count || 0,
            uploadedRecords: item.costCenters?.result?.uploadedRecords || 0,
            failedRecords: item.costCenters?.result?.failedRecords || 0,
            successBatches: item.costCenters?.result?.successBatches || 0,
            failedBatches: item.costCenters?.result?.failedBatches || 0,
          },
        }))
      : [],
    failedCompanies: result.failedCompanies || [],
  };
}

function startHistoricalTransactionRoute(
  req: Request,
  res: Response,
  modules?: Array<
    | "sales-vouchers"
    | "purchase-vouchers"
    | "outstandings"
    | "delivery-challans"
  >,
) {
  if (isManualSyncRunning) {
    return res.status(409).json({
      statusCode: 409,
      message:
        "Manual sync is already running. Historical transaction sync skipped.",
      data: {
        agent: getAgentStatus(),
        historicalTransactions: getHistoricalTransactionsSyncStatus(),
      },
    });
  }

  if (isHistoricalSyncActive()) {
    return res.status(409).json({
      statusCode: 409,
      message:
        "Historical master sync is already running. Historical transaction sync skipped.",
      data: {
        agent: getAgentStatus(),
        historical: getHistoricalSyncStatus(),
        historicalTransactions: getHistoricalTransactionsSyncStatus(),
      },
    });
  }

  if (isHistoricalTransactionsSyncActive()) {
    return res.status(409).json({
      statusCode: 409,
      message: "Historical transaction sync is already running.",
      data: {
        agent: getAgentStatus(),
        historicalTransactions: getHistoricalTransactionsSyncStatus(),
      },
    });
  }

  const result = startHistoricalTransactionsSyncInBackground({
    fromDate: req.body?.fromDate || undefined,
    toDate: req.body?.toDate || undefined,
    companyName: req.body?.companyName || undefined,
    modules:
      modules ||
      (Array.isArray(req.body?.modules) ? req.body.modules : undefined),
    forceRestart: Boolean(req.body?.forceRestart),
  });

  return res.status(result.started ? 202 : 409).json({
    statusCode: result.started ? 202 : 409,
    message: result.message,
    data: result.data,
  });
}

/**
 * CRM backend will call this API for connection check.
 */
app.get("/health", requireControlToken, (_req: Request, res: Response) => {
  return res.json({
    statusCode: 200,
    message: "Tally sync agent is reachable",
    data: getAgentStatus(),
  });
});

app.get(
  "/diagnostics/companies",
  requireControlToken,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const diagnostics = await getTallyCompanyDiagnostics();

      return res.status(200).json({
        statusCode: 200,
        message: "Tally company diagnostics fetched",
        data: diagnostics,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * CRM backend will call this API from frontend Run Sync button.
 * This returns immediately and sync runs in background.
 */
app.post(
  "/sync/run",
  requireControlToken,
  async (req: Request, res: Response) => {
    if (isManualSyncRunning) {
      return res.status(409).json({
        statusCode: 409,
        message: "Tally sync is already running",
        data: getAgentStatus(),
      });
    }

    if (isHistoricalSyncActive()) {
      return res.status(409).json({
        statusCode: 409,
        message: "Historical sync is already running. Manual sync skipped.",
        data: {
          agent: getAgentStatus(),
          historical: getHistoricalSyncStatus(),
        },
      });
    }

    if (isHistoricalTransactionsSyncActive()) {
      return res.status(409).json({
        statusCode: 409,
        message:
          "Historical transaction sync is already running. Manual sync skipped.",
        data: {
          agent: getAgentStatus(),
          historicalTransactions: getHistoricalTransactionsSyncStatus(),
        },
      });
    }

    const companySelection = {
      companyName: req.body?.companyName || undefined,
      companyGuid: req.body?.companyGuid || undefined,
    };

    isManualSyncRunning = true;
    lastManualSyncStatus = "running";
    lastManualSyncStartedAt = new Date().toISOString();
    lastManualSyncCompletedAt = null;
    lastManualSyncError = null;
    lastManualSyncResult = null;

    res.json({
      statusCode: 200,
      message: "Tally sync started",
      data: getAgentStatus(),
    });

    try {
      console.log(`[MANUAL SYNC] Started at ${lastManualSyncStartedAt}`);

      const result = await runFullSync(companySelection);

      lastManualSyncAt = new Date().toISOString();
      lastManualSyncCompletedAt = lastManualSyncAt;
      lastManualSyncStatus = "success";

      const compactResult = getCompactSyncResult(result);

      lastManualSyncResult = compactResult;

      console.log("[MANUAL SYNC] Completed", compactResult);
    } catch (error: any) {
      lastManualSyncCompletedAt = new Date().toISOString();
      lastManualSyncStatus = "failed";
      lastManualSyncError = error?.message || "Manual sync failed";

      console.error("[MANUAL SYNC] Failed", error?.message || error);
    } finally {
      isManualSyncRunning = false;
    }
  },
);

/**
 * Optional old route.
 * Keep it for local testing but secure it also.
 */
app.post(
  "/sync-now",
  requireControlToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (isManualSyncRunning) {
        return res.status(409).json({
          statusCode: 409,
          message: "Tally sync is already running",
          data: getAgentStatus(),
        });
      }

      if (isHistoricalSyncActive()) {
        return res.status(409).json({
          statusCode: 409,
          message: "Historical sync is already running. Sync now skipped.",
          data: {
            agent: getAgentStatus(),
            historical: getHistoricalSyncStatus(),
          },
        });
      }

      if (isHistoricalTransactionsSyncActive()) {
        return res.status(409).json({
          statusCode: 409,
          message:
            "Historical transaction sync is already running. Sync now skipped.",
          data: {
            agent: getAgentStatus(),
            historicalTransactions: getHistoricalTransactionsSyncStatus(),
          },
        });
      }

      isManualSyncRunning = true;
      lastManualSyncStatus = "running";
      lastManualSyncStartedAt = new Date().toISOString();
      lastManualSyncCompletedAt = null;
      lastManualSyncError = null;
      lastManualSyncResult = null;

      const result = await runFullSync({
        companyName: req.body?.companyName || undefined,
        companyGuid: req.body?.companyGuid || undefined,
      });

      lastManualSyncAt = new Date().toISOString();
      lastManualSyncCompletedAt = lastManualSyncAt;
      lastManualSyncStatus = "success";
      const compactResult = getCompactSyncResult(result);

      lastManualSyncResult = compactResult;

      return res.json({
        statusCode: 200,
        message: "Tally sync completed",
        data: {
          ...getAgentStatus(),
          result: compactResult,
        },
      });
    } catch (error: any) {
      lastManualSyncCompletedAt = new Date().toISOString();
      lastManualSyncStatus = "failed";
      lastManualSyncError = error?.message || "Manual sync failed";

      next(error);
    } finally {
      isManualSyncRunning = false;
    }
  },
);

app.get("/sync/historical/status", requireControlToken, (_req, res) => {
  return res.status(200).json({
    statusCode: 200,
    message: "Historical sync status fetched",
    data: getHistoricalSyncStatus(),
  });
});

app.get("/sync/historical/progress", requireControlToken, (_req, res) => {
  const status = getHistoricalSyncStatus();

  return res.status(200).json({
    statusCode: 200,
    message: "Historical sync live progress fetched",
    data: status.live,
  });
});

app.post("/sync/historical", requireControlToken, (req, res) => {
  if (isManualSyncRunning) {
    return res.status(409).json({
      statusCode: 409,
      message: "Manual sync is already running. Historical sync skipped.",
      data: {
        agent: getAgentStatus(),
        historical: getHistoricalSyncStatus(),
      },
    });
  }

  if (isHistoricalTransactionsSyncActive()) {
    return res.status(409).json({
      statusCode: 409,
      message:
        "Historical transaction sync is already running. Historical master sync skipped.",
      data: {
        agent: getAgentStatus(),
        historicalTransactions: getHistoricalTransactionsSyncStatus(),
      },
    });
  }

  const result = startHistoricalSyncInBackground({
    startYear: req.body?.startYear ? Number(req.body.startYear) : undefined,
    fromDate: req.body?.fromDate || undefined,
    toDate: req.body?.toDate || undefined,
    companyName: req.body?.companyName || undefined,
    forceRestart: Boolean(req.body?.forceRestart),
  });

  return res.status(result.started ? 202 : 409).json({
    statusCode: result.started ? 202 : 409,
    message: result.message,
    data: result.data,
  });
});

app.get(
  "/sync/historical-transactions/status",
  requireControlToken,
  (_req, res) => {
    return res.status(200).json({
      statusCode: 200,
      message: "Historical transaction sync status fetched",
      data: getHistoricalTransactionsSyncStatus(),
    });
  },
);

app.get(
  "/sync/historical/sales-vouchers/status",
  requireControlToken,
  (_req, res) => {
    return res.status(200).json({
      statusCode: 200,
      message: "Historical sales vouchers sync status fetched",
      data: getHistoricalTransactionsSyncStatus(),
    });
  },
);

app.get(
  "/sync/historical/purchase-vouchers/status",
  requireControlToken,
  (_req, res) => {
    return res.status(200).json({
      statusCode: 200,
      message: "Historical purchase vouchers sync status fetched",
      data: getHistoricalTransactionsSyncStatus(),
    });
  },
);

app.get(
  "/sync/historical/outstandings/status",
  requireControlToken,
  (_req, res) => {
    return res.status(200).json({
      statusCode: 200,
      message: "Historical outstandings sync status fetched",
      data: getHistoricalTransactionsSyncStatus(),
    });
  },
);

app.get(
  "/sync/historical/delivery-challans/status",
  requireControlToken,
  (_req, res) => {
    return res.status(200).json({
      statusCode: 200,
      message: "Historical delivery challans sync status fetched",
      data: getHistoricalTransactionsSyncStatus(),
    });
  },
);

app.post("/sync/historical/sales-vouchers", requireControlToken, (req, res) =>
  startHistoricalTransactionRoute(req, res, ["sales-vouchers"]),
);

app.post(
  "/sync/historical/purchase-vouchers",
  requireControlToken,
  (req, res) =>
    startHistoricalTransactionRoute(req, res, ["purchase-vouchers"]),
);

app.post("/sync/historical/outstandings", requireControlToken, (req, res) =>
  startHistoricalTransactionRoute(req, res, ["outstandings"]),
);

app.post(
  "/sync/historical/delivery-challans",
  requireControlToken,
  (req, res) =>
    startHistoricalTransactionRoute(req, res, ["delivery-challans"]),
);

// Short aliases for RDP/manual use.
app.post("/sync/historical/so", requireControlToken, (req, res) =>
  startHistoricalTransactionRoute(req, res, ["sales-vouchers"]),
);

app.post("/sync/historical/po", requireControlToken, (req, res) =>
  startHistoricalTransactionRoute(req, res, ["purchase-vouchers"]),
);

app.post("/sync/historical/os", requireControlToken, (req, res) =>
  startHistoricalTransactionRoute(req, res, ["outstandings"]),
);

app.post("/sync/historical/dc", requireControlToken, (req, res) =>
  startHistoricalTransactionRoute(req, res, ["delivery-challans"]),
);

app.post("/sync/historical-transactions", requireControlToken, (req, res) => {
  return startHistoricalTransactionRoute(req, res);
});

/**
 * Alias for readability from CRM/backend/Postman.
 */
app.post("/sync/transactions/historical", requireControlToken, (req, res) => {
  return startHistoricalTransactionRoute(req, res);
});

if (process.env.DISABLE_AUTO_SYNC !== "true") {
  cron.schedule(SYNC_CRON, async () => {
    try {
      if (isManualSyncRunning) {
        console.log("[CRON SYNC] Skipped because manual sync is running");
        return;
      }

      if (isHistoricalSyncActive()) {
        console.log("[CRON SYNC] Skipped because historical sync is running");
        return;
      }

      if (isHistoricalTransactionsSyncActive()) {
        console.log(
          "[CRON SYNC] Skipped because historical transaction sync is running",
        );
        return;
      }

      console.log(`[CRON SYNC] Started at ${new Date().toISOString()}`);

      const result = await runDailySync();

      console.log("[CRON SYNC] Completed", result);
    } catch (error: any) {
      console.error("[CRON SYNC] Failed", error?.message || error);
    }
  });
} else {
  console.log(
    "[CRON SYNC] Auto sync is disabled via DISABLE_AUTO_SYNC=true only",
  );
}

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[AGENT ERROR]", error?.message || error);

  return res.status(500).json({
    statusCode: 500,
    message: error?.message || "Tally sync agent error",
    data: null,
  });
});

let isShuttingDown = false;

function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[AGENT] Shutting down via ${signal}`);
  releaseSingleInstanceLock();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => releaseSingleInstanceLock());

app.listen(PORT, () => {
  console.log(`Tally Sync Agent running on port ${PORT}`);
});
