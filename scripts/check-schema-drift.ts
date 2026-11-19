import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "../src/db/schema.js";

const tables = [
  schema.publishers,
  schema.resources,
  schema.pendingCleanup,
  schema.verifications,
  schema.payments,
  schema.failedEvents,
  schema.ledgerCheckpoints,
  schema.moderationEvents,
  schema.idempotencyRecords,
  schema.webhookOutbox,
];
const enums = [
  schema.resourceTypeEnum,
  schema.verificationStatusEnum,
  schema.onchainStatusEnum,
  schema.paymentStatusEnum,
  schema.thumbnailStatusEnum,
];
const dialect = new PgDialect();

type ExpectedConstraint = { table: string; name: string; type: string; definition: string };
type ExpectedIndex = {
  name: string;
  unique: boolean;
  method: string;
  columns: string[];
  predicate: string | null;
};

function canonicalSql(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/\bpublic\./g, "")
    .replace(/\b[a-z_][a-z0-9_]*\./g, "")
    .replace(/::[a-z]+(?:\s+[a-z]+)?/g, "")
    .replace(/\bno action\b/g, "")
    .replace(/\s+/g, "")
    .replace(/[()]/g, "");
}

function expectedConstraints(): ExpectedConstraint[] {
  const result: ExpectedConstraint[] = [];

  for (const table of tables) {
    const config = getTableConfig(table);
    const tableName = getTableName(table);
    const primary = config.columns.filter((column) => column.primary);
    if (primary.length) {
      result.push({
        table: tableName,
        name: `${tableName}_pkey`,
        type: "p",
        definition: `PRIMARY KEY (${primary.map((column) => column.name).join(", ")})`,
      });
    }

    for (const column of config.columns.filter((item) => item.isUnique)) {
      result.push({
        table: tableName,
        name: `${tableName}_${column.name}_unique`,
        type: "u",
        definition: `UNIQUE (${column.name})`,
      });
    }

    for (const constraint of config.uniqueConstraints) {
      result.push({
        table: tableName,
        name: constraint.name!,
        type: "u",
        definition: `UNIQUE (${constraint.columns.map((column) => column.name).join(", ")})`,
      });
    }

    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      result.push({
        table: tableName,
        name: foreignKey.getName(),
        type: "f",
        definition: `FOREIGN KEY (${reference.columns.map((column) => column.name).join(", ")}) REFERENCES ${getTableName(reference.foreignTable)} (${reference.foreignColumns.map((column) => column.name).join(", ")})`,
      });
    }

    for (const check of config.checks) {
      result.push({
        table: tableName,
        name: check.name,
        type: "c",
        definition: `CHECK (${dialect.sqlToQuery(check.value).sql})`,
      });
    }
  }

  return result;
}

function expectedIndexes(): ExpectedIndex[] {
  const result: ExpectedIndex[] = [];

  for (const table of tables) {
    const config = getTableConfig(table);
    const tableName = getTableName(table);
    const add = (index: ExpectedIndex) => result.push(index);

    for (const column of config.columns) {
      if (column.primary || column.isUnique) {
        add({
          name: column.primary
            ? `${tableName}_pkey`
            : `${tableName}_${column.name}_unique`,
          unique: true,
          method: "btree",
          columns: [column.name],
          predicate: null,
        });
      }
    }

    for (const index of config.indexes) {
      add({
        name: index.config.name!,
        unique: index.config.unique ?? false,
        method: index.config.method ?? "btree",
        columns: index.config.columns.map((column) => {
          if (!("name" in column) || typeof column.name !== "string") {
            throw new Error(`Expression indexes are not supported by schema comparison: ${index.config.name}`);
          }
          return column.name;
        }),
        predicate: null,
      });
    }
  }

  return result;
}

