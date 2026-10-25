import { type Kysely, type RawBuilder, sql } from "kysely";

import { EmDashValidationError } from "../database/repositories/types.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";

/** Evaluate again in the write statement so a concurrent publish cannot orphan a child. */
export function hierarchyRemovalGuard(collection: string, id: string): RawBuilder<boolean> {
	validateIdentifier(collection, "collection slug");
	const table = `ec_${collection}`;
	return sql<boolean>`NOT EXISTS (
		WITH RECURSIVE descendants(content_group, relation_id) AS (
			SELECT edge.child_group, edge.relation_id
			FROM _emdash_content_references AS edge
			JOIN _emdash_relations AS relation ON relation.id = edge.relation_id
			JOIN _emdash_collections AS collection ON collection.hierarchy_relation = relation.slug
			WHERE collection.slug = ${collection}
			AND edge.parent_group = (SELECT translation_group FROM ${sql.ref(table)} WHERE id = ${id})
			UNION
			SELECT edge.child_group, edge.relation_id FROM _emdash_content_references AS edge
			JOIN descendants ON edge.parent_group = descendants.content_group AND edge.relation_id = descendants.relation_id
		)
		SELECT 1 FROM descendants JOIN ${sql.ref(table)} AS child ON child.translation_group = descendants.content_group
		WHERE child.deleted_at IS NULL AND child.status = 'published'
	)`;
}

export async function assertHierarchyRemovable(
	db: Kysely<Database>,
	collection: string,
	id: string,
): Promise<void> {
	const allowed = await sql<{
		allowed: boolean | number;
	}>`SELECT ${hierarchyRemovalGuard(collection, id)} AS allowed`.execute(db);
	if (!allowed.rows[0]?.allowed)
		throw new EmDashValidationError(
			"Move or unpublish the published descendants before removing their parent",
		);
}
