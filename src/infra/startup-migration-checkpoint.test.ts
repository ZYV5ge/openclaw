// Startup migration checkpoint tests cover shared-state version records and leases.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const integrityProbe = vi.hoisted(() => ({
  afterNextFullCheck: null as (() => void) | null,
  failFullWith: null as Error | null,
  failTableWith: null as Error | null,
  fullChecks: 0,
  tableChecks: 0,
}));

vi.mock("./sqlite-integrity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sqlite-integrity.js")>();
  return {
    ...actual,
    assertSqliteIntegrity: (...args: Parameters<typeof actual.assertSqliteIntegrity>) => {
      integrityProbe.fullChecks += 1;
      const failure = integrityProbe.failFullWith;
      integrityProbe.failFullWith = null;
      if (failure) {
        throw failure;
      }
      const result = actual.assertSqliteIntegrity(...args);
      const afterCheck = integrityProbe.afterNextFullCheck;
      integrityProbe.afterNextFullCheck = null;
      afterCheck?.();
      return result;
    },
    assertSqliteTableIntegrity: (...args: Parameters<typeof actual.assertSqliteTableIntegrity>) => {
      integrityProbe.tableChecks += 1;
      const failure = integrityProbe.failTableWith;
      integrityProbe.failTableWith = null;
      if (failure) {
        throw failure;
      }
      return actual.assertSqliteTableIntegrity(...args);
    },
  };
});
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  acquireStartupMigrationLease,
  hasActiveStartupMigrationLease,
  needsStartupMigrationCheckpoint,
  readStartupMigrationVersion,
  recordSuccessfulStartupMigrations,
  type StartupMigrationLease,
} from "./startup-migration-checkpoint.js";

