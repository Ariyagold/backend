import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresRowStore } from "../lib/idempotencyPgStore.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Postgres integration tests");

const client = postgres(databaseUrl, { max: 10 });
const rows = createPostgresRowStore(client);

describe("Postgres integration", () => {
  afterAll(async () => {
    await client.end();
  });

  it("rolls back writes when a transaction fails", async () => {
    const key = `integration-rollback-${randomUUID()}`;
    await expect(
      client.begin(async (transaction) => {
        await transaction`
          INSERT INTO idempotency_records (key, record, expires_at)
          VALUES (${key}, '{"inProgress":true}', now() + interval '1 minute')
        `;
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const found = await client`SELECT key FROM idempotency_records WHERE key = ${key}`;
    expect(found).toHaveLength(0);
  });

  it("enforces publisher email uniqueness under concurrent inserts", async () => {
    const email = `integration-${randomUUID()}@example.test`;
    const inserts = [0, 1].map((index) =>
      client`
        INSERT INTO publishers (id, name, email, wallet_address, api_key_hash)
        VALUES (
          ${`integration-publisher-${randomUUID()}`},
          ${`integration-${index}`},
          ${email},
          'GDEJJLXV2CNHF5HEGX34MU4G6L4PRVUAGD4ANF77ZDYTQJKSDSDYVVI6',
          ${randomUUID()}
        )
        RETURNING id
      `,
    );

    const results = await Promise.allSettled(inserts);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await client`DELETE FROM publishers WHERE email = ${email}`;
  });

  it("allows only one concurrent Postgres idempotency reservation", async () => {
    const key = `integration-reservation-${randomUUID()}`;
    const owners = [randomUUID(), randomUUID()];
    const results = await Promise.all(
      owners.map((owner) =>
        rows.insertIfAbsent(
          key,
          { inProgress: true, fingerprint: owner },
          new Date(Date.now() + 60_000),
        ),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await rows.select(key);
    expect(stored?.record).toEqual({
      inProgress: true,
      fingerprint: owners[results.findIndex(Boolean)],
    });
    await rows.remove(key);
  });
});
