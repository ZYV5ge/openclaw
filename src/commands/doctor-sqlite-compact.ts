/** Shared doctor-only SQLite compaction mechanics. */
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tryReadDiskSpace } from "../infra/disk-space.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";

const DOCTOR_SQLITE_COMPACTION_HEADROOM_BYTES = 2n * 1024n * 1024n * 1024n;

export type DoctorSqliteDiskSpaceStage =
  | "before-import"
  | "before-schema-migration"
  | "before-compact-open"
  | "after-schema-migration-before-compact";

export type DoctorSqliteDiskSpaceErrorCode =
  | "sqlite_compact_insufficient_disk"
  | "sqlite_compact_disk_space_unavailable";

type DoctorSqliteDiskSpaceErrorParams = {
  availableBytes?: number;
  code: DoctorSqliteDiskSpaceErrorCode;
  dbSizeBytes?: number;
  message: string;
  reason?: string;
  requiredBytes?: number;
  sqlitePath: string;
  stage: DoctorSqliteDiskSpaceStage;
  walSizeBytes?: number;
};

export class DoctorSqliteDiskSpaceError extends Error {
  readonly availableBytes?: number;
  readonly code: DoctorSqliteDiskSpaceErrorCode;
  readonly dbSizeBytes?: number;
  readonly reason?: string;
  readonly requiredBytes?: number;
  readonly sqlitePath: string;
  readonly stage: DoctorSqliteDiskSpaceStage;
  readonly walSizeBytes?: number;

  constructor(params: DoctorSqliteDiskSpaceErrorParams) {
    super(params.message);
    this.name = "DoctorSqliteDiskSpaceError";
    this.code = params.code;
    this.sqlitePath = params.sqlitePath;
    this.stage = params.stage;
    if (params.availableBytes !== undefined) {
      this.availableBytes = params.availableBytes;
    }
    if (params.dbSizeBytes !== undefined) {
      this.dbSizeBytes = params.dbSizeBytes;
    }
    if (params.reason !== undefined) {
      this.reason = params.reason;
    }
    if (params.requiredBytes !== undefined) {
      this.requiredBytes = params.requiredBytes;
    }
    if (params.walSizeBytes !== undefined) {
      this.walSizeBytes = params.walSizeBytes;
    }
  }
}

export function isDoctorSqliteDiskSpaceError(
  error: unknown,
): error is DoctorSqliteDiskSpaceError {
  return error instanceof DoctorSqliteDiskSpaceError;
}
export type DoctorSqliteCompactSnapshot = {
  autoVacuum: number;
  dbSizeBytes: number;
  freelistPages: number;
  pageSizeBytes: number;
  walSizeBytes: number;
};

type DoctorSqliteCompactResult = {
  after: DoctorSqliteCompactSnapshot;
  before: DoctorSqliteCompactSnapshot;
  integrityCheck: "ok";
  reclaimedBytes: number;
};

type DoctorSqliteCompactOptions = {
  afterSuccess?: () => void;
  busyTimeoutMs?: number;
  preflightStage?: DoctorSqliteDiskSpaceStage;
  sqlitePath: string;
  validateBeforeMutation?: (database: DatabaseSync) => void;
};

export function assertDoctorSqliteCompactionDiskSpace(params: {
  sqlitePath: string;
  stage: DoctorSqliteDiskSpaceStage;
}): void {
  let dbSizeBytes: number;
  let walSizeBytes: number;
  try {
    dbSizeBytes = fileSize(params.sqlitePath);
    walSizeBytes = fileSize(`${params.sqlitePath}-wal`);
  } catch {
    throw createDiskSpaceUnavailableError({
      reason: "database or WAL size could not be read safely",
      sqlitePath: params.sqlitePath,
      stage: params.stage,
    });
  }
  if (!isSafeByteCount(dbSizeBytes) || !isSafeByteCount(walSizeBytes)) {
    throw createDiskSpaceUnavailableError({
      reason: "database or WAL size was not a safe non-negative integer",
      sqlitePath: params.sqlitePath,
      stage: params.stage,
    });
  }

  const requiredBytesBigInt =
    2n * (BigInt(dbSizeBytes) + BigInt(walSizeBytes)) +
    DOCTOR_SQLITE_COMPACTION_HEADROOM_BYTES;
  if (requiredBytesBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw createDiskSpaceUnavailableError({
      dbSizeBytes,
      reason: "required compaction headroom exceeded the safe numeric range",
      sqlitePath: params.sqlitePath,
      stage: params.stage,
      walSizeBytes,
    });
  }
  const requiredBytes = Number(requiredBytesBigInt);
  let diskSpace: ReturnType<typeof tryReadDiskSpace>;
  try {
    diskSpace = tryReadDiskSpace(params.sqlitePath);
  } catch {
    diskSpace = null;
  }
  if (!diskSpace || !isSafeByteCount(diskSpace.availableBytes)) {
    throw createDiskSpaceUnavailableError({
      dbSizeBytes,
      reason: "available disk space could not be read as a safe non-negative integer",
      requiredBytes,
      sqlitePath: params.sqlitePath,
      stage: params.stage,
      walSizeBytes,
    });
  }
  if (diskSpace.availableBytes < requiredBytes) {
    throw new DoctorSqliteDiskSpaceError({
      availableBytes: diskSpace.availableBytes,
      code: "sqlite_compact_insufficient_disk",
      dbSizeBytes,
      message: buildDoctorSqliteDiskSpaceMessage({
        availableBytes: diskSpace.availableBytes,
        requiredBytes,
        stage: params.stage,
      }),
      requiredBytes,
      sqlitePath: params.sqlitePath,
      stage: params.stage,
      walSizeBytes,
    });
  }
}
/**
 * Compact one SQLite file during an explicit offline doctor operation.
 *
 * Validation runs before the first checkpoint because checkpointing mutates
 * the database files. A busy checkpoint is a hard failure, never partial
 * success, so VACUUM cannot race an active reader or writer.
 */
