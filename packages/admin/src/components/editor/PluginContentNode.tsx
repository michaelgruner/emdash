import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Pencil, Trash } from "@phosphor-icons/react";
import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { NodeViewProps } from "@tiptap/react";
import {
	NodeViewContent,
	NodeViewWrapper,
	ReactNodeViewRenderer,
	useEditorState,
} from "@tiptap/react";

import { getRegistry, pluginBlockSettings } from "../../lib/plugin-content.js";
import { getLocaleDir } from "../../locales/config.js";

function nestedMedia(doc: ProseMirrorNode) {
	const counts = new Map<string, number>();
	doc.descendants((node, pos) => {
		if (!["image", "videoBlock", "gallery"].includes(node.type.name)) return;
		const $pos = doc.resolve(pos);
		if (
			!Array.from({ length: $pos.depth }, (_, i) => $pos.node(i + 1).type.name).includes(
				"pluginContent",
			)
		)
			return;
		const identity = JSON.stringify([
			node.type.name,
			node.attrs.mediaId,
			node.attrs.src,
			node.attrs.images,
		]);
		counts.set(identity, (counts.get(identity) ?? 0) + 1);
	});
	return counts;
}

function jsonAttribute(name: string, fallback: unknown) {
	return {
		default: fallback,
		parseHTML: (element: HTMLElement) => {
			try {
				return JSON.parse(element.getAttribute(name) ?? "null") ?? fallback;
			} catch {
				return fallback;
			}
		},
		renderHTML: (attributes: Record<string, unknown>) => {
			const key =
				name === "data-plugin-type"
					? "blockType"
					: name === "data-plugin-id"
						? "id"
						: name === "data-plugin-config"
							? "contentConfig"
							: "data";
			return { [name]: JSON.stringify(attributes[key]) };
		},
	};
}

function PluginContainerView({ node, editor, getPos, deleteNode }: NodeViewProps) {
	const { t, i18n } = useLingui();
	const registry = getRegistry(
		editor as unknown as { storage: Record<string, Record<string, unknown>> },
	);
	const definition = registry.get(node.attrs.blockType);
	const config = definition?.content;
	const repeater = definition?.fields?.find(
		(field) => field.type === "repeater" && field.action_id === config?.items?.field,
	);
	const edit = () => {
		const pos = getPos();
		if (typeof pos !== "number") return;
		const storage = editor.storage as unknown as Record<
			string,
			{ onEditBlock?: (attrs: Record<string, unknown>) => void }
		>;
		storage.pluginBlock?.onEditBlock?.({ ...node.attrs, pos });
	};
	return (
		<NodeViewWrapper className="my-3 rounded-md border border-kumo-line bg-kumo-base">
			<div
				contentEditable={false}
				dir={getLocaleDir(i18n.locale)}
				className="flex items-center gap-2 border-b border-kumo-line px-3 py-2"
			>
				<span data-drag-handle className="cursor-grab text-sm font-medium">
					{definition?.label ?? node.attrs.blockType}
				</span>
				<div className="ms-auto flex gap-1">
					{definition && !!pluginBlockSettings(definition).fields?.length && (
						<Button
							variant="ghost"
							size="sm"
							disabled={!editor.isEditable}
							onClick={edit}
							aria-label={t`Component settings`}
							title={t`Component settings`}
						>
							<Pencil size={16} />
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						disabled={!editor.isEditable}
						onClick={deleteNode}
						aria-label={t`Remove component`}
						title={t`Remove component`}
					>
						<Trash size={16} />
					</Button>
				</div>
			</div>
			<NodeViewContent dir="auto" className="px-3 py-2" />
			{config?.items && (
				<div
					contentEditable={false}
					dir={getLocaleDir(i18n.locale)}
					className="border-t border-kumo-line px-3 py-2"
				>
					<Button
						variant="secondary"
						size="sm"
						disabled={
							!editor.isEditable ||
							(repeater?.type === "repeater" &&
								repeater.max_items !== undefined &&
								node.childCount >= repeater.max_items)
						}
						onClick={() => {
							const pos = getPos();
							if (typeof pos !== "number") return;
							editor
								.chain()
								.focus()
								.insertContentAt(pos + node.nodeSize - 1, {
									type: "pluginContent",
									attrs: { blockType: node.attrs.blockType, data: { _key: crypto.randomUUID() } },
									content: [{ type: "paragraph" }],
								})
								.setTextSelection(pos + node.nodeSize + 1)
								.run();
						}}
					>{t`Add ${config.items.label}`}</Button>
				</div>
			)}
		</NodeViewWrapper>
	);
}

function PluginContentView({ node, editor, getPos, deleteNode }: NodeViewProps) {
	const { t, i18n } = useLingui();
	const location = () => {
		const pos = getPos();
		if (typeof pos !== "number" || pos < 0 || pos > editor.state.doc.content.size) return null;
		const current = editor.state.doc.nodeAt(pos);
		if (current?.type.name !== "pluginContent") return null;
		const resolved = editor.state.doc.resolve(pos);
		return { pos, node: current, parent: resolved.parent, index: resolved.index() };
	};
	const { index, count } = useEditorState({
		editor,
		selector: () => {
			const current = location();
			return { index: current?.index ?? 0, count: current?.parent.childCount ?? 0 };
		},
	});
	const definition = getRegistry(
		editor as unknown as { storage: Record<string, Record<string, unknown>> },
	).get(node.attrs.blockType);
	const items = definition?.content?.items;
	const title = items?.titleField ? node.attrs.data?.[items.titleField] : undefined;
	const repeater = definition?.fields?.find(
		(field) => field.type === "repeater" && field.action_id === items?.field,
	);
	const move = (offset: number) => {
		const current = location();
		if (
			!current ||
			current.index + offset < 0 ||
			current.index + offset >= current.parent.childCount
		)
			return;
		const { pos, node: item, parent, index: currentIndex } = current;
		const sibling = parent.child(currentIndex + offset);
		const target = offset < 0 ? pos - sibling.nodeSize : pos + sibling.nodeSize;
		const tr = editor.state.tr.delete(pos, pos + item.nodeSize).insert(target, item);
		editor.view.dispatch(tr);
	};
	return (
		<NodeViewWrapper className={items ? "my-2 rounded border border-kumo-line" : ""}>
			{items && (
				<div
					contentEditable={false}
					dir={getLocaleDir(i18n.locale)}
					className="flex items-center gap-2 border-b border-kumo-line px-2 py-1"
				>
					<span className="text-sm">
						{typeof title === "string" && title.trim() ? title : items.label}
					</span>
					<div className="ms-auto flex gap-1">
						<Button
							size="sm"
							variant="ghost"
							disabled={!editor.isEditable || index === 0}
							onClick={() => move(-1)}
							aria-label={t`Move up`}
							title={t`Move up`}
						>
							↑
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={!editor.isEditable || index >= count - 1}
							onClick={() => move(1)}
							aria-label={t`Move down`}
							title={t`Move down`}
						>
							↓
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={!editor.isEditable}
							aria-label={t`Item settings`}
							title={t`Item settings`}
							onClick={() => {
								const current = location();
								if (!current) return;
								const storage = editor.storage as unknown as Record<
									string,
									{ onEditBlock?: (attrs: Record<string, unknown>) => void }
								>;
								storage.pluginBlock?.onEditBlock?.({
									...current.node.attrs,
									pos: current.pos,
									item: true,
								});
							}}
						>
							<Pencil size={16} />
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={
								!editor.isEditable ||
								(repeater?.type === "repeater" && count <= (repeater.min_items ?? 0))
							}
							onClick={deleteNode}
							aria-label={t`Remove item`}
							title={t`Remove item`}
						>
							<Trash size={16} />
						</Button>
					</div>
				</div>
			)}
			<NodeViewContent className={items ? "px-3 py-2" : ""} />
		</NodeViewWrapper>
	);
}

export const PluginContainerExtension = Node.create({
	name: "pluginContainer",
	group: "block",
	content: "pluginContent*",
	isolating: true,
	defining: true,
	draggable: true,
	addAttributes() {
		return {
			blockType: jsonAttribute("data-plugin-type", null),
			id: jsonAttribute("data-plugin-id", null),
			data: jsonAttribute("data-plugin-data", {}),
			contentConfig: jsonAttribute("data-plugin-config", null),
		};
	},
	parseHTML() {
		return [{ tag: "div[data-plugin-container]" }];
	},
	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes, { "data-plugin-container": "" }), 0];
	},
	addNodeView() {
		return ReactNodeViewRenderer(PluginContainerView);
	},
});

