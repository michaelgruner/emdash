import { describe, expect, it } from "vitest";

import {
	encodeSlugPath,
	decodeSlugPath,
	resolveHierarchyPaths,
	validateSlugSegment,
} from "../../src/hierarchy/paths.js";

const entries = [
	{ id: "a", group: "a", slug: "product-a", published: true },
	{ id: "b", group: "b", slug: "product-b", published: true },
	{ id: "one", group: "one", slug: "getting-started", published: true },
	{ id: "two", group: "two", slug: "getting-started", published: true },
];
const edges = [
	{ parent: "a", child: "one", order: 0 },
	{ parent: "b", child: "two", order: 0 },
];

describe("hierarchical paths", () => {
	it("allows the same leaf in different products", () => {
		expect([...resolveHierarchyPaths(entries, edges)]).toEqual([
			["a", "product-a"],
			["b", "product-b"],
			["one", "product-a/getting-started"],
			["two", "product-b/getting-started"],
		]);
	});
	it("recomputes descendants when an ancestor is renamed", () => {
		expect(resolveHierarchyPaths(entries, edges, new Map([["a", "renamed"]])).get("one")).toBe(
			"renamed/getting-started",
		);
	});
	it("rejects siblings with the same segment", () => {
		expect(() =>
			resolveHierarchyPaths(
				entries,
				edges.map((edge) => ({ ...edge, parent: "a" })),
			),
		).toThrow("already used");
	});
	it("rejects cycles and missing reference targets", () => {
		expect(() =>
			resolveHierarchyPaths(entries, [...edges, { parent: "one", child: "a", order: 0 }]),
		).toThrow("cycle");
		expect(() =>
			resolveHierarchyPaths(entries, [{ parent: "missing", child: "a", order: 0 }]),
		).toThrow("missing content");
	});
	it("rejects multiple parents and an unpublished ancestor", () => {
		expect(() =>
			resolveHierarchyPaths(entries, [...edges, { parent: "b", child: "one", order: 0 }]),
		).toThrow("one parent");
		expect(() =>
			resolveHierarchyPaths(
				entries.map((entry) => (entry.id === "a" ? { ...entry, published: false } : entry)),
				edges,
			),
		).toThrow("Publish the parent");
	});
	it("decodes a path without treating encoded separators as nesting", () => {
		expect(decodeSlugPath("product/introducci%C3%B3n")).toBe("product/introducción");
		expect(decodeSlugPath("product%2Fstart")).toBeUndefined();
		expect(decodeSlugPath("product/%252F")).toBeUndefined();
	});
	it("encodes segments separately and supports Unicode", () => {
		expect(encodeSlugPath("product/introducción")).toBe("product/introducci%C3%B3n");
	});
	it.each(["", ".", "..", "a/b", "a\\b", "%2f", "a#b", "a?b", " a", "a\u0000"])(
		"rejects ambiguous segment %j",
		(segment) => {
			expect(() => validateSlugSegment(segment)).toThrow();
		},
	);
});
