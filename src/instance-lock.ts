import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

type LockPayload = {
  token: string;
  pid: number;
  hostname: string;
  role: string;
  startedAt: string;
};

let activeLockPath: string | null = null;
let activeToken: string | null = null;

function getDefaultLockFile() {
  if (process.platform === "win32") {
    const programData = process.env.ProgramData || "C:\\ProgramData";
    return path.join(programData, "FlexLoud", "tally-sync-agent.lock");
  }

  return path.join(os.tmpdir(), "flexloud-tally-sync-agent.lock");
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM generally means the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

function readExistingLock(lockFile: string): LockPayload | null {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
}

export function acquireSingleInstanceLock(role: string) {
  const lockFile = path.resolve(
    String(process.env.AGENT_LOCK_FILE || getDefaultLockFile()),
  );

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  const existing = readExistingLock(lockFile);

  if (existing && isProcessAlive(Number(existing.pid))) {
    throw new Error(
      `Another Tally sync agent is already running. pid=${existing.pid}, role=${existing.role}, host=${existing.hostname}, startedAt=${existing.startedAt}, lock=${lockFile}`,
    );
  }

  if (fs.existsSync(lockFile)) {
    fs.unlinkSync(lockFile);
  }

  const payload: LockPayload = {
    token: crypto.randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    role,
    startedAt: new Date().toISOString(),
  };

  const fd = fs.openSync(lockFile, "wx");

  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf8");
  } finally {
    fs.closeSync(fd);
  }

  activeLockPath = lockFile;
  activeToken = payload.token;

  console.log("[AGENT LOCK] Acquired", {
    lockFile,
    pid: payload.pid,
    role: payload.role,
    hostname: payload.hostname,
  });

  return payload;
}

export function releaseSingleInstanceLock() {
  if (!activeLockPath || !activeToken) return;

  try {
    const current = readExistingLock(activeLockPath);

    if (current?.token === activeToken) {
      fs.unlinkSync(activeLockPath);
      console.log("[AGENT LOCK] Released", { lockFile: activeLockPath });
    }
  } catch (error: any) {
    console.warn("[AGENT LOCK] Release failed", {
      lockFile: activeLockPath,
      error: error?.message || error,
    });
  } finally {
    activeLockPath = null;
    activeToken = null;
  }
}
