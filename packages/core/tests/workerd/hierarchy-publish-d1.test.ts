import { env } from "cloudflare:workers";
import { Kysely } from "kysely";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { hierarchyPublicationCases } from "../utils/hierarchy-publication-cases.js";
import { resetD1Schema } from "./d1-schema.js";

hierarchyPublicationCases(
	async () => {
		const db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
		await resetD1Schema(db);
		await runMigrations(db);
		return db;
	},
	async (db) => {
		await db.destroy();
	},
);
