<script lang="ts">
	import { getContext } from "svelte";
	import { _ } from "svelte-i18n";
	import Location from "carbon-icons-svelte/lib/Location.svelte";

	import {
		formatCell,
		ZOOM_AND_HIGHLIGHT_CONTEXT,
		type ZoomTarget,
		type ZoomToAndHighlight
	} from "./artifact";
	import type { Shape } from "./result-highlight";
	import type { Bbox } from "./ui-tools/zoom";

	/* Onder een antwoord over plekken: een knop die de kaart naar al die plekken laat vliegen
	   en ze markeert, en bij een kort resultaat ook een knop per plek. Zie zoomTargets in
	   artifact.ts. */
	export let target: ZoomTarget;

	/* Tot zoveel rijen krijgt elke rij hier ook een eigen knop; daarboven staan ze alleen in
	   de (ingeklapte) tussenstap van de query, en biedt het antwoord alleen "alles" aan. */
	const MAX_INLINE_ROWS = 5;

	const zoomToAndHighlight = getContext<ZoomToAndHighlight | undefined>(
		ZOOM_AND_HIGHLIGHT_CONTEXT
	);

	$: inline =
		target.count > 1 && target.count <= MAX_INLINE_ROWS
			? target.rows
					.map((row, i) => ({ row, bbox: target.bboxes[i], shape: target.shapes[i] ?? null }))
					.filter(
						(item): item is { row: typeof item.row; bbox: Bbox; shape: Shape | null } =>
							item.bbox !== null
					)
			: [];

	const rowLabel = (row: Record<string, unknown>) =>
		Object.values(row)
			.map(formatCell)
			.join(", ");
</script>

{#if zoomToAndHighlight}
	<div class="result-zoom">
		<button
			type="button"
			class="result-zoom__all"
			on:click={() => zoomToAndHighlight?.(target.bbox, target.shapes)}
		>
			<Location size={16} />
			{$_("tools.chat.zoomToResults", { values: { count: target.count } })}
		</button>
		{#each inline as { row, bbox, shape }}
			<button
				type="button"
				class="result-zoom__row"
				title={$_("tools.chat.zoomToRow")}
				on:click={() => zoomToAndHighlight?.(bbox, [shape])}
			>
				<Location size={16} />
				<span>{rowLabel(row)}</span>
			</button>
		{/each}
	</div>
{/if}

<style>
	.result-zoom {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
		max-width: 90%;
		margin-top: -0.5rem;
	}

	.result-zoom button {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		max-width: 100%;
		padding: 0.25rem 0.5rem;
		border: 1px solid var(--cds-ui-03, #e0e0e0);
		background: var(--cds-field-01, #ffffff);
		color: var(--cds-interactive-04, #0f62fe);
		font: inherit;
		font-size: 0.75rem;
		text-align: left;
		cursor: pointer;
	}

	.result-zoom button:hover {
		background: var(--cds-hover-ui, #e5e5e5);
	}

	.result-zoom__all {
		font-weight: 600;
	}

	.result-zoom__row span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--cds-text-01, #161616);
	}

	.result-zoom button :global(svg) {
		flex-shrink: 0;
	}
</style>
