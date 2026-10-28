import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleContentPublish } from "../../src/api/handlers/content.js";
import { handleContentUnpublish, handleContentDelete } from "../../src/api/handlers/content.js";
import { handleSchemaCollectionUpdate } from "../../src/api/handlers/schema.js";
import { encodeRev } from "../../src/api/rev.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { RelationRepository } from "../../src/database/repositories/relation.js";
import type { ContentItem } from "../../src/database/repositories/types.js";
import type { Database } from "../../src/database/types.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import { interpolateUrlPattern } from "../../src/i18n/resolve.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { compileUrlPattern } from "../../src/schema/url-pattern.js";
import { createTestRuntime } from "./mcp-runtime.js";

export function hierarchyPublicationCases(
	setup: () => Promise<Kysely<Database>>,
	teardown: (db: Kysely<Database>) => Promise<void>,
) {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let relations: RelationRepository;
	let parent: ContentItem;
	let child: ContentItem;

	beforeEach(async () => {
		db = await setup();
		setI18nConfig(null);
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "docs",
			label: "Docs",
			supports: ["revisions"],
			urlPattern: "/docs/{path}",
			hierarchyRelation: "tree",
		});
		await registry.createField("docs", { slug: "title", label: "Title", type: "string" });
		relations = new RelationRepository(db);
		await relations.create({
			slug: "tree",
			parentCollection: "docs",
			childCollection: "docs",
			parentLabel: "Parent",
			childLabel: "Children",
			maxParentsPerChild: 1,
		});
		await registry.createField("docs", {
			slug: "children",
			label: "Children",
			type: "reference",
			validation: { relation: "tree", relationSide: "parent", targetCollection: "docs" },
		});
		await registry.createField("docs", {
			slug: "parent",
			label: "Parent",
			type: "reference",
			validation: { relation: "tree", relationSide: "child", targetCollection: "docs" },
		});
		repo = new ContentRepository(db);
		parent = await repo.create({
			type: "docs",
			slug: "product",
			status: "published",
			data: { title: "Product" },
		});
		child = await repo.create({
			type: "docs",
			slug: "product/getting-started",
			status: "published",
			data: { title: "Getting started" },
		});
		await relations.setChildren("tree", parent.translationGroup!, [child.translationGroup!]);
	});
	afterEach(async () => {
		await teardown(db);
	});

	describe("hierarchical publication", () => {
		it("preserves sibling order for inverse references to another relation", async () => {
			await relations.create({
				slug: "related",
				parentCollection: "docs",
				childCollection: "docs",
				parentLabel: "Parent",
				childLabel: "Children",
			});
			const registry = new SchemaRegistry(db);
			await registry.createField("docs", {
				slug: "related_parent",
				label: "Related parent",
				type: "reference",
				validation: { relation: "related", relationSide: "child", targetCollection: "docs" },
			});
			const sibling = await repo.create({
				type: "docs",
				slug: "sibling",
				status: "published",
				data: { title: "Sibling" },
			});
			await relations.setChildren("related", parent.translationGroup!, [
				sibling.translationGroup!,
				child.translationGroup!,
			]);
			const runtime = createTestRuntime(db);
			expect(
				await runtime.handleContentUpdate("docs", child.id, {
					data: {},
					references: { related_parent: [parent.id] },
				}),
			).toMatchObject({ success: true });
			expect(await runtime.handleContentPublish("docs", child.id)).toMatchObject({ success: true });
			expect(
				(await relations.getChildren("related", parent.translationGroup!)).map(
					(edge) => edge.childGroup,
				),
			).toEqual([sibling.translationGroup, child.translationGroup]);
			const newcomer = await repo.create({
				type: "docs",
				slug: "newcomer",
				status: "published",
				data: { title: "Newcomer" },
			});
			expect(
				await runtime.handleContentUpdate("docs", newcomer.id, {
					data: {},
					references: { related_parent: [parent.id] },
				}),
			).toMatchObject({ success: true });
			expect(await runtime.handleContentPublish("docs", newcomer.id)).toMatchObject({
				success: true,
			});
			expect(
				(await relations.getChildren("related", parent.translationGroup!)).map(
					(edge) => edge.childGroup,
				),
			).toEqual([sibling.translationGroup, child.translationGroup, newcomer.translationGroup]);
		});
		it("renames the subtree and leaves redirects from both previous URLs", async () => {
			await repo.updateDraftAware("docs", parent.id, {
				slug: "renamed",
				data: { title: "Renamed" },
			});
			const published = await handleContentPublish(db, "docs", parent.id);
			expect(published).toMatchObject({
				success: true,
				data: { item: { slug: "renamed", data: { title: "Renamed" } } },
			});
			expect((await repo.findById("docs", child.id))?.slug).toBe("renamed/getting-started");
			const redirects = await db
				.selectFrom("_emdash_redirects")
				.select(["source", "destination"])
				.orderBy("source")
				.execute();
			expect(redirects).toEqual([
				{ source: "/docs/product", destination: "/docs/renamed" },
				{ source: "/docs/product/getting-started", destination: "/docs/renamed/getting-started" },
			]);
		});
		it("rejects a conflicting unpublished child slug without changing the parent", async () => {
			await repo.updateDraftAware("docs", child.id, { slug: "product/intro" });
			await repo.updateDraftAware("docs", parent.id, { slug: "renamed" });
			const published = await handleContentPublish(db, "docs", parent.id);
			expect(published).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
			expect((await repo.findById("docs", parent.id))?.slug).toBe("product");
		});
		it("preserves the child's unpublished text during the move", async () => {
			await repo.updateDraftAware("docs", child.id, { data: { title: "Unpublished edit" } });
			await repo.updateDraftAware("docs", parent.id, { slug: "renamed" });
			expect(await handleContentPublish(db, "docs", parent.id)).toMatchObject({ success: true });
			const moved = await repo.findById("docs", child.id);
			expect(moved?.data.title).toBe("Getting started");
			expect(moved?.draftRevisionId).toBeTruthy();
			expect(await handleContentPublish(db, "docs", child.id)).toMatchObject({
				success: true,
				data: { item: { slug: "renamed/getting-started", data: { title: "Unpublished edit" } } },
			});
		});
		it("moves a child through the native draft reference field, then flattens redirects after another move", async () => {
			const other = await repo.create({
				type: "docs",
				slug: "other",
				status: "published",
				data: { title: "Other" },
			});
			const runtime = createTestRuntime(db);
			expect(
				await runtime.handleContentUpdate("docs", child.id, {
					data: {},
					references: { parent: [other.id] },
				}),
			).toMatchObject({ success: true });
			expect((await repo.findById("docs", child.id))?.slug).toBe("product/getting-started");
			expect(await runtime.handleContentPublish("docs", child.id)).toMatchObject({ success: true });
			expect((await repo.findById("docs", child.id))?.slug).toBe("other/getting-started");
			expect(
				await runtime.handleContentUpdate("docs", other.id, { data: {}, slugSegment: "renamed" }),
			).toMatchObject({ success: true });
			expect(await runtime.handleContentPublish("docs", other.id)).toMatchObject({ success: true });
			const redirects = await db
				.selectFrom("_emdash_redirects")
				.select(["source", "destination"])
				.where("source", "=", "/docs/product/getting-started")
				.execute();
			expect(redirects).toEqual([
				{ source: "/docs/product/getting-started", destination: "/docs/renamed/getting-started" },
			]);
		});
		it("preserves sibling order when a child republishes its unchanged parent selection", async () => {
			const sibling = await repo.create({
				type: "docs",
				slug: "product/first",
				status: "published",
				data: { title: "First" },
			});
			await relations.setChildren("tree", parent.translationGroup!, [
				sibling.translationGroup!,
				child.translationGroup!,
			]);
			const runtime = createTestRuntime(db);
			expect(
				await runtime.handleContentUpdate("docs", child.id, {
					data: { title: "Edited" },
					references: { parent: [parent.id] },
				}),
			).toMatchObject({ success: true });
			expect(await runtime.handleContentPublish("docs", child.id)).toMatchObject({ success: true });
			const edges = await db
				.selectFrom("_emdash_content_references")
				.select(["child_group", "sort_order"])
				.where("parent_group", "=", parent.translationGroup!)
				.orderBy("sort_order")
				.execute();
			expect(edges).toEqual([
				{ child_group: sibling.translationGroup, sort_order: 0 },
				{ child_group: child.translationGroup, sort_order: 1 },
			]);
		});
		it("routes published API creation through hierarchy publication", async () => {
			const runtime = createTestRuntime(db);
			const result = await runtime.handleContentCreate("docs", {
				data: { title: "New guide" },
				slugSegment: "new-guide",
				status: "published",
				references: { parent: [parent.id] },
			});
			expect(result).toMatchObject({
				success: true,
				data: { item: { status: "published", slug: "product/new-guide" } },
			});
			if (!result.success) throw new Error("Creation failed");
			expect(result.data.item.liveRevisionId).toBeTruthy();
			const unpublished = await repo.create({
				type: "docs",
				slug: "unpublished",
				status: "draft",
				data: { title: "Unpublished" },
			});
			expect(
				await runtime.handleContentCreate("docs", {
					data: { title: "Hidden guide" },
					slugSegment: "hidden-guide",
					status: "published",
					references: { parent: [unpublished.id] },
				}),
			).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
			expect((await repo.findBySlug("docs", "unpublished/hidden-guide"))?.status).toBe("draft");
		});
		it("resolves pending paths only for their scoped preview token", async () => {
			const runtime = createTestRuntime(db);
			expect(
				await runtime.handleContentUpdate("docs", child.id, { slugSegment: "new-guide" }),
			).toMatchObject({ success: true });
			const saved = await repo.findById("docs", child.id);
			const loader = emdashLoader();
			const read = (preview?: { collection: string; id: string }) =>
				runWithContext({ db, editMode: false, preview }, () =>
					loader.loadEntry!({
						filter: { type: "docs", id: "product/new-guide", revisionId: saved!.draftRevisionId! },
					}),
				);
			expect(await read()).toBeUndefined();
			expect(await read({ collection: "docs", id: parent.id })).toBeUndefined();
			expect(await read({ collection: "docs", id: child.id })).toMatchObject({
				id: "product/new-guide",
				data: { title: "Getting started" },
			});
		});
		it("rejects cycles in draft reference edits", async () => {
			const runtime = createTestRuntime(db);
			expect(
				await runtime.handleContentUpdate("docs", parent.id, {
					data: {},
					references: { parent: [child.id] },
				}),
			).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
			expect((await repo.findById("docs", parent.id))?.draftRevisionId).toBeNull();
		});
		it("blocks removal of a parent until published descendants are unpublished", async () => {
			expect(await handleContentUnpublish(db, "docs", parent.id)).toMatchObject({ success: false });
			expect(await handleContentDelete(db, "docs", parent.id)).toMatchObject({
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "Move or unpublish the published descendants before removing their parent",
				},
			});
			expect(await handleContentUnpublish(db, "docs", child.id)).toMatchObject({ success: true });
			expect(await handleContentUnpublish(db, "docs", parent.id)).toMatchObject({ success: true });
		});
		it("keeps pending and published URLs separate in the admin response", async () => {
			const runtime = createTestRuntime(db);
			expect(
				await runtime.handleContentUpdate("docs", parent.id, { slugSegment: "renamed" }),
			).toMatchObject({ success: true });
			const result = await runtime.handleContentGet("docs", parent.id);
			expect(result).toMatchObject({
				success: true,
				data: { item: { slug: "product", draftSlug: "renamed" } },
			});
		});
		it("allows duplicate leaf names in separate products through native content creation", async () => {
			const other = await repo.create({
				type: "docs",
				slug: "other",
				status: "published",
				data: { title: "Other" },
			});
			const runtime = createTestRuntime(db);
			const result = await runtime.handleContentCreate("docs", {
				data: { title: "Getting started" },
				slugSegment: "getting-started",
				references: { parent: [other.id] },
			});
			expect(result).toMatchObject({
				success: true,
				data: { item: { slug: "other/getting-started" } },
			});
			if (result.success)
				expect(await runtime.handleContentPublish("docs", result.data.item.id)).toMatchObject({
					success: true,
				});
		});
		it("rejects a move that would change another author's URL without permission", async () => {
			await repo.updateDraftAware("docs", parent.id, { slug: "renamed" });
			expect(
				await handleContentPublish(db, "docs", parent.id, { actor: { id: "author", role: 30 } }),
			).toMatchObject({ success: false });
			expect((await repo.findById("docs", child.id))?.slug).toBe("product/getting-started");
		});
		it("rejects multilingual hierarchy before changing any URLs", async () => {
			setI18nConfig({ defaultLocale: "en", locales: ["en", "es"] });
			await repo.updateDraftAware("docs", parent.id, { slug: "renamed" });
			expect(await handleContentPublish(db, "docs", parent.id)).toMatchObject({ success: false });
			expect((await repo.findById("docs", parent.id))?.slug).toBe("product");
			setI18nConfig(null);
		});
		it("opts path encoding in without changing legacy slug encoding", () => {
			expect(
				interpolateUrlPattern({
					pattern: "/docs/{path}",
					collection: "docs",
					slug: "product/introducción",
					id: "id",
				}),
			).toBe("/docs/product/introducci%C3%B3n");
			expect(
				interpolateUrlPattern({
					pattern: "/docs/{slug}",
					collection: "docs",
					slug: "product/start",
					id: "id",
				}),
			).toBe("/docs/product%2Fstart");
			expect(compileUrlPattern("/docs/{path}").regex.exec("/docs/product/start")?.[1]).toBe(
				"product/start",
			);
			expect(compileUrlPattern("/docs/{slug}").regex.test("/docs/product/start")).toBe(false);
		});
		it("activates existing flat content explicitly without publishing its body draft", async () => {
			const registry = new SchemaRegistry(db);
			await registry.createCollection({
				slug: "legacy",
				label: "Legacy",
				supports: ["revisions"],
				urlPattern: "/legacy/{slug}",
			});
			await registry.createField("legacy", { slug: "title", label: "Title", type: "string" });
			await relations.create({
				slug: "legacy_tree",
				parentCollection: "legacy",
				childCollection: "legacy",
				parentLabel: "Parent",
				childLabel: "Children",
				maxParentsPerChild: 1,
			});
			const root = await repo.create({
				type: "legacy",
				slug: "product",
				status: "published",
				data: { title: "Product" },
			});
			const leaf = await repo.create({
				type: "legacy",
				slug: "start",
				status: "published",
				data: { title: "Start" },
			});
			await relations.setChildren("legacy_tree", root.translationGroup!, [leaf.translationGroup!]);
			await repo.updateDraftAware("legacy", leaf.id, { data: { title: "Unpublished" } });
			expect(
				await handleSchemaCollectionUpdate(db, "legacy", {
					hierarchyRelation: "legacy_tree",
					urlPattern: "/legacy/{path}",
				}),
			).toMatchObject({ success: true });
			expect(await repo.findById("legacy", leaf.id)).toMatchObject({
				slug: "product/start",
				data: { title: "Start" },
			});
			expect(
				await db
					.selectFrom("_emdash_redirects")
					.select(["source", "destination"])
					.where("source", "=", "/legacy/start")
					.execute(),
			).toEqual([{ source: "/legacy/start", destination: "/legacy/product/start" }]);
		});

		it("rolls back real content, revisions, references, and redirects when a later statement fails", async () => {
			await repo.updateDraftAware("docs", parent.id, { slug: "renamed" });
			const before = await db.selectFrom("revisions").selectAll().orderBy("id").execute();
			await sql`CREATE TRIGGER fail_hierarchy_redirect BEFORE INSERT ON _emdash_redirects
			WHEN NEW.source = '/docs/product/getting-started' BEGIN SELECT RAISE(ABORT, 'injected hierarchy failure'); END`.execute(
				db,
			);
			expect(await handleContentPublish(db, "docs", parent.id)).toMatchObject({ success: false });
			expect((await repo.findById("docs", parent.id))?.slug).toBe("product");
			expect((await repo.findById("docs", child.id))?.slug).toBe("product/getting-started");
			expect(await db.selectFrom("revisions").selectAll().orderBy("id").execute()).toEqual(before);
			expect(await db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
		});
		it("rejects stale publication revisions and commits exactly one competing move", async () => {
			await repo.updateDraftAware("docs", parent.id, { slug: "renamed" });
			const pending = await repo.findById("docs", parent.id);
			const revision = encodeRev(pending!);
			const outcomes = await Promise.all([
				handleContentPublish(db, "docs", parent.id, { _rev: revision }),
				handleContentPublish(db, "docs", parent.id, { _rev: revision }),
			]);
			expect(outcomes.filter((result) => result.success)).toHaveLength(1);
			expect(outcomes.filter((result) => !result.success)).toHaveLength(1);
			expect((await repo.findById("docs", child.id))?.slug).toBe("renamed/getting-started");
		});
	});
}
