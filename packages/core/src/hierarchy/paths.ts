import { EmDashValidationError } from "../database/repositories/types.js";

export interface HierarchyEntry {
	id: string;
	group: string;
	slug: string;
	published: boolean;
}

export interface HierarchyEdge {
	parent: string;
	child: string;
	order: number;
}

// oxlint-disable-next-line no-control-regex -- URL segments must reject control characters.
const INVALID_SEGMENT_SYNTAX = /[\\/\u0000-\u001f\u007f?#%]/u;

export function validateSlugSegment(segment: string): string {
	if (
		!segment ||
		segment !== segment.trim() ||
		segment === "." ||
		segment === ".." ||
		INVALID_SEGMENT_SYNTAX.test(segment) ||
		segment !== segment.normalize("NFC")
	) {
		throw new EmDashValidationError(
			"A URL segment must be nonempty and cannot contain path separators or encoded URL syntax",
		);
	}
	return segment;
}

export function encodeSlugPath(slug: string): string {
	return slug
		.split("/")
		.map((segment) => encodeURIComponent(validateSlugSegment(segment)))
		.join("/");
}

/** Compute paths without deriving parentage from the old URL. */
export function resolveHierarchyPaths(
	entries: readonly HierarchyEntry[],
	edges: readonly HierarchyEdge[],
	segments: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
	const byGroup = new Map(entries.map((entry) => [entry.group, entry]));
	if (byGroup.size !== entries.length) {
		throw new EmDashValidationError(
			"Hierarchical collections currently require one content locale",
		);
	}
	const parents = new Map<string, string>();
	for (const edge of edges) {
		if (!byGroup.has(edge.parent) || !byGroup.has(edge.child)) {
			throw new EmDashValidationError("A hierarchy reference points to missing content");
		}
		if (parents.has(edge.child))
			throw new EmDashValidationError("A hierarchical entry can have only one parent");
		parents.set(edge.child, edge.parent);
	}
	const paths = new Map<string, string>();
	const occupied = new Map<string, string>();
	for (const entry of entries) {
		const chain: HierarchyEntry[] = [];
		const visiting = new Set<string>();
		let current: HierarchyEntry | undefined = entry;
		while (current && !paths.has(current.id)) {
			if (visiting.has(current.group))
				throw new EmDashValidationError("A hierarchy cannot contain a cycle");
			visiting.add(current.group);
			chain.push(current);
			const parent = parents.get(current.group);
			const parentEntry = parent === undefined ? undefined : byGroup.get(parent);
			if (current.published && parentEntry && !parentEntry.published) {
				throw new EmDashValidationError("Publish the parent before publishing a child");
			}
			current = parentEntry;
		}
		let prefix = current ? (paths.get(current.id) ?? "") : "";
		for (const node of chain.toReversed()) {
			const segment = validateSlugSegment(
				segments.get(node.id) ?? node.slug.split("/").at(-1) ?? "",
			);
			const path = prefix ? `${prefix}/${segment}` : segment;
			const owner = occupied.get(path);
			if (owner && owner !== node.id)
				throw new EmDashValidationError(`The URL '${path}' is already used by another entry`);
			occupied.set(path, node.id);
			paths.set(node.id, path);
			prefix = path;
		}
	}
	return paths;
}

/** Decode each segment once; an encoded separator must not introduce parentage. */
export function decodeSlugPath(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	try {
		return raw
			.split("/")
			.map((segment) => validateSlugSegment(decodeURIComponent(segment)))
			.join("/");
	} catch {
		return undefined;
	}
}
