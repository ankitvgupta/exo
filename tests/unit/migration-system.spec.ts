/**
 * Unit tests for the numbered migration system in db/index.ts.
 *
 * Since runNumberedMigrations is not exported, we test it indirectly by
 * replicating the migration logic against an in-memory SQLite database.
 * This validates the migration pattern itself: schema_version bootstrap,
 * forward-only application, skip semantics, and idempotency.
 */
import { test, expect } from "@playwright/test";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";

const require = createRequire(import.meta.url);

type DB = BetterSqlite3.Database;
let DatabaseCtor: (new (filename: string | Buffer, options?: BetterSqlite3.Options) => DB) | null =
  null;
let nativeModuleError: string | null = null;
try {
  DatabaseCtor = require("better-sqlite3");
  const testDb = new DatabaseCtor!(":memory:");
  testDb.close();
} catch (e: unknown) {
  const err = e as Error;
  if (
    err.message?.includes("NODE_MODULE_VERSION") ||
    err.message?.includes("did not self-register")
  ) {
    nativeModuleError = err.message.split("\n")[0];
  } else {
    throw e;
  }
}

// --- Mirror of the migration system from db/index.ts ---
// (replicated here because the function is not exported)

interface Migration {
  version: number;
  name: string;
  up: (db: DB) => void;
}

function runNumberedMigrations(db: DB, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const currentRow = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as
    | { version: number | null }
    | undefined;
  let currentVersion = currentRow?.version ?? -1;

  if (currentVersion === -1) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(0);
    currentVersion = 0;
  }

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      const runInTransaction = db.transaction(() => {
        migration.up(db);
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
      });
      runInTransaction();
      currentVersion = migration.version;
    }
  }
}

// --- Tests ---

test.describe("Numbered migration system", () => {
  test.skip(!!nativeModuleError, `Skipping: ${nativeModuleError}`);

  let testDb: DB;

  test.beforeEach(() => {
    testDb = new DatabaseCtor!(":memory:");
  });

  test.afterEach(() => {
    testDb?.close();
  });

  test("bootstrap: fresh DB gets schema_version table with version 0", () => {
    runNumberedMigrations(testDb, []);

    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    const row = testDb.prepare("SELECT MAX(version) as version FROM schema_version").get() as {
      version: number;
    };
    expect(row.version).toBe(0);
  });

  test("run: new migration applies correctly and creates the table", () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: "add_test_table",
        up: (db) => {
          db.exec("CREATE TABLE test_migration (id TEXT PRIMARY KEY, value TEXT)");
        },
      },
    ];

    runNumberedMigrations(testDb, migrations);

    // Table should exist
    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_migration'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    // Version should be 1
    const row = testDb.prepare("SELECT MAX(version) as version FROM schema_version").get() as {
      version: number;
    };
    expect(row.version).toBe(1);
  });

  test("skip: already-applied migrations don't re-run", () => {
    let runCount = 0;
    const migrations: Migration[] = [
      {
        version: 1,
        name: "counting_migration",
        up: (db) => {
          runCount++;
          db.exec("CREATE TABLE IF NOT EXISTS counter_test (id INTEGER)");
        },
      },
    ];

    // First run — should apply
    runNumberedMigrations(testDb, migrations);
    expect(runCount).toBe(1);

    // Second run — should skip
    runNumberedMigrations(testDb, migrations);
    expect(runCount).toBe(1);
  });

  test("idempotent: calling twice has no effect on schema_version rows", () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: "idempotent_test",
        up: (db) => {
          db.exec("CREATE TABLE IF NOT EXISTS idem_test (id INTEGER)");
        },
      },
    ];

    runNumberedMigrations(testDb, migrations);
    runNumberedMigrations(testDb, migrations);

    // schema_version should have exactly 2 rows: version 0 (baseline) + version 1
    const rows = testDb
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(rows).toEqual([{ version: 0 }, { version: 1 }]);
  });

  test("llm_calls table exists after running production migration list", () => {
    // Use the actual production migration (version 1: add_llm_calls_table)
    const productionMigrations: Migration[] = [
      {
        version: 1,
        name: "add_llm_calls_table",
        up: (db) => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS llm_calls (
              id TEXT PRIMARY KEY,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              model TEXT NOT NULL,
              caller TEXT NOT NULL,
              email_id TEXT,
              account_id TEXT,
              input_tokens INTEGER NOT NULL,
              output_tokens INTEGER NOT NULL,
              cache_read_tokens INTEGER DEFAULT 0,
              cache_create_tokens INTEGER DEFAULT 0,
              cost_cents REAL NOT NULL,
              duration_ms INTEGER NOT NULL,
              success INTEGER NOT NULL DEFAULT 1,
              error_message TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
            CREATE INDEX IF NOT EXISTS idx_llm_calls_caller ON llm_calls(caller);
          `);
        },
      },
    ];

    runNumberedMigrations(testDb, productionMigrations);

    // Verify llm_calls table exists with expected columns
    const columns = testDb.prepare("PRAGMA table_info(llm_calls)").all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("id");
    expect(columnNames).toContain("model");
    expect(columnNames).toContain("caller");
    expect(columnNames).toContain("cost_cents");
    expect(columnNames).toContain("cache_read_tokens");
    expect(columnNames).toContain("cache_create_tokens");
    expect(columnNames).toContain("success");
    expect(columnNames).toContain("error_message");
  });
});
