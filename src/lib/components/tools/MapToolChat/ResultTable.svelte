<script lang="ts">
	import { getContext } from "svelte";
	import { _ } from "svelte-i18n";
	import Location from "carbon-icons-svelte/lib/Location.svelte";

	import { artifactBboxes, artifactColumns, artifactRows, artifactSummary, formatCell, ZOOM_CONTEXT } from "./artifact";
	import type { Bbox } from "./ui-tools/zoom";

	/* Het resultaat van een backend-tool als tabel, met een bijschrift erboven. */
	export let content: unknown;

	const MAX_ROWS = 15;

	$: rows = artifactRows(content);
	$: columns = artifactColumns(rows);
	$: summary = artifactSummary(content, rows.length);
	$: bboxes = artifactBboxes(content);
	$: zoomable = bboxes.some(Boolean);

	/* Rijen met een geometrie krijgen een knop die de kaart naar die plek laat vliegen. */
	const zoomTo = getContext<((bbox: Bbox) => void) | undefined>(ZOOM_CONTEXT);
</script>

<span class="result__caption">
	{$_("tools.chat.results", { values: { count: summary.count } })}{#if summary.source}
		&middot; {summary.source}{/if}
</span>
{#if rows.length === 0}
	<span class="result__empty">{$_("tools.chat.noResults")}</span>
{:else}
	<div class="result__scroll">
		<table class="data-table">
			<thead>
				<tr>
					{#if zoomable && zoomTo}<th />{/if}
					{#each columns as column}<th>{column}</th>{/each}
				</tr>
			</thead>
			<tbody>
				{#each rows.slice(0, MAX_ROWS) as row, i}
					<tr>
						{#if zoomable && zoomTo}
							<td class="data-table__zoom">
								{#if bboxes[i]}
									<button
										type="button"
										title={$_("tools.chat.zoomToRow")}
										aria-label={$_("tools.chat.zoomToRow")}
										on:click={() => zoomTo?.(bboxes[i] ?? [0, 0, 0, 0])}
									>
										<Location size={16} />
									</button>
								{/if}
							</td>
						{/if}
						{#each columns as column}<td>{formatCell(row[column])}</td>{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if rows.length > MAX_ROWS}
		<span class="result__caption">
			{$_("tools.chat.moreRows", { values: { count: rows.length - MAX_ROWS } })}
		</span>
	{/if}
{/if}

<style>
	.result__caption,
	.result__empty {
		color: var(--cds-text-03, #a8a8a8);
	}

	.result__empty {
		font-style: italic;
	}

	/* De tabel mag breder worden dan het paneel; dit blok schuift dan in plaats van
	   de layout op te rekken. */
	.result__scroll {
		overflow-x: auto;
		max-width: 100%;
	}

	.data-table {
		border-collapse: collapse;
		font-size: 0.6875rem;
	}

	.data-table th,
	.data-table td {
		padding: 0.25rem 0.5rem;
		text-align: left;
		vertical-align: top;
		white-space: nowrap;
	}

	.data-table th {
		font-weight: 600;
		color: var(--cds-text-01, #161616);
		border-bottom: 1px solid var(--cds-ui-04, #8d8d8d);
	}

	.data-table td {
		border-bottom: 1px solid var(--cds-ui-03, #e0e0e0);
	}

	.data-table tbody tr:last-child td {
		border-bottom: none;
	}

	.data-table__zoom button {
		display: flex;
		padding: 0;
		border: none;
		background: none;
		color: var(--cds-interactive-04, #0f62fe);
		cursor: pointer;
	}
</style>
