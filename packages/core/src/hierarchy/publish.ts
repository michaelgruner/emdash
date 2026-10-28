import { Permissions } from "@emdash-cms/auth";
import { type Kysely, type RawBuilder, sql } from "kysely";
import { ulid } from "ulidx";

import { applyReferenceDiff } from "../api/handlers/staged-references.js";
import { referenceFieldConstraints } from "../api/handlers/validate-references.js";
import { ContentDatetimeNormalizer } from "../database/content-datetime.js";
import { isPostgres } from "../database/dialect-helpers.js";
import {
	ContentRepository,
	type ContentRevisionPrecondition,
} from "../database/repositories/content.js";
import { createRevisionId, RevisionRepository } from "../database/repositories/revision.js";
import {
	ContentMutationConflictError,
	EmDashValidationError,
	ScheduledNotDueError,
	type ContentItem,
} from "../database/repositories/types.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import { getI18nConfig } from "../i18n/config.js";
import { interpolateUrlPattern } from "../i18n/resolve.js";
import { invalidateCollectionCache } from "../object-cache/index.js";
import {
	readStagedReferences,
	readStagedReferenceBaselines,
	type StagedReferences,
} from "../references/staged.js";
import { contentBatchFence, executeFencedContentBatch } from "./atomic.js";
import { resolveHierarchyPaths, type HierarchyEdge } from "./paths.js";

interface HierarchyRow {
	id: string;
	translation_group: string;
	slug: string | null;
	status: string;
	locale: string;
	version: number;
	deleted_at: string | null;
	draft_revision_id: string | null;
	live_revision_id: string | null;
	author_id: string | null;
}
interface EdgeRow {
	parent_group: string;
	child_group: string;
	sort_order: number;
}

function tableOf(collection: string): string {
	validateIdentifier(collection, "collection slug");
	return `ec_${collection}`;
}

function graphSnapshot(db: Kysely<Database>, collection: string, relationId: string) {
	const table = tableOf(collection);
	if (isPostgres(db)) {
		return sql<string>`(SELECT jsonb_build_array(
			(SELECT COALESCE(jsonb_agg(jsonb_build_array(id, version, slug, status, deleted_at, updated_at, live_revision_id, draft_revision_id, scheduled_at, locale, translation_group, author_id) ORDER BY id), '[]'::jsonb) FROM ${sql.ref(table)}),
			(SELECT COALESCE(jsonb_agg(jsonb_build_array(relation_id, parent_group, child_group, sort_order) ORDER BY relation_id, parent_group, child_group), '[]'::jsonb)
			 FROM _emdash_content_references WHERE relation_id IN (SELECT id FROM _emdash_relations WHERE parent_collection = ${collection} OR child_collection = ${collection})),
			(SELECT jsonb_build_array(c.hierarchy_relation, c.url_pattern, c.updated_at, r.updated_at, r.max_parents_per_child, r.parent_collection, r.child_collection, (SELECT revision FROM _emdash_redirect_state WHERE id = 1))
			 FROM _emdash_collections c JOIN _emdash_relations r ON r.id = ${relationId} WHERE c.slug = ${collection})
		)::text)`;
	}
	return sql<string>`(SELECT json_array(
		json((SELECT json_group_array(json_array(id, version, slug, status, deleted_at, updated_at, live_revision_id, draft_revision_id, scheduled_at, locale, translation_group, author_id)) FROM (SELECT id, version, slug, status, deleted_at, updated_at, live_revision_id, draft_revision_id, scheduled_at, locale, translation_group, author_id FROM ${sql.ref(table)} ORDER BY id))),
		json((SELECT json_group_array(json_array(relation_id, parent_group, child_group, sort_order)) FROM
			(SELECT relation_id, parent_group, child_group, sort_order FROM _emdash_content_references WHERE relation_id IN (SELECT id FROM _emdash_relations WHERE parent_collection = ${collection} OR child_collection = ${collection}) ORDER BY relation_id, parent_group, child_group))),
		json((SELECT json_array(c.hierarchy_relation, c.url_pattern, c.updated_at, r.updated_at, r.max_parents_per_child, r.parent_collection, r.child_collection, (SELECT revision FROM _emdash_redirect_state WHERE id = 1))
			 FROM _emdash_collections c JOIN _emdash_relations r ON r.id = ${relationId} WHERE c.slug = ${collection}))
	))`;
}

