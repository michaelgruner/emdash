import type { Editor } from "@tiptap/react";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { PortableTextEditor, type PluginBlockDef } from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

import "../../dist/styles.css";

const blocks: PluginBlockDef[] = [
	{
		type: "callout",
		label: "Callout",
		pluginId: "test",
		content: { field: "body" },
		fields: [{ type: "text_input", action_id: "title", label: "Title" }],
	},
	{
		type: "tabs",
		label: "Tabs",
		pluginId: "test",
		content: { field: "body", items: { field: "panels", label: "Panel", titleField: "caption" } },
		fields: [
			{
				type: "repeater",
				action_id: "panels",
				label: "Panels",
				fields: [{ type: "text_input", action_id: "caption", label: "Caption" }],
			},
		],
	},
];
const paragraph = (text: string) => ({
	_type: "block" as const,
	_key: text,
	style: "normal",
	children: [{ _type: "span" as const, _key: `s${text}`, text }],
});
async function mount(value: Parameters<typeof PortableTextEditor>[0]["value"]) {
	let editor: Editor | undefined;
	const onChange = vi.fn();
	const screen = await render(
		<PortableTextEditor
			value={value}
			pluginBlocks={blocks}
			onChange={onChange}
			onEditorReady={(instance) => {
				editor = instance;
			}}
		/>,
	);
	await vi.waitFor(() => expect(editor).toBeTruthy());
	return { editor: editor!, screen, onChange };
}

