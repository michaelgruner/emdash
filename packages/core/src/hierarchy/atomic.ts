import { type Kysely, type RawBuilder, sql } from "kysely";

import { executeAtomicBatchIfSupported } from "../database/dialect-helpers.js";
import { ContentMutationConflictError } from "../database/repositories/types.js";
import type { Database } from "../database/types.js";

export interface FencedContentBatch {
	/** First statement must RETURNING id and acquire the complete mutation fence. */
	anchor: RawBuilder<{ id: string }>;
	/** Conditional revision inserts required by immediate foreign keys. */
	prepare?: readonly RawBuilder<unknown>[];
	/** Every remaining write must be conditional on this invocation's unique anchor. */
	statements: readonly RawBuilder<unknown>[];
}

/** Never falls back to sequential, unprotected writes on D1. */
export async function executeFencedContentBatch(
	db: Kysely<Database>,
	build: (db: Kysely<Database>) => FencedContentBatch,
): Promise<void> {
	const batch = build(db);
	const preparation = batch.prepare ?? [];
	const results = await executeAtomicBatchIfSupported(db, [
		...preparation,
		batch.anchor,
		...batch.statements,
	]);
	if (results !== null) {
		if (results[preparation.length]?.rows.length !== 1) throw new ContentMutationConflictError();
		return;
	}
	const execute = async (trx: Kysely<Database>) => {
		const transactionBatch = build(trx);
		for (const statement of transactionBatch.prepare ?? []) await statement.execute(trx);
		const result = await transactionBatch.anchor.execute(trx);
		if (result.rows.length !== 1) throw new ContentMutationConflictError();
		for (const statement of transactionBatch.statements) await statement.execute(trx);
	};
	if (db.isTransaction) throw new Error("Hierarchical mutations must own their transaction");
	await db.transaction().setIsolationLevel("serializable").execute(execute);
}

/** A fresh revision ID also identifies this exact publish inside the atomic batch. */
export function contentBatchFence(
	table: string,
	id: string,
	revisionId: string,
	column: "live_revision_id" | "draft_revision_id" = "live_revision_id",
): RawBuilder<boolean> {
	return sql<boolean>`EXISTS (
		SELECT 1 FROM ${sql.ref(table)} WHERE id = ${id} AND ${sql.ref(column)} = ${revisionId}
	)`;
}
