import { describe, expect, it } from "vitest";

import type { PluginBlockDef } from "../../src/components/editor/PluginBlockNode";
import {
	_portableTextToProsemirror as toEditor,
	_prosemirrorToPortableText as toPortableText,
} from "../../src/components/PortableTextEditor";
import type { PluginContentNode } from "../../src/lib/plugin-content";

const definitions: PluginBlockDef[] = [
	{
		type: "callout",
		label: "Callout",
		pluginId: "test",
		content: { field: "body", legacyField: "text" },
	},
	{
		type: "tabs",
		label: "Tabs",
		pluginId: "test",
		content: {
			field: "body",
			legacyField: "text",
			items: { field: "panels", label: "Panel", titleField: "caption" },
		},
	},
];
const types = new Set(definitions.map((item) => item.type));
const paragraph = (text: string) => ({
	_type: "block" as const,
	_key: `p-${text}`,
	style: "normal",
	children: [{ _type: "span" as const, _key: `s-${text}`, text }],
});

describe("editable plugin content", () => {
	it("round-trips nested containers, formatted links, code, and unknown metadata", () => {
		const input = [
			{
				_type: "callout",
				_key: "aside",
				tone: "tip",
				_custom: { kept: true },
				body: [
					{
						...paragraph("Link"),
						markDefs: [{ _type: "link", _key: "link", href: "/docs/test" }],
						children: [{ _type: "span", _key: "linked", text: "Link", marks: ["strong", "link"] }],
					},
					{
						_type: "callout",
						_key: "nested",
						title: "Child",
						body: [{ _type: "code", _key: "code", language: "typescript", code: "const a = 1;" }],
					},
				],
			},
		];
		const doc = toEditor(input, types, definitions);
		expect(doc.content[0]).toMatchObject({
			type: "pluginContainer",
			content: [
				{ type: "pluginContent", content: [{ type: "paragraph" }, { type: "pluginContainer" }] },
			],
		});
		expect(toPortableText(doc)).toEqual(input);
	});
	it("preserves item identity and all content when items are reordered", () => {
		const input = [
			{
				_type: "tabs",
				_key: "tabs",
				theme: "custom",
				panels: [
					{ _key: "one", caption: "One", icon: "home", body: [paragraph("First")] },
					{ _key: "two", caption: "Two", body: [paragraph("Second")] },
				],
			},
		];
		const doc = toEditor(input, types, definitions);
		const container = doc.content[0] as PluginContentNode;
		container.content!.reverse();
		expect(toPortableText(doc)).toEqual([
			{ ...input[0], panels: [input[0]!.panels[1], input[0]!.panels[0]] },
		]);
	});
	it("converts legacy text without mutating the source value", () => {
		const input = [{ _type: "callout", _key: "old", text: "First\n\nSecond", tone: "note" }];
		const doc = toEditor(input, types, definitions);
		expect(input[0]!.text).toBe("First\n\nSecond");
		const saved = toPortableText(doc);
		expect(saved[0]).not.toHaveProperty("text");
		expect(saved[0]).toMatchObject({
			_key: "old",
			tone: "note",
			body: [{ children: [{ text: "First" }] }, { children: [{ text: "Second" }] }],
		});
	});
	it("keeps unregistered blocks opaque", () => {
		const input = [{ _type: "other", _key: "opaque", body: [paragraph("Unregistered")] }];
		expect(toEditor(input, types, definitions).content[0]).toMatchObject({ type: "pluginBlock" });
		expect(toPortableText(toEditor(input, types, definitions))).toEqual(input);
	});
});