export function compactDoctorSqliteFile(
  options: DoctorSqliteCompactOptions,
): DoctorSqliteCompactResult {
  assertDoctorSqliteCompactionDiskSpace({
    sqlitePath: options.sqlitePath,
    stage: options.preflightStage ?? "before-compact-open",
  });
  const database = openNodeSqliteDatabase(options.sqlitePath);
  let operationError: unknown;
  let result: DoctorSqliteCompactResult | undefined;
  try {
    database.exec(
      `PRAGMA busy_timeout = ${options.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`,
    );
    database.exec("PRAGMA trusted_schema = OFF;");
    options.validateBeforeMutation?.(database);
    const before = readCompactSnapshot(database, options.sqlitePath);
    assertSqliteIntegrity(database, options.sqlitePath);
    checkpointTruncate(database, options.sqlitePath);
    database.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    database.exec("VACUUM;");
    checkpointTruncate(database, options.sqlitePath);
    const { integrityCheck } = assertSqliteIntegrity(database, options.sqlitePath);
    const after = readCompactSnapshot(database, options.sqlitePath);
    const beforeBytes = before.dbSizeBytes + before.walSizeBytes;
    const afterBytes = after.dbSizeBytes + after.walSizeBytes;
    result = {
      after,
      before,
      integrityCheck,
      reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
    };
  } catch (error) {
    operationError = error;
  }
  try {
    database.close();
  } catch (error) {
    operationError ??= error;
  }
  if (operationError === undefined && result) {
    try {
      options.afterSuccess?.();
    } catch (error) {
      operationError ??= error;
    }
  }
  if (operationError !== undefined) {
    throw operationError instanceof Error
      ? operationError
      : new Error("SQLite compaction failed with a non-Error value.");
  }
  if (!result) {
    throw new Error(`SQLite compaction produced no result for ${options.sqlitePath}.`);
  }
  return result;
}

function createDiskSpaceUnavailableError(params: {
  dbSizeBytes?: number;
  reason: string;
  requiredBytes?: number;
  sqlitePath: string;
  stage: DoctorSqliteDiskSpaceStage;
  walSizeBytes?: number;
}): DoctorSqliteDiskSpaceError {
  return new DoctorSqliteDiskSpaceError({
    code: "sqlite_compact_disk_space_unavailable",
    message: buildDoctorSqliteDiskSpaceMessage({ reason: params.reason, stage: params.stage }),
    reason: params.reason,
    sqlitePath: params.sqlitePath,
    stage: params.stage,
    ...(params.dbSizeBytes !== undefined ? { dbSizeBytes: params.dbSizeBytes } : {}),
    ...(params.requiredBytes !== undefined ? { requiredBytes: params.requiredBytes } : {}),
    ...(params.walSizeBytes !== undefined ? { walSizeBytes: params.walSizeBytes } : {}),
  });
}

function buildDoctorSqliteDiskSpaceMessage(params: {
  availableBytes?: number;
  reason?: string;
  requiredBytes?: number;
  stage: DoctorSqliteDiskSpaceStage;
}): string {
  const detail =
    params.availableBytes !== undefined && params.requiredBytes !== undefined
      ? `only ${params.availableBytes} bytes are available; at least ${params.requiredBytes} bytes are required`
      : `safe disk-space information is unavailable (${params.reason ?? "unknown reason"})`;
  switch (params.stage) {
    case "before-import":
      return `Doctor stopped before session SQLite import because ${detail}.`;
    case "before-schema-migration":
      return `Doctor stopped before session SQLite schema migration because ${detail}.`;
    case "after-schema-migration-before-compact":
      return `Session SQLite schema migration and import completed (the schema may already have been current); VACUUM was not started because ${detail}.`;
    case "before-compact-open":
      return `Doctor stopped before opening SQLite for compaction because ${detail}.`;
    default:
      return `Doctor stopped before SQLite compaction because ${detail}.`;
  }
}

function isSafeByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function checkpointTruncate(database: DatabaseSync, sqlitePath: string): void {
  const row = database.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get() as
    | Record<string, unknown>
    | undefined;
  const busy = readFiniteNumber(row?.busy ?? (row ? Object.values(row)[0] : undefined));
  if (busy === undefined) {
    throw new Error(`SQLite checkpoint returned an invalid result for ${sqlitePath}.`);
  }
  if (busy !== 0) {
    throw new Error(`SQLite checkpoint remained busy for ${sqlitePath}. Stop OpenClaw and retry.`);
  }
}

function readCompactSnapshot(
  database: DatabaseSync,
  sqlitePath: string,
): DoctorSqliteCompactSnapshot {
  return {
    autoVacuum: readPragmaNumber(database, "auto_vacuum"),
    dbSizeBytes: fileSize(sqlitePath),
    freelistPages: readPragmaNumber(database, "freelist_count"),
    pageSizeBytes: readPragmaNumber(database, "page_size"),
    walSizeBytes: fileSize(`${sqlitePath}-wal`),
  };
}

function readPragmaNumber(
  database: DatabaseSync,
  pragmaName: "auto_vacuum" | "freelist_count" | "page_size",
): number {
  const row = database.prepare(`PRAGMA ${pragmaName};`).get() as
    | Record<string, unknown>
    | undefined;
  const value = readFiniteNumber(row?.[pragmaName] ?? (row ? Object.values(row)[0] : undefined));
  if (value === undefined) {
    throw new Error(`SQLite PRAGMA ${pragmaName} returned an invalid result.`);
  }
  return value;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  return undefined;
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}