function difference<T>(
  kind: string,
  expected: Map<string, T>,
  actual: Map<string, T>,
  describe: (value: T) => string,
): string[] {
  const errors: string[] = [];
  for (const [name, value] of expected) {
    const found = actual.get(name);
    if (!found) errors.push(`Missing ${kind} ${name}`);
    else if (describe(value) !== describe(found)) {
      errors.push(`${kind} ${name} differs: expected ${describe(value)}, found ${describe(found)}`);
    }
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) errors.push(`Unexpected ${kind} ${name}`);
  }
  return errors;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const client = postgres(url);
  try {
    const errors: string[] = [];
    const tableNames = tables.map(getTableName);
    const expectedTableNames = new Set<string>(tableNames);
    const actualTables = await client<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name <> '__drizzle_migrations'
      ORDER BY table_name
    `;
    for (const row of actualTables) {
      if (!expectedTableNames.has(row.table_name)) {
        errors.push(`Unexpected table ${row.table_name}`);
      }
    }
    for (const name of expectedTableNames) {
      if (!actualTables.some((row) => row.table_name === name)) errors.push(`Missing table ${name}`);
    }

    const actualColumns = await client<{
      table_name: string;
      column_name: string;
      type: string;
      nullable: boolean;
    }[]>`
      SELECT t.relname AS table_name, a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS type,
             NOT a.attnotnull AS nullable
      FROM pg_attribute a
      JOIN pg_class t ON t.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relkind = 'r'
        AND t.relname = ANY(${tableNames})
        AND a.attnum > 0
        AND NOT a.attisdropped
    `;

    for (const table of tables) {
      const config = getTableConfig(table);
      const tableName = getTableName(table);
      const actual = new Map(
        actualColumns
          .filter((column) => column.table_name === tableName)
          .map((column) => [
            column.column_name,
            { type: column.type.toLowerCase(), nullable: column.nullable },
          ]),
      );
      const expected = new Map(
        config.columns.map((column) => [
          column.name,
          { type: column.getSQLType().toLowerCase(), nullable: !column.notNull },
        ]),
      );
      errors.push(
        ...difference(
          "column",
          expected,
          actual,
          (column) => `${column.type}${column.nullable ? " nullable" : " not null"}`,
        ).map((error) => `${tableName}: ${error}`),
      );
    }

    const actualConstraints = await client<{
      table: string;
      name: string;
      type: string;
      definition: string;
    }[]>`
      SELECT t.relname AS table, con.conname AS name, con.contype AS type,
             pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class t ON t.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname = ANY(${tableNames})
    `;
    for (const tableName of tableNames) {
      const expected = expectedConstraints().filter((item) => item.table === tableName);
      const actual = actualConstraints.filter((item) => item.table === tableName);
      const unmatchedActual = [...actual];
      for (const constraint of expected) {
        const signature = `${constraint.type}:${canonicalSql(constraint.definition)}`;
        const matchIndex = unmatchedActual.findIndex(
          (item) => `${item.type}:${canonicalSql(item.definition)}` === signature,
        );
        if (matchIndex === -1) {
          errors.push(
            `${tableName}: missing constraint ${constraint.name} (${constraint.definition})`,
          );
        } else {
          unmatchedActual.splice(matchIndex, 1);
        }
      }
      for (const constraint of unmatchedActual) {
        errors.push(
          `${tableName}: unexpected constraint ${constraint.name} (${constraint.definition})`,
        );
      }
    }

    const actualIndexes = await client<{
      name: string;
      unique: boolean;
      method: string;
      columns: string[];
      predicate: string | null;
    }[]>`
      SELECT i.relname AS name,
             ix.indisunique AS unique,
             am.amname AS method,
             array_agg(a.attname ORDER BY k.ordinality) AS columns,
             pg_get_expr(ix.indpred, ix.indrelid) AS predicate
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_am am ON am.oid = i.relam
      CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ordinality)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = 'public'
        AND t.relname = ANY(${tableNames})
        AND k.ordinality <= ix.indnkeyatts
      GROUP BY i.relname, ix.indisunique, am.amname, ix.indpred, ix.indrelid
    `;
    errors.push(
      ...difference(
        "index",
        new Map(expectedIndexes().map((item) => [item.name, item])),
        new Map(actualIndexes.map((item) => [item.name, item])),
        (item) =>
          `${item.unique ? "unique " : ""}${item.method}(${item.columns.join(",")}) where ${canonicalSql(item.predicate ?? "")}`,
      ),
    );

    const actualEnums = await client<{ name: string; value: string; sort_order: number }[]>`
      SELECT t.typname AS name, e.enumlabel AS value, e.enumsortorder AS sort_order
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder
    `;
    const expectedEnumMap = new Map(
      enums.map((item) => [item.enumName, item.enumValues.join(",")]),
    );
    const actualEnumValues = new Map<string, string[]>();
    for (const row of actualEnums) {
      const values = actualEnumValues.get(row.name) ?? [];
      values.push(row.value);
      actualEnumValues.set(row.name, values);
    }
    const actualEnumMap = new Map(
      [...actualEnumValues].map(([name, values]) => [name, values.join(",")]),
    );
    errors.push(
      ...difference("enum", expectedEnumMap, actualEnumMap, (values) => values),
    );

    if (errors.length) {
      console.error(`Schema drift detected (${errors.length} differences):\n- ${errors.join("\n- ")}`);
      process.exitCode = 1;
    } else {
      console.log(`Database schema matches ${tables.length} declared tables and ${enums.length} enums.`);
    }
  } finally {
    await client.end();
  }
}

await main();