export async function loadHierarchyState(
	db: Kysely<Database>,
	collection: string,
	relationSlug: string,
) {
	if ((getI18nConfig()?.locales.length ?? 1) > 1) {
		throw new EmDashValidationError(
			"Hierarchical collections currently support one content locale",
		);
	}
	const relation = await db
		.selectFrom("_emdash_relations")
		.selectAll()
		.where("slug", "=", relationSlug)
		.executeTakeFirst();
	if (
		!relation ||
		relation.parent_collection !== collection ||
		relation.child_collection !== collection ||
		relation.max_parents_per_child !== 1
	) {
		throw new EmDashValidationError(
			"Hierarchy requires a self-relation with at most one parent per child",
		);
	}
	const table = tableOf(collection);
	const snapshot = await sql<{
		snapshot: string;
	}>`SELECT ${graphSnapshot(db, collection, relation.id)} AS snapshot`.execute(db);
	const fingerprint = snapshot.rows[0]?.snapshot;
	if (!fingerprint) throw new Error("Unable to read hierarchy snapshot");
	const rows = (
		await sql<HierarchyRow>`SELECT id, translation_group, slug, status, locale, version, deleted_at, draft_revision_id, live_revision_id, author_id FROM ${sql.ref(table)} ORDER BY id`.execute(
			db,
		)
	).rows;
	const edges = await db
		.selectFrom("_emdash_content_references")
		.select(["parent_group", "child_group", "sort_order"])
		.where("relation_id", "=", relation.id)
		.execute();
	if (new Set(rows.map((row) => row.locale)).size > 1)
		throw new EmDashValidationError(
			"Hierarchical collections currently support one content locale",
		);
	return { relation, rows, edges, fingerprint };
}

export async function pendingHierarchyEdges(
	db: Kysely<Database>,
	collection: string,
	relationSlug: string,
	entryGroup: string,
	live: readonly EdgeRow[],
	staged: StagedReferences | undefined,
	baselines: StagedReferences | undefined,
): Promise<HierarchyEdge[]> {
	let edges = live.map((edge) => ({
		parent: edge.parent_group,
		child: edge.child_group,
		order: edge.sort_order,
	}));
	for (const field of (await referenceFieldConstraints(db, collection)).values()) {
		if (field.relation !== relationSlug || !staged || !Object.hasOwn(staged, field.slug)) continue;
		const side = field.relationSide;
		const selected = edges
			.filter((edge) => (side === "child" ? edge.child === entryGroup : edge.parent === entryGroup))
			.toSorted((a, b) => a.order - b.order)
			.map((edge) => (side === "child" ? edge.parent : edge.child));
		const baseline = baselines?.[field.slug];
		const requested = staged[field.slug] ?? [];
		const groups = baseline ? applyReferenceDiff(baseline, requested, selected) : requested;
		const previous = edges;
		edges = edges.filter((edge) =>
			side === "child" ? edge.child !== entryGroup : edge.parent !== entryGroup,
		);
		for (const [order, group] of groups.entries()) {
			if (side === "parent") {
				edges.push({ parent: entryGroup, child: group, order });
				continue;
			}
			const existing = previous.find((edge) => edge.parent === group && edge.child === entryGroup);
			const siblingOrders = previous
				.filter((edge) => edge.parent === group)
				.map((edge) => edge.order);
			const position =
				existing?.order ?? siblingOrders.reduce((max, value) => Math.max(max, value + 1), 0);
			edges.push({ parent: group, child: entryGroup, order: position });
		}
	}
	return edges;
}

