<script lang="ts">
	import { Tag } from "carbon-components-svelte";
	import { _ } from "svelte-i18n";

	import LayerControl from "../../MapToolLayerManager/MapToolLayerControl.svelte";
	import { gaiaDatasets, origin, originLines, type Origin } from "./gaia-layers";

	import type { Layer } from "$lib/map-core/layer";

	/* Eén laag onder "Ingeladen lagen": de gewone laagbediening, en bij een afgeleide laag
	   (werkitem #69) een label "Afgeleid" met de lagen waar hij van gemaakt is. Die herkomst
	   staat in de tooltip van het label en, voor wie niet kan hoveren, in het laagpaneel. */
	export let layer: Layer;

	$: trace = origin(layer.config.settings?.datasetId, $gaiaDatasets);
	$: lines = trace.kind === "derived" ? traceLines(trace) : [];

	/* Wat er bij een bron achter de naam komt. */
	function note(node: Origin): string {
		if (node.kind === "wfs") return $_("tools.chat.originWfs", { values: { host: node.host ?? "?" } });
		if (node.kind === "upload") return $_("tools.chat.originUpload");
		if (node.kind === "deleted") return $_("tools.chat.originDeleted");
		return node.frozen ? $_("tools.chat.originFrozen") : "";
	}

	/* De herkomst als tekstregels, ingesprongen per niveau. Harde spaties (\u00a0), omdat
	   HTML en een tooltip gewone spaties aan het begin van een regel weglaten. */
	function traceLines(root: Origin): string[] {
		const head = [
			...(root.frozen ? [$_("tools.chat.originFrozenLong")] : []),
			root.sources ? $_("tools.chat.derivedFrom") : $_("tools.chat.originUnknown")
		];
		const sources = originLines(root).map(({ depth, origin }) =>
			"\u00a0\u00a0\u00a0".repeat(depth - 1) + "↳ " + [origin.name, note(origin)].filter(Boolean).join(" · ")
		);
		return [...head, ...sources];
	}
</script>

<LayerControl {layer}>
	<svelte:fragment slot="badge">
		{#if trace.kind === "derived"}
			<span class="derived-tag" title={lines.join("\n")}>
				<Tag size="sm" type="cool-gray">{$_("tools.chat.derived")}</Tag>
			</span>
		{/if}
	</svelte:fragment>
	<svelte:fragment slot="details">
		{#if trace.kind === "derived"}
			<div class="origin label-01">
				{#each lines as line}
					<div>{line}</div>
				{/each}
			</div>
		{/if}
	</svelte:fragment>
</LayerControl>

<style>
	.derived-tag {
		flex-shrink: 0;
		cursor: help;
	}

	.derived-tag :global(.bx--tag) {
		margin: 0 var(--cds-spacing-02);
	}

	.origin {
		margin-bottom: var(--cds-spacing-05);
		color: var(--cds-text-02);
	}
</style>