export const PluginContentExtension = Node.create({
	name: "pluginContent",
	selectable: false,
	addKeyboardShortcuts() {
		return {
			"Mod-Enter": () => {
				const { state, view } = this.editor;
				const { $from } = state.selection;
				if ($from.parent.type.name === "codeBlock") return false;
				for (let depth = $from.depth; depth > 0; depth--) {
					if ($from.node(depth).type.name !== "pluginContainer") continue;
					const after = $from.after(depth);
					const tr = state.tr.insert(after, state.schema.nodes.paragraph!.create());
					tr.setSelection(TextSelection.create(tr.doc, after + 1));
					view.dispatch(tr.scrollIntoView());
					return true;
				}
				return false;
			},
		};
	},
	content: "(block | topBlock)+",
	isolating: true,
	defining: true,
	addAttributes() {
		return {
			blockType: jsonAttribute("data-plugin-type", null),
			data: jsonAttribute("data-plugin-data", {}),
		};
	},
	parseHTML() {
		return [{ tag: "div[data-plugin-content]" }];
	},
	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes, { "data-plugin-content": "" }), 0];
	},
	addNodeView() {
		return ReactNodeViewRenderer(PluginContentView);
	},
	addOptions() {
		return { onBlockedMedia: () => {} };
	},
	addProseMirrorPlugins() {
		const key = new PluginKey<ReadonlyMap<string, number>>("pluginContentMedia");
		return [
			new Plugin({
				key,
				state: {
					init: (_config, state) => nestedMedia(state.doc),
					apply: (_transaction, value) => value,
				},
				filterTransaction: (transaction, state) => {
					if (!transaction.docChanged) return true;
					const before = key.getState(state)!;
					for (const [identity, count] of nestedMedia(transaction.doc)) {
						if (count > (before.get(identity) ?? 0)) {
							this.options.onBlockedMedia();
							return false;
						}
					}
					return true;
				},
			}),
		];
	},
});