export async function publishHierarchicalContent(
	db: Kysely<Database>,
	collection: string,
	root: ContentItem,
	config: {
		hierarchyRelation: string;
		urlPattern: string | null;
		previousUrlPattern?: string | null;
	},
	options: {
		publishedAt?: string;
		expectedRevision?: ContentRevisionPrecondition;
		requireScheduledDue?: boolean;
		expectedScheduledAt?: string;
		currentTime?: Date;
		actor?: { id: string; role: number };
		activate?: boolean;
	} = {},
): Promise<ContentItem> {
	const now = (options.currentTime ?? new Date()).toISOString();
	if (
		options.expectedRevision &&
		(root.version !== options.expectedRevision.version ||
			root.updatedAt !== options.expectedRevision.updatedAt)
	)
		throw new ContentMutationConflictError();
	if (
		options.requireScheduledDue &&
		(!root.scheduledAt ||
			root.scheduledAt > now ||
			(options.expectedScheduledAt !== undefined &&
				root.scheduledAt !== options.expectedScheduledAt))
	)
		throw new ScheduledNotDueError();
	if (!config.urlPattern?.endsWith("/{path}"))
		throw new EmDashValidationError("A hierarchical URL pattern must end with /{path}");
	const state = await loadHierarchyState(db, collection, config.hierarchyRelation);
	const rootRow = state.rows.find((row) => row.id === root.id && !row.deleted_at);
	if (!rootRow || rootRow.version !== root.version) throw new ContentMutationConflictError();
	if (!root.translationGroup) throw new EmDashValidationError("The entry has no translation group");
	const revisions = new RevisionRepository(db);
	const pending = root.draftRevisionId ? await revisions.findById(root.draftRevisionId) : null;
	if (pending && (pending.collection !== collection || pending.entryId !== root.id))
		throw new EmDashValidationError("Draft revision does not belong to this entry");
	const data =
		options.activate && root.status === "published" ? root.data : (pending?.data ?? root.data);
	const staged = readStagedReferences(data);
	const edges = await pendingHierarchyEdges(
		db,
		collection,
		config.hierarchyRelation,
		root.translationGroup,
		state.edges,
		staged,
		readStagedReferenceBaselines(data),
	);
	const activeRows = state.rows.filter((row) => !row.deleted_at);
	const nodes = activeRows
		.filter((row) => row.slug || row.id === root.id)
		.map((row) => ({
			id: row.id,
			group: row.translation_group,
			slug: row.slug ?? "",
			published: (!options.activate && row.id === root.id) || row.status === "published",
		}));
	const segments = new Map<string, string>();
	if (!options.activate && typeof data._slug === "string")
		segments.set(root.id, data._slug.split("/").at(-1) ?? "");
	const nodeGroups = new Set(nodes.map((node) => node.group));
	const relevantEdges = edges.filter(
		(edge) => nodeGroups.has(edge.parent) || nodeGroups.has(edge.child),
	);
	const paths = resolveHierarchyPaths(nodes, relevantEdges, segments);
	const changed = activeRows.filter(
		(row) => paths.get(row.id) !== undefined && paths.get(row.id) !== row.slug,
	);
	if (
		options.actor &&
		options.actor.role < Permissions["content:publish_any"] &&
		changed.some((row) => row.id !== root.id && row.author_id !== options.actor!.id)
	) {
		throw new EmDashValidationError(
			"Moving this subtree requires permission to publish its other authors' entries",
		);
	}
	const fields = await new ContentDatetimeNormalizer(db).writableFieldSlugs(collection);
	const publishedData = Object.fromEntries(
		Object.entries(data).filter(([key]) => fields.has(key) && !key.startsWith("_")),
	);
	const newRevision = createRevisionId();
	const table = tableOf(collection);
	const pointer =
		options.activate && root.status !== "published" ? "draft_revision_id" : "live_revision_id";
	const applied = contentBatchFence(table, root.id, newRevision, pointer);
	const rootPath = paths.get(root.id);
	if (!rootPath) throw new EmDashValidationError("Cannot publish without a canonical path");
	const baseline = graphSnapshot(db, collection, state.relation.id);
	const rootAssignments: RawBuilder<unknown>[] = options.activate
		? [
				sql`slug = ${rootPath}`,
				sql`${sql.ref(pointer)} = ${newRevision}`,
				sql`updated_at = ${now}`,
				sql`version = version + 1`,
			]
		: [
				sql`slug = ${rootPath}`,
				sql`live_revision_id = ${newRevision}`,
				sql`draft_revision_id = NULL`,
				sql`status = 'published'`,
				sql`scheduled_at = NULL`,
				sql`published_at = ${options.publishedAt ?? root.publishedAt ?? now}`,
				sql`updated_at = ${now}`,
				sql`version = version + 1`,
			];
	for (const [key, value] of Object.entries(publishedData)) {
		validateIdentifier(key, "content field name");
		const stored =
			value !== null && typeof value === "object"
				? JSON.stringify(value)
				: typeof value === "boolean"
					? Number(value)
					: value;
		rootAssignments.push(sql`${sql.ref(key)} = ${stored}`);
	}
	const statements: RawBuilder<unknown>[] = [];
	const snapshot: Record<string, unknown> = { ...data, _slug: rootPath };
	const publishedSelections: StagedReferences = {};
	for (const field of (await referenceFieldConstraints(db, collection)).values()) {
		if (field.relation === config.hierarchyRelation) {
			publishedSelections[field.slug] = edges
				.filter((edge) =>
					field.relationSide === "child"
						? edge.child === root.translationGroup
						: edge.parent === root.translationGroup,
				)
				.toSorted((a, b) => a.order - b.order)
				.map((edge) => (field.relationSide === "child" ? edge.parent : edge.child));
			continue;
		}
		if (!field.relationId)
			throw new EmDashValidationError(`Reference relation '${field.relation}' is missing`);
		const column = field.relationSide === "child" ? "child_group" : "parent_group";
		const opposite = field.relationSide === "child" ? "parent_group" : "child_group";
		const live = await db
			.selectFrom("_emdash_content_references")
			.select(["parent_group", "child_group"])
			.where("relation_id", "=", field.relationId)
			.where(column, "=", root.translationGroup)
			.orderBy("sort_order")
			.execute();
		const liveGroups = live.map((edge) => edge[opposite]);
		const baselineGroups = readStagedReferenceBaselines(data)?.[field.slug];
		const requested = staged?.[field.slug];
		const groups = requested
			? baselineGroups
				? applyReferenceDiff(baselineGroups, requested, liveGroups)
				: requested
			: liveGroups;
		publishedSelections[field.slug] = groups;
		if (!requested || options.activate) continue;
		for (const group of liveGroups.filter((group) => !groups.includes(group))) {
			statements.push(sql`DELETE FROM _emdash_content_references WHERE relation_id = ${field.relationId}
				AND ${sql.ref(column)} = ${root.translationGroup} AND ${sql.ref(opposite)} = ${group} AND ${applied}`);
		}
		for (const [order, group] of groups.entries()) {
			const parent = field.relationSide === "child" ? group : root.translationGroup;
			const child = field.relationSide === "child" ? root.translationGroup : group;
			if (liveGroups.includes(group)) {
				if (field.relationSide === "parent")
					statements.push(sql`UPDATE _emdash_content_references SET sort_order = ${order}
					WHERE relation_id = ${field.relationId} AND parent_group = ${parent} AND child_group = ${child} AND ${applied}`);
				continue;
			}
			const position =
				field.relationSide === "child"
					? sql`(SELECT COALESCE(MAX(sort_order) + 1, 0) FROM _emdash_content_references WHERE relation_id = ${field.relationId} AND parent_group = ${parent})`
					: sql`${order}`;
			statements.push(sql`INSERT INTO _emdash_content_references (id, relation_id, parent_group, child_group, sort_order, created_at)
				SELECT ${ulid()}, ${field.relationId}, ${parent}, ${child}, ${position}, ${now} WHERE ${applied}`);
		}
	}
	snapshot._references = publishedSelections;
	delete snapshot._referencesBaseline;
	const prepare = [
		sql`INSERT INTO revisions (id, collection, entry_id, data, author_id)
		SELECT ${newRevision}, ${collection}, ${root.id}, ${JSON.stringify(snapshot)}, ${root.authorId}
		WHERE ${baseline} = ${state.fingerprint}`,
	];
	for (const row of changed) {
		if (row.id === root.id && !options.activate) continue;
		const path = paths.get(row.id)!;
		const pendingRevision = row.draft_revision_id
			? await revisions.findById(row.draft_revision_id)
			: null;
		if (
			pendingRevision &&
			typeof pendingRevision.data._slug === "string" &&
			pendingRevision.data._slug !== row.slug
		) {
			throw new EmDashValidationError(
				`Resolve the unpublished URL change on '${row.slug}' before moving its ancestor`,
			);
		}
		if (pendingRevision && readStagedReferences(pendingRevision.data)) {
			const draftEdges = await pendingHierarchyEdges(
				db,
				collection,
				config.hierarchyRelation,
				row.translation_group,
				state.edges,
				readStagedReferences(pendingRevision.data),
				readStagedReferenceBaselines(pendingRevision.data),
			);
			if (
				JSON.stringify(
					draftEdges.toSorted(
						(a, b) => a.parent.localeCompare(b.parent) || a.child.localeCompare(b.child),
					),
				) !==
				JSON.stringify(
					state.edges
						.map((edge) => ({
							parent: edge.parent_group,
							child: edge.child_group,
							order: edge.sort_order,
						}))
						.toSorted((a, b) => a.parent.localeCompare(b.parent) || a.child.localeCompare(b.child)),
				)
			) {
				throw new EmDashValidationError(
					`Resolve the unpublished hierarchy change on '${row.slug}' before moving its ancestor`,
				);
			}
		}
		if (row.id !== root.id)
			statements.push(
				sql`UPDATE ${sql.ref(table)} SET slug = ${path}, version = version + 1, updated_at = ${now} WHERE id = ${row.id} AND ${applied}`,
			);
		if (
			pendingRevision &&
			Object.hasOwn(pendingRevision.data, "_slug") &&
			!(row.id === root.id && pointer === "draft_revision_id")
		) {
			const replacement = createRevisionId();
			statements.push(sql`INSERT INTO revisions (id, collection, entry_id, data, author_id)
				SELECT ${replacement}, ${collection}, ${row.id}, ${JSON.stringify({ ...pendingRevision.data, _slug: path })}, ${pendingRevision.authorId} WHERE ${applied}`);
			statements.push(
				sql`UPDATE ${sql.ref(table)} SET draft_revision_id = ${replacement} WHERE id = ${row.id} AND ${applied}`,
			);
		}
	}
	const remaining = new Map(edges.map((edge) => [JSON.stringify([edge.parent, edge.child]), edge]));
	for (const previous of state.edges) {
		const key = JSON.stringify([previous.parent_group, previous.child_group]);
		const next = remaining.get(key);
		if (!next) {
			statements.push(sql`DELETE FROM _emdash_content_references
				WHERE relation_id = ${state.relation.id} AND parent_group = ${previous.parent_group}
				AND child_group = ${previous.child_group} AND ${applied}`);
		} else if (next.order !== previous.sort_order) {
			statements.push(sql`UPDATE _emdash_content_references SET sort_order = ${next.order}
				WHERE relation_id = ${state.relation.id} AND parent_group = ${next.parent}
				AND child_group = ${next.child} AND ${applied}`);
		}
		remaining.delete(key);
	}
	for (const edge of remaining.values()) {
		statements.push(sql`INSERT INTO _emdash_content_references (id, relation_id, parent_group, child_group, sort_order, created_at)
			SELECT ${ulid()}, ${state.relation.id}, ${edge.parent}, ${edge.child}, ${edge.order}, ${now} WHERE ${applied}`);
	}
	// Native redirect constraints reject collisions and loops inside the same batch.
	for (const row of changed.filter((entry) => entry.status === "published" && entry.slug)) {
		const oldUrl = interpolateUrlPattern({
			pattern:
				config.previousUrlPattern !== undefined ? config.previousUrlPattern : config.urlPattern,
			collection,
			slug: row.slug!,
			id: row.id,
		});
		const newUrl = interpolateUrlPattern({
			pattern: config.urlPattern,
			collection,
			slug: paths.get(row.id)!,
			id: row.id,
		});
		const manual = await db
			.selectFrom("_emdash_redirects")
			.select("source")
			.where("auto", "=", 0)
			.where("is_pattern", "=", 0)
			.where("source", "in", [oldUrl, newUrl])
			.executeTakeFirst();
		if (manual)
			throw new EmDashValidationError(
				`Resolve the manually managed redirect at '${manual.source}' before moving this page`,
			);
		statements.push(
			sql`DELETE FROM _emdash_redirects WHERE source = ${newUrl} AND auto = 1 AND ${applied}`,
		);
		statements.push(
			sql`UPDATE _emdash_redirects SET destination = ${newUrl}, updated_at = ${now} WHERE destination = ${oldUrl} AND auto = 1 AND ${applied}`,
		);
		statements.push(sql`INSERT INTO _emdash_redirects (id, source, destination, type, is_pattern, enabled, hits, auto, group_name, config_revision, source_guard, write_generation, created_at, updated_at)
			SELECT ${ulid()}, ${oldUrl}, ${newUrl}, 301, 0, 1, 0, 1, 'Auto: slug change', ${ulid()}, 1, 0, ${now}, ${now}
			WHERE ${applied} AND NOT EXISTS (SELECT 1 FROM _emdash_redirects WHERE source = ${oldUrl})`);
		statements.push(
			sql`UPDATE _emdash_redirects SET destination = ${newUrl}, updated_at = ${now} WHERE source = ${oldUrl} AND auto = 1 AND ${applied}`,
		);
	}
	if (options.activate) {
		statements.push(
			sql`UPDATE _emdash_collections SET hierarchy_relation = ${config.hierarchyRelation}, url_pattern = ${config.urlPattern}, updated_at = ${now} WHERE slug = ${collection} AND ${applied}`,
		);
	}
	await executeFencedContentBatch(db, () => ({
		prepare,
		anchor: sql<{ id: string }>`UPDATE ${sql.ref(table)} SET ${sql.join(rootAssignments, sql`, `)}
			WHERE id = ${root.id} AND locale = ${root.locale} AND deleted_at IS NULL
			AND version = ${root.version} AND ${baseline} = ${state.fingerprint} RETURNING id`,
		statements,
	}));
	invalidateCollectionCache(collection);
	const updated = await new ContentRepository(db).findById(collection, root.id);
	if (!updated) throw new Error("Published entry not found");
	return updated;
}

