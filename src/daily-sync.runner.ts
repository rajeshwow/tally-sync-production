import "dotenv/config";
import cron from "node-cron";
import { runDailySync as executeDailySync } from "./daily-sync.service";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "./instance-lock";

type DailySyncSource = "startup" | "cron" | "manual";

const SYNC_INTERVAL_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES || 30);
const SYNC_CRON = process.env.SYNC_CRON || `*/${SYNC_INTERVAL_MINUTES} * * * *`;

acquireSingleInstanceLock("legacy-daily-runner");

let isDailySyncRunning = false;
let lastStartedAt: string | null = null;
let lastCompletedAt: string | null = null;
let lastStatus: "idle" | "running" | "success" | "partial_success" | "failed" =
  "idle";
let lastError: string | null = null;
let lastResult: any = null;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBoolEnv(name: string, fallback: boolean) {
  const raw = process.env[name];

  if (raw === undefined) return fallback;

  return ["1", "true", "yes", "y"].includes(raw.trim().toLowerCase());
}

function logStatus() {
  console.log("[DAILY SYNC STATUS]", {
    status: lastStatus,
    isRunning: isDailySyncRunning,
    lastStartedAt,
    lastCompletedAt,
    lastError,
    syncIntervalMinutes: SYNC_INTERVAL_MINUTES,
    syncCron: SYNC_CRON,
  });
}

async function runDailySync(source: DailySyncSource) {
  if (isDailySyncRunning) {
    console.log(`[DAILY SYNC:${source}] Skipped. Previous sync still running.`);
    return {
      skipped: true,
      message: "Previous daily sync is still running",
    };
  }

  isDailySyncRunning = true;
  lastStartedAt = new Date().toISOString();
  lastCompletedAt = null;
  lastStatus = "running";
  lastError = null;
  lastResult = null;

  try {
    console.log(`[DAILY SYNC:${source}] Started`, {
      startedAt: lastStartedAt,
    });

    const result = (await executeDailySync()) as any;

    lastCompletedAt = new Date().toISOString();
    lastResult = result;

    if (result?.status === "failed") {
      lastStatus = "failed";
      lastError = "All companies failed in daily sync";
    } else if (result?.status === "partial_success") {
      lastStatus = "partial_success";
    } else {
      lastStatus = "success";
    }

    console.log(`[DAILY SYNC:${source}] Completed`, {
      completedAt: lastCompletedAt,
      status: lastStatus,
      totals: result?.totals,
      companies: result?.companies?.count,
      failedCompanies: result?.failedCompanies?.length || 0,
    });

    return result;
  } catch (error: any) {
    lastCompletedAt = new Date().toISOString();
    lastStatus = "failed";
    lastError = error?.message || "Daily sync failed";

    console.error(`[DAILY SYNC:${source}] Failed`, {
      completedAt: lastCompletedAt,
      message: lastError,
    });

    throw error;
  } finally {
    isDailySyncRunning = false;
  }
}

async function runWhenTallyIsReady() {
  const runOnStart = readBoolEnv("DAILY_SYNC_RUN_ON_START", true);

  if (!runOnStart) {
    console.log(
      "[DAILY SYNC] Startup sync disabled by DAILY_SYNC_RUN_ON_START=false",
    );
    return;
  }

  const pollSeconds = Math.max(
    10,
    Number(process.env.DAILY_SYNC_STARTUP_POLL_SECONDS || 30),
  );

  const maxWaitMinutes = Number(
    process.env.DAILY_SYNC_STARTUP_MAX_WAIT_MINUTES || 0,
  );

  const startedAtMs = Date.now();

  console.log("[DAILY SYNC] Waiting for Tally + loaded companies", {
    pollSeconds,
    maxWaitMinutes: maxWaitMinutes || "unlimited",
  });

  while (true) {
    if (
      maxWaitMinutes > 0 &&
      Date.now() - startedAtMs > maxWaitMinutes * 60 * 1000
    ) {
      console.warn("[DAILY SYNC] Startup wait stopped. Max wait reached.");
      return;
    }

    try {
      const result = await runDailySync("startup");

      if (
        !result?.skipped &&
        (result?.status === "success" || result?.status === "partial_success")
      ) {
        console.log(
          "[DAILY SYNC] First startup sync done. Cron will continue future syncs.",
        );
        return;
      }

      if (result?.status === "failed") {
        console.warn("[DAILY SYNC] Startup sync failed. Will retry.");
      }
    } catch (error: any) {
      console.warn("[DAILY SYNC] Tally/CRM not ready yet. Will retry.", {
        message: error?.message || "Startup sync failed",
      });
    }

    await sleep(pollSeconds * 1000);
  }
}

function startDailySyncRunner() {
  if (readBoolEnv("DISABLE_AUTO_SYNC", false)) {
    console.log(
      "[DAILY SYNC] Disabled because DISABLE_AUTO_SYNC=true. Manual/historical APIs remain available through src/index.ts.",
    );
    return;
  }

  const enabled = readBoolEnv("DAILY_SYNC_ENABLED", true);

  if (!enabled) {
    console.log("[DAILY SYNC] Disabled by DAILY_SYNC_ENABLED=false");
    return;
  }

  console.log("[DAILY SYNC] Runner started", {
    syncIntervalMinutes: SYNC_INTERVAL_MINUTES,
    syncCron: SYNC_CRON,
  });

  logStatus();

  void runWhenTallyIsReady();

  cron.schedule(SYNC_CRON, async () => {
    try {
      await runDailySync("cron");
    } catch (error: any) {
      console.error("[DAILY SYNC:cron] Failed", error?.message || error);
    }
  });

  console.log("[DAILY SYNC] Cron scheduled");
}

process.on("SIGINT", () => {
  console.log("[DAILY SYNC] Stopped by SIGINT");
  releaseSingleInstanceLock();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[DAILY SYNC] Stopped by SIGTERM");
  releaseSingleInstanceLock();
  process.exit(0);
});

process.on("exit", () => releaseSingleInstanceLock());

startDailySyncRunner();