beforeEach(() => {
  integrityProbe.afterNextFullCheck = null;
  integrityProbe.failFullWith = null;
  integrityProbe.failTableWith = null;
  integrityProbe.fullChecks = 0;
  integrityProbe.tableChecks = 0;
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

const startupMigrationTempDirs = useAutoCleanupTempDirTracker(afterEach);

type StartupMigrationLeaseTestDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;


function releaseStartupMigrationLeaseAt(
  lease: StartupMigrationLease,
  nowMs: number,
): void {
  (lease.release as (params?: { nowMs?: number }) => void)({ nowMs });
}

function withRawStartupMigrationDatabase<T>(
  env: NodeJS.ProcessEnv,
  operation: (db: DatabaseSync) => T,
): T {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(resolveOpenClawStateSqlitePath(env));
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function overwriteStartupMigrationLeaseExpiresAt(
  env: NodeJS.ProcessEnv,
  expiresAt: number,
): void {
  withRawStartupMigrationDatabase(env, (db) => {
    db.prepare(
      "UPDATE state_leases SET expires_at = ? WHERE scope = ? AND lease_key = ?",
    ).run(expiresAt, "startup-migrations", "global");
  });
}

function overwriteStartupMigrationLeaseOwner(
  env: NodeJS.ProcessEnv,
  owner: string,
  expiresAt: number,
): void {
  withRawStartupMigrationDatabase(env, (db) => {
    db.prepare(
      "UPDATE state_leases SET owner = ?, expires_at = ? WHERE scope = ? AND lease_key = ?",
    ).run(owner, expiresAt, "startup-migrations", "global");
  });
}

function readStartupMigrationLeaseOwner(env: NodeJS.ProcessEnv): string | null {
  return withRawStartupMigrationDatabase(env, (db) => {
    const row = db
      .prepare(
        "SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?",
      )
      .get("startup-migrations", "global") as { owner?: unknown } | undefined;
    return typeof row?.owner === "string" ? row.owner : null;
  });
}

function dropStartupMigrationCheckpointTable(env: NodeJS.ProcessEnv): void {
  withRawStartupMigrationDatabase(env, (db) => {
    db.exec("DROP TABLE schema_meta;");
  });
}

function hasStartupMigrationCheckpointTable(env: NodeJS.ProcessEnv): boolean {
  return withRawStartupMigrationDatabase(env, (db) => {
    const row = db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
      )
      .get() as { ok?: unknown } | undefined;
    return row?.ok === 1;
  });
}

/** Rewrites only the recorded owner start time so the live owner PID looks recycled. */
function overwriteStartupMigrationLeaseOwnerStartedAt(
  env: NodeJS.ProcessEnv,
  startedAt: number,
): void {
  withOpenClawStateStartupMigrationCheckpointDatabase(
    (db) => {
      const kysely = getNodeSqliteKysely<StartupMigrationLeaseTestDatabase>(db);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely.selectFrom("state_leases").select("payload_json as payloadJson"),
      );
      const payload = JSON.parse(row?.payloadJson ?? "{}") as { owner?: { startedAt?: number } };
      executeSqliteQuerySync(
        db,
        kysely.updateTable("state_leases").set({
          payload_json: JSON.stringify({ ...payload, owner: { ...payload.owner, startedAt } }),
        }),
      );
    },
    { env },
  );
}

describe("startup migration checkpoint", () => {
  it("checks migration activity without creating shared state", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const dbPath = resolveOpenClawStateSqlitePath(env);

    expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.2-beta.6.1",
        buildIdentity: "frozen-sha",
      }),
    ).toBe(true);
    expect(integrityProbe.fullChecks).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("records the migrated OpenClaw version in shared state", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };

    expect(readStartupMigrationVersion(env)).toBeNull();
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:00:00.000Z",
      }),
    ).toBe(true);

    recordSuccessfulStartupMigrations({
      env,
      version: "2026.7.1",
      buildIdentity: "2026-07-11T00:00:00.000Z",
      nowMs: 1234,
    });

    expect(readStartupMigrationVersion(env)).toBe("2026.7.1");
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:01:00.000Z",
      }),
    ).toBe(true);
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.2",
        buildIdentity: "2026-07-11T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("keeps the fast path disabled without immutable build provenance", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };

    recordSuccessfulStartupMigrations({
      env,
      version: "2026.7.1",
      buildIdentity: null,
      nowMs: 1234,
    });

    expect(needsStartupMigrationCheckpoint({ env, version: "2026.7.1", buildIdentity: null })).toBe(
      true,
    );
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("serializes startup migrations with an expiring shared-state lease", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });

    expect(hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toBe(true);

    expect(() => acquireStartupMigrationLease({ env, nowMs: 1001, owner: "second" })).toThrow(
      `OpenClaw startup migrations are already running for this state directory; retry after the other gateway finishes or after 1970-01-01T00:05:01.000Z. (held by pid ${process.pid})`,
    );

    releaseStartupMigrationLeaseAt(lease, 1002);

    expect(hasActiveStartupMigrationLease({ env, nowMs: 1002 })).toBe(false);

    const next = acquireStartupMigrationLease({ env, nowMs: 1002, owner: "second" });
    releaseStartupMigrationLeaseAt(next, 1003);
  });

  it("reclaims an active startup migration lease whose owner process is gone", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const deadPid = 2_147_483_647;
    const stale = acquireStartupMigrationLease({
      env,
      nowMs: 1000,
      owner: "stale",
      ownerPid: deadPid,
    });

    expect(hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toBe(false);

    const replacement = acquireStartupMigrationLease({ env, nowMs: 1001, owner: "replacement" });
    releaseStartupMigrationLeaseAt(stale, 1002);
    expect(hasActiveStartupMigrationLease({ env, nowMs: 1002 })).toBe(true);
    releaseStartupMigrationLeaseAt(replacement, 1003);
  });

  // PID numbers are recycled by the OS. Without the start-time guard a stale lease whose PID was
  // reassigned to an unrelated live process would block startup for the full TTL.
  it.skipIf(process.platform === "win32")(
    "reclaims a startup migration lease whose owner PID was recycled",
    () => {
      const env = {
        OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
      };
      const stale = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "stale" });

      // The owner PID is this live test process; only the recorded start identity is stale.
      overwriteStartupMigrationLeaseOwnerStartedAt(env, 1);

      expect(hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toBe(false);

      const replacement = acquireStartupMigrationLease({ env, nowMs: 1001, owner: "replacement" });
      releaseStartupMigrationLeaseAt(stale, 1002);
      expect(hasActiveStartupMigrationLease({ env, nowMs: 1002 })).toBe(true);
      releaseStartupMigrationLeaseAt(replacement, 1003);
    },
  );

  it("does not report an expired startup migration lease as active", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });

    expect(hasActiveStartupMigrationLease({ env, nowMs: 301_001 })).toBe(false);

    releaseStartupMigrationLeaseAt(lease, 301_001);
  });

  it("renews startup migration leases while the owner is still running", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });

    lease.heartbeat({ nowMs: 300_000 });

    expect(() => acquireStartupMigrationLease({ env, nowMs: 301_001, owner: "second" })).toThrow(
      "OpenClaw startup migrations are already running",
    );

    releaseStartupMigrationLeaseAt(lease, 301_002);
  });

  it("does not checkpoint startup migrations after the lease is lost", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const first = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });
    const second = acquireStartupMigrationLease({ env, nowMs: 400_000, owner: "second" });

    expect(() =>
      recordSuccessfulStartupMigrations({
        env,
        lease: first,
        version: "2026.7.1",
        nowMs: 400_001,
      }),
    ).toThrow("startup migration lease was lost");
    expect(readStartupMigrationVersion(env)).toBeNull();

    releaseStartupMigrationLeaseAt(second, 400_002);
  });

  it("reads the checkpoint without requiring the full state schema to be canonical", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const sqlite = requireNodeSqlite();
    const dbPath = resolveOpenClawStateSqlitePath(env);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL PRIMARY KEY,
        path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        size_bytes INTEGER
      );
    `);
    db.close();

    expect(needsStartupMigrationCheckpoint({ env, version: "2026.7.1" })).toBe(true);
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });
    releaseStartupMigrationLeaseAt(lease, 1001);
  });

  it("refuses future-version state databases before creating checkpoint tables", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const sqlite = requireNodeSqlite();
    const dbPath = resolveOpenClawStateSqlitePath(env);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    db.close();

    expect(() =>
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.2-beta.6.1",
        buildIdentity: "frozen-sha",
      }),
    ).toThrow("newer schema version " + String(OPENCLAW_STATE_SCHEMA_VERSION + 1));
    expect(integrityProbe.fullChecks).toBe(0);
    expect(integrityProbe.tableChecks).toBe(0);

    expect(() => acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" })).toThrow(
      `newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
    );

    const verify = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = verify
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'state_leases'")
      .get() as { ok?: unknown } | undefined;
    verify.close();
    expect(row).toBeUndefined();
  });

  it("runs full integrity only at acquire and post-migration record boundaries", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };

    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.2-beta.6.1",
        buildIdentity: "frozen-sha",
      }),
    ).toBe(true);

    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });
    lease.heartbeat({ nowMs: 1100 });
    lease.heartbeat({ nowMs: 1200 });
    lease.heartbeat({ nowMs: 1300 });

    expect(integrityProbe.fullChecks).toBe(1);

    recordSuccessfulStartupMigrations({
      env,
      lease,
      version: "2026.7.2-beta.6.1",
      buildIdentity: "frozen-sha",
      nowMs: 1400,
    });
    releaseStartupMigrationLeaseAt(lease, 1500);

    expect(integrityProbe.fullChecks).toBe(2);
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.2-beta.6.1",
        buildIdentity: "frozen-sha",
      }),
    ).toBe(false);
    expect(integrityProbe.fullChecks).toBe(2);
  });

  it("fails closed when the checkpoint table integrity check fails", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    recordSuccessfulStartupMigrations({
      env,
      version: "2026.7.2-beta.6.1",
      buildIdentity: "frozen-sha",
      nowMs: 1000,
    });
    integrityProbe.fullChecks = 0;
    integrityProbe.tableChecks = 0;
    integrityProbe.failTableWith = new Error("schema_meta table is corrupt");

    expect(() =>
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.2-beta.6.1",
        buildIdentity: "frozen-sha",
      }),
    ).toThrow("schema_meta table is corrupt");
    expect(integrityProbe.fullChecks).toBe(0);
  });

  it("fails closed when the lease table integrity check fails", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });
    integrityProbe.fullChecks = 0;
    integrityProbe.tableChecks = 0;
    integrityProbe.failTableWith = new Error("state_leases table is corrupt");

    expect(() => hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toThrow(
      "state_leases table is corrupt",
    );
    expect(integrityProbe.fullChecks).toBe(0);

    releaseStartupMigrationLeaseAt(lease, 1002);
  });

  it("starts the acquisition TTL after its full integrity check", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    integrityProbe.afterNextFullCheck = () => {
      now.mockReturnValue(400_000);
    };

    const lease = acquireStartupMigrationLease({ env, owner: "first" });

    expect(hasActiveStartupMigrationLease({ env, nowMs: 400_001 })).toBe(true);
    releaseStartupMigrationLeaseAt(lease, 400_002);
  });

  it("checks lease expiry using time captured after post-migration integrity", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });
    const now = vi.spyOn(Date, "now").mockReturnValue(1001);
    integrityProbe.afterNextFullCheck = () => {
      now.mockReturnValue(301_001);
    };

    expect(() =>
      recordSuccessfulStartupMigrations({
        env,
        lease,
        version: "2026.7.2-beta.6.1",
        buildIdentity: "frozen-sha",
      }),
    ).toThrow("startup migration lease was lost");
    expect(readStartupMigrationVersion(env)).toBeNull();
  });

  it("does not write the checkpoint when post-migration integrity fails", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });
    integrityProbe.failFullWith = new Error("post-migration integrity failed");

    expect(() =>
      recordSuccessfulStartupMigrations({
        env,
        lease,
        version: "2026.7.2-beta.6.1",
        buildIdentity: "frozen-sha",
        nowMs: 1001,
      }),
    ).toThrow("post-migration integrity failed");
    expect(readStartupMigrationVersion(env)).toBeNull();

    releaseStartupMigrationLeaseAt(lease, 1002);
    expect(integrityProbe.fullChecks).toBe(2);
  });

  it("does not delete an expired lease during idempotent release", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });
    overwriteStartupMigrationLeaseExpiresAt(env, 1000);
    integrityProbe.fullChecks = 0;

    releaseStartupMigrationLeaseAt(lease, 1000);

    expect(integrityProbe.fullChecks).toBe(0);
    expect(readStartupMigrationLeaseOwner(env)).toBe("first");
  });

  it("does not recreate checkpoint schema after a leased migration loses the table", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });
    dropStartupMigrationCheckpointTable(env);
    integrityProbe.fullChecks = 0;

    expect(() =>
      recordSuccessfulStartupMigrations({
        env,
        lease,
        version: "2026.7.2-beta.6.1",
        buildIdentity: "frozen-sha",
        nowMs: 1001,
      }),
    ).toThrow();
    expect(hasStartupMigrationCheckpointTable(env)).toBe(false);
    expect(integrityProbe.fullChecks).toBe(1);

    releaseStartupMigrationLeaseAt(lease, 1002);
  });

  it("rejects a lease owner replaced after post-migration integrity", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });
    integrityProbe.fullChecks = 0;
    integrityProbe.afterNextFullCheck = () => {
      overwriteStartupMigrationLeaseOwner(env, "second", 400_000);
    };

    expect(() =>
      recordSuccessfulStartupMigrations({
        env,
        lease,
        version: "2026.7.2-beta.6.1",
        buildIdentity: "frozen-sha",
        nowMs: 1001,
      }),
    ).toThrow("startup migration lease was lost");
    expect(readStartupMigrationVersion(env)).toBeNull();
    expect(integrityProbe.fullChecks).toBe(1);

    releaseStartupMigrationLeaseAt(lease, 1002);
  });
});