/** Resolve only the edited entry for a draft; no published columns are changed. */
export async function resolveDraftHierarchySlug(
	db: Kysely<Database>,
	collection: string,
	relationSlug: string,
	entry: ContentItem | null,
	segment: string,
	selections: Record<string, string[]> | undefined,
	locale?: string,
): Promise<string> {
	const state = await loadHierarchyState(db, collection, relationSlug);
	if (locale && state.rows.some((row) => row.locale !== locale))
		throw new EmDashValidationError(
			"Hierarchical collections currently support one content locale",
		);
	const id = entry?.id ?? "new-entry";
	const group = entry?.translationGroup ?? "new-group";
	let staged: StagedReferences = {};
	let baselines: StagedReferences | undefined;
	if (entry?.draftRevisionId) {
		const draft = await new RevisionRepository(db).findById(entry.draftRevisionId);
		staged = readStagedReferences(draft?.data) ?? {};
		baselines = readStagedReferenceBaselines(draft?.data);
	}
	const constraints = await referenceFieldConstraints(db, collection);
	for (const [field, ids] of Object.entries(selections ?? {})) {
		if (constraints.get(field)?.relation !== relationSlug) continue;
		const groups: string[] = [];
		for (const selectedId of ids) {
			const row = state.rows.find(
				(candidate) => candidate.id === selectedId || candidate.translation_group === selectedId,
			);
			if (!row || row.deleted_at)
				throw new EmDashValidationError("A selected parent or child does not exist");
			groups.push(row.translation_group);
		}
		staged[field] = groups;
		// Incoming values replace the current selection, rather than replaying an older draft's baseline.
		if (baselines) delete baselines[field];
	}
	const edges = await pendingHierarchyEdges(
		db,
		collection,
		relationSlug,
		group,
		state.edges,
		staged,
		baselines,
	);
	const nodes = state.rows
		.filter((row) => !row.deleted_at && row.slug && row.id !== id)
		.map((row) => ({
			id: row.id,
			group: row.translation_group,
			slug: row.slug!,
			published: false,
		}));
	nodes.push({ id, group, slug: segment, published: false });
	const groups = new Set(nodes.map((node) => node.group));
	return resolveHierarchyPaths(
		nodes,
		edges.filter((edge) => groups.has(edge.parent) && groups.has(edge.child)),
		new Map([[id, segment]]),
	).get(id)!;
}
