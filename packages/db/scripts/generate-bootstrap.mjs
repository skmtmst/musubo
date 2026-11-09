import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const SCHEMA_PATH = join(PKG_ROOT, "schema.sql");
const MIGRATIONS_DIR = join(PKG_ROOT, "migrations");
const BOOTSTRAP_PATH = join(PKG_ROOT, "bootstrap.sql");
const BOOTSTRAP_META_PATH = join(PKG_ROOT, "bootstrap-meta.json");

const BENIGN_SQLITE_ERROR = /duplicate column name|already exists/i;

function listMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]) || a.localeCompare(b));
}

function isBenignSqliteError(error) {
  return error instanceof Error && BENIGN_SQLITE_ERROR.test(error.message);
}

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function applyMigrationFile(db, fileName) {
  const sql = readFileSync(join(MIGRATIONS_DIR, fileName), "utf8");
  for (const statement of splitSqlStatements(sql)) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!isBenignSqliteError(error)) {
        throw new Error(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function buildBootstrapSql() {
  const sqlitePath = join(
    tmpdir(),
    `line-harness-bootstrap-${process.pid}-${Date.now()}.sqlite`,
  );
  const db = new Database(sqlitePath);
  const migrationFiles = listMigrationFiles();

  try {
    db.exec(readFileSync(SCHEMA_PATH, "utf8"));

    for (const file of migrationFiles) {
      applyMigrationFile(db, file);
    }

    const rows = db
      .prepare(
        `
          SELECT type, name, sql
          FROM sqlite_master
          WHERE sql IS NOT NULL
            AND name NOT LIKE 'sqlite_%'
            -- _migrations は配備script が持つ「どこまで当てたか」の記録で、
            -- アプリのスキーマではない。焼き込むと、これを作るマイグレーションの
            -- 目印と見なされ、判定器が当たっていないものを partial と読む。
            AND name <> '_migrations'
          ORDER BY
            CASE type
              WHEN 'table' THEN 0
              WHEN 'index' THEN 1
              WHEN 'trigger' THEN 2
              WHEN 'view' THEN 3
              ELSE 4
            END,
            name
        `,
      )
      .all();

    const header = [
      "-- Generated from schema.sql + migrations by scripts/generate-bootstrap.mjs.",
      "-- Do not edit manually. Run `pnpm --dir packages/db generate:bootstrap`.",
      "",
    ].join("\n");

    const body = rows
      .map((row) => `${String(row.sql).trim()};`)
      .join("\n\n");

    // sqlite_master contains schema objects but not migration seed rows.
    const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
    const sqlValue = (value) => value === null ? 'NULL' : typeof value === 'number' ? String(value) : quote(value);
    const normalColumns = ['id', 'condition_key', 'version', 'name', 'status', 'trial_unit',
      'trial_value', 'line_discount_percent', 'price_schedule_json', 'created_by', 'created_at', 'activated_at'];
    const normalCondition = db.prepare(`SELECT ${normalColumns.join(',')} FROM musubo_pricing_conditions WHERE id='normal'`).get();
    const normalSeed = normalCondition
      ? `INSERT OR IGNORE INTO musubo_pricing_conditions (${normalColumns.join(',')}) VALUES (${normalColumns.map((key) => sqlValue(normalCondition[key])).join(',')});`
      : '';
    // Fresh databases need the fixed tenant and the editable default pricing condition.
    const seedData = [
      "-- Seed data required by tenant-aware inserts on a fresh database.",
      "INSERT OR IGNORE INTO tenants (id, name) VALUES",
      "  ('00000000-0000-4000-8000-000000000001', '既定の統括');",
      normalSeed,
    ].join("\n");


    // 固定7欄は新規DBにも必要。schemaだけでは対応表が空になる。
    const fixedRows = db.prepare(`SELECT fixed.fixed_key, f.id, f.name, f.field_key, f.type, f.display_order
      FROM friend_fixed_fields fixed JOIN friend_fields f ON f.id = fixed.field_id
      ORDER BY f.display_order`).all();
    const fixedSeed = fixedRows.map(row =>
      `INSERT OR IGNORE INTO friend_fields (id,name,field_key,type,source,is_personal,display_order) VALUES (${[row.id,row.name,row.field_key,row.type].map(quote).join(',')},'form',1,${row.display_order});\nINSERT OR IGNORE INTO friend_fixed_fields (fixed_key,field_id) VALUES (${quote(row.fixed_key)},${quote(row.id)});`
    ).join('\n');
    return {
      sql: `${header}${body}\n\n${seedData}\n\n${fixedSeed}\n`,
      meta: {
        includedMigrations: migrationFiles,
        migrationCount: migrationFiles.length,
      },
    };
  } finally {
    db.close();
    if (existsSync(sqlitePath)) {
      rmSync(sqlitePath, { force: true });
    }
  }
}

const generated = buildBootstrapSql();
const wantsStdout = process.argv.includes("--stdout");
const wantsCheck = process.argv.includes("--check");

if (wantsStdout) {
  process.stdout.write(generated.sql);
  process.exit(0);
}

if (wantsCheck) {
  const current = existsSync(BOOTSTRAP_PATH)
    ? readFileSync(BOOTSTRAP_PATH, "utf8")
    : "";
  const currentMeta = existsSync(BOOTSTRAP_META_PATH)
    ? readFileSync(BOOTSTRAP_META_PATH, "utf8")
    : "";
  const nextMeta = `${JSON.stringify(generated.meta, null, 2)}\n`;
  if (current !== generated.sql || currentMeta !== nextMeta) {
    console.error(
      "bootstrap.sql or bootstrap-meta.json is out of date. Run `pnpm --dir packages/db generate:bootstrap`.",
    );
    process.exit(1);
  }
  process.exit(0);
}

writeFileSync(BOOTSTRAP_PATH, generated.sql);
writeFileSync(BOOTSTRAP_META_PATH, `${JSON.stringify(generated.meta, null, 2)}\n`);
