import { describe, expect, it } from "vitest";

import { generateBlockComponentsModule } from "../../../src/astro/integration/virtual-modules.js";

function moduleUrl(source: string): string {
	return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

describe("plugin component registration", () => {
	it("reads live component exports after recursive renderer imports initialize", async () => {
		const pluginUrl = moduleUrl(`
			export let blockComponents = { aside: undefined };
			export function initialize() { blockComponents = { aside: "initialized renderer" }; }
		`);
		const generated = generateBlockComponentsModule([
			{
				id: "nested-test",
				version: "1.0.0",
				format: "native",
				entrypoint: "test",
				componentsEntry: pluginUrl,
			},
		]);
		const plugin = await import(/* @vite-ignore */ pluginUrl);
		const registry = await import(/* @vite-ignore */ moduleUrl(generated));
		expect(registry.getPluginBlockComponents()).toEqual({ aside: undefined });
		plugin.initialize();
		expect(registry.getPluginBlockComponents()).toEqual({ aside: "initialized renderer" });
	});

	it("provides an empty component map without native plugin renderers", async () => {
		const registry = await import(/* @vite-ignore */ moduleUrl(generateBlockComponentsModule([])));
		expect(registry.getPluginBlockComponents()).toEqual({});
	});
});
