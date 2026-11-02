import type { PluginBlockDef } from "../components/editor/PluginBlockNode.js";

const PARAGRAPH_BREAK = /\n\s*\n/;

export interface PluginContentNode {
	type: string;
	attrs?: Record<string, unknown>;
	content?: PluginContentNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function editablePluginNode(
	node: PluginContentNode,
	definition: PluginBlockDef,
	convert: (blocks: unknown[]) => PluginContentNode[],
): PluginContentNode {
	const config = definition.content;
	if (!config) return node;
	const data = record(node.attrs?.data);
	if (
		config.items &&
		data[config.items.field] !== undefined &&
		!Array.isArray(data[config.items.field])
	)
		return node;
	const rawRows = config.items ? data[config.items.field] : [data];
	const rows = Array.isArray(rawRows) ? rawRows : [];
	if (
		rows.some((value) => {
			const row = record(value);
			return (
				value !== row || (row[config.field] !== undefined && !Array.isArray(row[config.field]))
			);
		})
	)
		return node;
	return {
		...node,
		type: "pluginContainer",
		attrs: { ...node.attrs, contentConfig: config },
		content: rows.map((value) => {
			const row = record(value);
			const legacy = config.legacyField ? row[config.legacyField] : undefined;
			const rawBody = row[config.field];
			const body = Array.isArray(rawBody)
				? rawBody
				: typeof legacy === "string" && legacy.length > 0
					? legacy.split(PARAGRAPH_BREAK).map((text) => ({
							_type: "block",
							_key: crypto.randomUUID(),
							style: "normal",
							markDefs: [],
							children: [{ _type: "span", _key: crypto.randomUUID(), text, marks: [] }],
						}))
					: [];
			return {
				type: "pluginContent",
				attrs: { data: config.items ? row : {}, blockType: definition.type },
				content: convert(body),
			};
		}),
	};
}

export function serializePluginContainer(
	node: PluginContentNode,
	convert: (nodes: PluginContentNode[]) => unknown[],
): PluginContentNode {
	const config = contentConfig(node.attrs?.contentConfig);
	if (!config) throw new Error("Editable plugin container is missing its content definition");
	const data = { ...record(node.attrs?.data) };
	const withBody = (row: Record<string, unknown>, child: PluginContentNode) => {
		const result = { ...row, [config.field]: convert(child.content ?? []) };
		if (config.legacyField) delete result[config.legacyField];
		return result;
	};
	if (config.items) {
		data[config.items.field] = (node.content ?? []).map((child) =>
			withBody(record(child.attrs?.data), child),
		);
	} else {
		Object.assign(data, withBody(data, node.content?.[0] ?? { type: "pluginContent" }));
		if (config.legacyField) delete data[config.legacyField];
	}
	return { type: "pluginBlock", attrs: { ...node.attrs, data } };
}

/** Read the registry from editor storage */
export function getRegistry(editor: {
	storage: Record<string, Record<string, unknown>>;
}): Map<string, PluginBlockDef> {
	const storage = editor.storage.pluginBlock;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- populated by registerPluginBlocks in this editor
	return (storage?.registry as Map<string, PluginBlockDef>) ?? new Map();
}

export function pluginBlockSettings(definition: PluginBlockDef, item = false): PluginBlockDef {
	const config = definition.content;
	if (!config) return definition;
	const editableFields = (fields: PluginBlockDef["fields"]) =>
		fields?.filter(
			(field) => field.action_id !== config.field && field.action_id !== config.legacyField,
		);
	if (item && config.items) {
		return {
			...definition,
			label: config.items.label,
			content: { field: config.field, legacyField: config.legacyField },
			fields: editableFields(
				definition.fields?.flatMap((field) =>
					field.type === "repeater" && field.action_id === config.items?.field ? field.fields : [],
				),
			),
		};
	}
	return {
		...definition,
		fields: editableFields(definition.fields)?.filter(
			(field) => field.action_id !== config.items?.field,
		),
	};
}

function contentConfig(value: unknown): PluginBlockDef["content"] {
	if (!isRecord(value) || typeof value.field !== "string") return undefined;
	if (value.legacyField !== undefined && typeof value.legacyField !== "string") return undefined;
	if (value.items !== undefined) {
		if (
			!isRecord(value.items) ||
			typeof value.items.field !== "string" ||
			typeof value.items.label !== "string" ||
			(value.items.titleField !== undefined && typeof value.items.titleField !== "string")
		)
			return undefined;
		return {
			field: value.field,
			legacyField: value.legacyField,
			items: {
				field: value.items.field,
				label: value.items.label,
				titleField: value.items.titleField,
			},
		};
	}
	return { field: value.field, legacyField: value.legacyField };
}
