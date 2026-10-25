import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "_emdash_collections", "hierarchy_relation")) return;
	await db.schema
		.alterTable("_emdash_collections")
		.addColumn("hierarchy_relation", "text")
		.execute();
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