describe("inline component editing", () => {
	it("edits nested text with shared undo and keeps component options", async () => {
		const { editor, onChange } = await mount([
			{
				_type: "callout",
				_key: "outer",
				title: "Outer",
				body: [{ _type: "callout", _key: "inner", title: "Inner", body: [paragraph("Nested")] }],
			},
		]);
		expect(editor.state.doc.textContent).toBe("Nested");
		let textPosition = 0;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === "Nested") textPosition = pos;
		});
		editor
			.chain()
			.setTextSelection(textPosition + 6)
			.insertContent(" edited")
			.run();
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
		expect(onChange.mock.lastCall?.[0]).toMatchObject([
			{
				_key: "outer",
				title: "Outer",
				body: [
					{
						_key: "inner",
						title: "Inner",
						body: [{ children: [{ text: "Nested" }, { text: " edited" }] }],
					},
				],
			},
		]);
		editor.commands.undo();
		expect(editor.state.doc.textContent).toBe("Nested");
	});
	it("moves and removes repeated items together with their bodies", async () => {
		const { screen, onChange } = await mount([
			{
				_type: "tabs",
				_key: "tabs",
				panels: [
					{ _key: "a", caption: "One", body: [paragraph("First")] },
					{ _key: "b", caption: "Two", body: [paragraph("Second")] },
				],
			},
		]);
		await screen.getByRole("button", { name: "Move down" }).nth(0).click();
		await vi.waitFor(() =>
			expect(onChange.mock.lastCall?.[0]).toMatchObject([
				{
					panels: [
						{ _key: "b", caption: "Two", body: [{ children: [{ text: "Second" }] }] },
						{ _key: "a", caption: "One" },
					],
				},
			]),
		);
		await screen.getByRole("button", { name: "Remove item" }).nth(0).click();
		await vi.waitFor(() =>
			expect(onChange.mock.lastCall?.[0]).toMatchObject([
				{ panels: [{ _key: "a", caption: "One" }] },
			]),
		);
	});
	it("changes component and item options without losing nested content", async () => {
		const { screen, onChange } = await mount([
			{
				_type: "tabs",
				_key: "tabs",
				panels: [
					{
						_key: "a",
						caption: "One",
						body: [
							{ _type: "callout", _key: "aside", title: "Original", body: [paragraph("Body")] },
						],
					},
				],
			},
		]);
		await screen.getByRole("button", { name: "Component settings" }).click();
		await page.getByRole("textbox", { name: "Title" }).fill("Renamed");
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await vi.waitFor(() =>
			expect(onChange.mock.lastCall?.[0]).toMatchObject([
				{
					panels: [
						{
							_key: "a",
							body: [{ _key: "aside", title: "Renamed", body: [{ children: [{ text: "Body" }] }] }],
						},
					],
				},
			]),
		);
		await screen.getByRole("button", { name: "Item settings" }).click();
		await page.getByRole("textbox", { name: "Caption" }).fill("Changed panel");
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await vi.waitFor(() =>
			expect(onChange.mock.lastCall?.[0]).toMatchObject([
				{ panels: [{ _key: "a", caption: "Changed panel", body: [{ title: "Renamed" }] }] },
			]),
		);
	});
	it("keeps containers and their options through the HTML clipboard format", async () => {
		const { editor } = await mount([
			{
				_type: "callout",
				_key: "outer",
				title: "Outer",
				body: [
					{
						_type: "tabs",
						_key: "tabs",
						panels: [{ _key: "p", caption: "First", body: [paragraph("Clipboard")] }],
					},
				],
			},
		]);
		const html = editor.getHTML();
		editor.commands.setContent(html);
		expect(editor.state.doc.firstChild?.attrs.data.title).toBe("Outer");
		expect(editor.state.doc.textContent).toBe("Clipboard");
		expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs.data.panels[0].caption).toBe(
			"First",
		);
	});

	it("exits the nearest container without lifting its content", async () => {
		const { editor } = await mount([
			{
				_type: "callout",
				_key: "outer",
				title: "Outer",
				body: [{ _type: "callout", _key: "inner", title: "Inner", body: [paragraph("Nested")] }],
			},
		]);
		let end = 0;
		editor.state.doc.descendants((node, pos) => {
			if (node.isText) end = pos + node.nodeSize;
		});
		editor.commands.focus(end);
		await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
		await userEvent.keyboard("{ControlOrMeta>}{Enter}{/ControlOrMeta}");
		editor.commands.insertContent("After inner");
		const outer = editor.state.doc.firstChild!;
		expect(outer.firstChild?.childCount).toBe(2);
		expect(outer.firstChild?.lastChild?.textContent).toBe("After inner");
		expect(outer.firstChild?.firstChild?.textContent).toBe("Nested");
	});
	it("rejects new nested media with an explanation", async () => {
		const { editor } = await mount([
			{ _type: "callout", _key: "outer", body: [paragraph("Body")] },
		]);
		editor.commands.setTextSelection(3);
		editor.commands.insertContent({
			type: "image",
			attrs: { src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" },
		});
		expect(editor.state.doc.firstChild?.textContent).toBe("Body");
		expect(editor.state.doc.firstChild?.firstChild?.childCount).toBe(1);
		await expect
			.element(page.getByRole("alert"))
			.toHaveTextContent("Media cannot be inserted inside components");
	});
	it("does not apply stale settings to the next component after deletion", async () => {
		const { editor, screen } = await mount([
			{ _type: "callout", _key: "first", title: "First", body: [paragraph("First body")] },
			{ _type: "callout", _key: "second", title: "Second", body: [paragraph("Second body")] },
		]);
		await screen.getByRole("button", { name: "Component settings" }).first().click();
		await page.getByRole("textbox", { name: "Title", exact: true }).fill("Changed first");
		editor.commands.deleteRange({ from: 0, to: editor.state.doc.firstChild!.nodeSize });
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect
			.element(page.getByRole("alert"))
			.toHaveTextContent("This component changed or was removed");
		expect(editor.state.doc.firstChild?.attrs.data.title).toBe("Second");
		expect(editor.state.doc.firstChild?.textContent).toBe("Second body");
	});
	it("inserts a content-only component directly from the slash menu", async () => {
		const { editor, screen, onChange } = await mount([]);
		editor.chain().focus().insertContent("/tabs").run();
		await screen.getByRole("button", { name: "Tabs", exact: true }).click();
		await expect.element(page.getByRole("dialog", { name: "Insert Tabs" })).not.toBeInTheDocument();
		await screen.getByRole("button", { name: "Add Panel", exact: true }).click();
		editor.commands.insertContent("New panel content");
		await vi.waitFor(() =>
			expect(onChange.mock.lastCall?.[0]).toMatchObject([
				{ panels: [{ body: [{ children: [{ text: "New panel content" }] }] }] },
			]),
		);
	});
	it("keeps item actions on the correct rows after earlier document content moves", async () => {
		const { editor, screen, onChange } = await mount([
			{
				_type: "tabs",
				_key: "tabs",
				panels: [
					{ _key: "one", caption: "One", body: [paragraph("First")] },
					{ _key: "two", caption: "Two", body: [paragraph("Second")] },
				],
			},
		]);
		editor.commands.insertContentAt(0, {
			type: "paragraph",
			content: [{ type: "text", text: "Prefix" }],
		});
		await screen.getByRole("button", { name: "Move down", exact: true }).first().click();
		await vi.waitFor(() =>
			expect(onChange.mock.lastCall?.[0]).toMatchObject([
				{ children: [{ text: "Prefix" }] },
				{
					panels: [
						{ _key: "two", caption: "Two", body: [{ children: [{ text: "Second" }] }] },
						{ _key: "one", caption: "One" },
					],
				},
			]),
		);
	});
	it("keeps an empty container when Backspace is pressed at its start", async () => {
		const { editor } = await mount([{ _type: "callout", _key: "empty", body: [] }]);
		editor.commands.focus(3);
		await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
		await userEvent.keyboard("{Backspace}");
		expect(editor.state.doc.firstChild?.type.name).toBe("pluginContainer");
		expect(editor.state.doc.firstChild?.firstChild?.firstChild?.type.name).toBe("paragraph");
	});
	it("continues inside a component on Enter and crosses its end with arrow navigation", async () => {
		const { editor } = await mount([
			{ _type: "callout", _key: "outer", body: [paragraph("Inside")] },
			paragraph("Outside"),
		]);
		editor.commands.focus(9);
		await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
		await userEvent.keyboard("{Enter}");
		expect(editor.state.doc.firstChild?.firstChild?.childCount).toBe(2);
		await userEvent.keyboard("{ArrowDown}{ArrowDown}");
		const { selection } = editor.state;
		expect(selection.$from.depth).toBe(1);
		expect(selection.$from.parent.textContent).toBe("Outside");
	});
	it("undoes removing a container with existing nested media", async () => {
		const image = {
			_type: "image",
			_key: "media",
			asset: {
				_ref: "",
				url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
			},
			caption: "Existing caption",
		};
		const { editor, screen } = await mount([
			{ _type: "callout", _key: "outer", title: "With image", body: [image] },
		]);
		let images = 0;
		editor.state.doc.descendants((node) => {
			if (node.type.name === "image") images++;
		});
		expect(images).toBe(1);
		await screen.getByRole("button", { name: "Remove component", exact: true }).click();
		expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
		editor.commands.undo();
		expect(editor.state.doc.firstChild?.attrs.data.title).toBe("With image");
		expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs.caption).toBe(
			"Existing caption",
		);
	});
});
