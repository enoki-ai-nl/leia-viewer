<script lang="ts">
	import { Accordion } from "carbon-components-svelte";

	import LayerControl from "../../MapToolLayerManager/MapToolLayerControl.svelte";
	import { _ } from "svelte-i18n";

	import { GAIA_GROUP_ID } from "./gaia-layers";

	import type { Layer } from "$lib/map-core/layer";
	import type { LayerLibrary } from "$lib/map-core/layer-library";
	import { TestTool } from "carbon-icons-svelte";

	export let library: LayerLibrary;
	/* The layers on the map: every dataset is on it (hidden until switched on), with the full layer controls. */
	export let layers: Array<Layer>;

	$: libraryGroups = library.groups;
	/* The group appears once the datasets have been fetched, and is a new store then. */
	const findGroup = (_groups: unknown) => library.findGroup(GAIA_GROUP_ID);
	$: group = findGroup($libraryGroups);
	$: configs = group?.layerConfigs;

	/* Looked up in the template with `layers` itself: a helper function would hide the
       dependency from Svelte and the rows would not follow the layers on the map. */
</script>

<div class="chat-ai-layers">
	<div class="bx--label gaia-label" title={$_("tools.chat.gaiaLayersDescription")}>{$_("tools.chat.gaiaLayers")}</div>
	<Accordion class="layer-group-accordion">
		{#if group && $configs && $configs.length > 0}
			{#each $configs as config (config.id)}
				{@const layer = layers.find((candidate) => candidate.config === config)}
				{#if layer}
					<LayerControl {layer} />
				{/if}
			{/each}
		{:else}
			<div class="bx--label no-layers-label">{$_("tools.chat.noLayers")}</div>
		{/if}
	</Accordion>
</div>

<style>
	.gaia-label {
		margin-top: var(--cds-spacing-05);
		padding: 0 var(--cds-spacing-05);
		cursor: help;
	}

	.no-layers-label {
		padding: 0 var(--cds-spacing-05);
		font-style: italic;
	}
</style>
