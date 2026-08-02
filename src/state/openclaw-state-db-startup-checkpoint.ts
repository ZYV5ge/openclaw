import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { configureSqlitePreSchemaPragmas } from "../infra/sqlite-wal.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import {
  assertSupportedSchemaVersion,
  resolveDatabasePath,
} from "./openclaw-state-db-maintenance.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

function ensureStartupMigrationCheckpointSchema(db: DatabaseSync, pathname: string): void {
  runSqliteImmediateTransactionSync(
    db,
    () => {
      assertSupportedSchemaVersion(db, pathname);
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          agent_id TEXT,
          app_version TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS state_leases (
          scope TEXT NOT NULL,
          lease_key TEXT NOT NULL,
          owner TEXT NOT NULL,
          expires_at INTEGER,
          heartbeat_at INTEGER,
          payload_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, lease_key)
        );
        CREATE INDEX IF NOT EXISTS idx_state_leases_expiry
          ON state_leases(expires_at, scope, lease_key)
          WHERE expires_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_state_leases_owner
          ON state_leases(owner, updated_at DESC);
      `);
      ensureColumn(db, "schema_meta", "app_version TEXT");
    },
    {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      databaseLabel: pathname,
      operationLabel: "state.schema.ensure-startup-checkpoint",
    },
  );
}

export type OpenClawStateStartupMigrationCheckpointDatabasePurpose =
  | "bootstrap"
  | "verified-existing"
  | "lease-metadata";

export function withOpenClawStateStartupMigrationCheckpointDatabase<T>(
  callback: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions & {
    purpose?: OpenClawStateStartupMigrationCheckpointDatabasePurpose;
  } = {},
): T {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  const purpose = options.purpose ?? "bootstrap";
  if (purpose !== "bootstrap" && !existsSync(pathname)) {
    throw new Error(
      "OpenClaw state database disappeared before startup migration " +
        purpose +
        ": " +
        pathname,
    );
  }
  ensureOpenClawStatePermissions(pathname, env);
  const db = openNodeSqliteDatabase(pathname);
  try {
    if (purpose === "bootstrap") {
      configureSqlitePreSchemaPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      });
    } else {
      db.exec("PRAGMA busy_timeout = " + OPENCLAW_SQLITE_BUSY_TIMEOUT_MS + ";");
    }
    db.exec("PRAGMA trusted_schema = OFF;");
    // Gate future schemas before any full integrity check or schema write.
    assertSupportedSchemaVersion(db, pathname);
    if (purpose !== "lease-metadata") {
      assertSqliteIntegrity(db, pathname);
    }
    if (purpose === "bootstrap") {
      ensureStartupMigrationCheckpointSchema(db, pathname);
    }
    return callback(db);
  } finally {
    db.close();
    ensureOpenClawStatePermissions(pathname, env);
  }
}

// One-time seed for the ledger footprint aggregates (#100622): estimate rows
// written before the estimated_bytes columns existed, then roll them up per
// session. Zero is a safe "not seeded" sentinel because every real row costs
// at least its 32-byte overhead.
