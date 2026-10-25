import { env } from "cloudflare:workers";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import type { Database } from "../../src/database/types.js";
import { contentBatchFence, executeFencedContentBatch } from "../../src/hierarchy/atomic.js";
import { resetD1Schema } from "./d1-schema.js";

declare global {
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
		}
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});
beforeEach(async () => {
	await resetD1Schema(db);
	await sql`CREATE TABLE ec_docs (
		id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, version INTEGER NOT NULL,
		live_revision_id TEXT, draft_revision_id TEXT
	)`.execute(db);
	await sql`CREATE TABLE hierarchy_redirect_test (source TEXT PRIMARY KEY, destination TEXT NOT NULL)`.execute(
		db,
	);
	await sql`INSERT INTO ec_docs VALUES
		('root', 'product', 1, 'old', NULL),
		('child', 'product/start', 1, 'child-live', 'body-draft'),
		('other', 'other', 1, 'other-live', NULL)`.execute(db);
});
afterAll(async () => {
	await db.destroy();
});

async function move(revision: string, expectedVersion = 1, childSlug = "renamed/start") {
	await executeFencedContentBatch(db, () => {
		const applied = contentBatchFence("ec_docs", "root", revision);
		return {
			anchor: sql<{ id: string }>`UPDATE ec_docs SET slug = 'renamed', version = version + 1,
				live_revision_id = ${revision}
				WHERE id = 'root' AND version = ${expectedVersion}
				AND EXISTS (SELECT 1 FROM ec_docs WHERE id = 'child' AND version = 1)
				RETURNING id`,
			statements: [
				sql`UPDATE ec_docs SET slug = ${childSlug}, version = version + 1 WHERE id = 'child' AND ${applied}`,
				sql`INSERT INTO hierarchy_redirect_test SELECT '/docs/product', '/docs/renamed' WHERE ${applied}`,
				sql`INSERT INTO hierarchy_redirect_test SELECT '/docs/product/start', '/docs/renamed/start' WHERE ${applied}`,
			],
		};
	});
}

async function state() {
	const content = await sql`SELECT * FROM ec_docs ORDER BY id`.execute(db);
	const redirects = await sql`SELECT * FROM hierarchy_redirect_test ORDER BY source`.execute(db);
	return { content: content.rows, redirects: redirects.rows };
}

describe("atomic hierarchical content changes on D1", () => {
	it("commits the subtree and redirects together, preserving an unrelated body draft", async () => {
		await move("move-one");
		expect((await state()).redirects).toHaveLength(2);
		expect((await state()).content).toContainEqual({
			id: "child",
			slug: "renamed/start",
			version: 2,
			live_revision_id: "child-live",
			draft_revision_id: "body-draft",
		});
	});
	it("rolls back the anchor and descendants when a later slug collides", async () => {
		const before = await state();
		await expect(move("collision", 1, "other")).rejects.toThrow();
		expect(await state()).toEqual(before);
	});
	it("leaves no partial changes when a redirect statement fails", async () => {
		await sql`CREATE TRIGGER fail_redirect BEFORE INSERT ON hierarchy_redirect_test
			WHEN NEW.source = '/docs/product/start' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`.execute(
			db,
		);
		const before = await state();
		await expect(move("failure")).rejects.toThrow();
		expect(await state()).toEqual(before);
	});
	it("rejects a stale subtree snapshot without writing anything", async () => {
		await sql`UPDATE ec_docs SET version = 2 WHERE id = 'child'`.execute(db);
		const before = await state();
		await expect(move("stale")).rejects.toThrow();
		expect(await state()).toEqual(before);
	});
	it("allows one concurrent move and rejects the losing revision", async () => {
		const outcomes = await Promise.allSettled([move("one"), move("two")]);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect((await state()).redirects).toHaveLength(2);
	});
});
