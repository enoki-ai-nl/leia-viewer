<script lang="ts">
	import CheckmarkFilled from "carbon-icons-svelte/lib/CheckmarkFilled.svelte";
	import ChevronRight from "carbon-icons-svelte/lib/ChevronRight.svelte";
	import ErrorFilled from "carbon-icons-svelte/lib/ErrorFilled.svelte";
	import { _ } from "svelte-i18n";

	import type { ToolEvent } from "./chat-types";
	import { argsPreview } from "./artifact";
	import ResultTable from "./ResultTable.svelte";

	/* Eén aanroep van een backend-tool als inklapbare regel, zoals in frontend/
	   (ToolCallStep.tsx): een statusicoon en een leesbare zin, en uitgeklapt de
	   argumenten en het resultaat. Standaard dicht: de details zijn voor wie wil
	   nagaan hoe het antwoord tot stand kwam. */
	export let step: ToolEvent;

	let open = false;

	/* Een tool zonder eigen zin (`tools.chat.toolSteps.<tool>`) krijgt een algemene,
	   met de technische naam erin. */
	$: phase = step.status === "pending" ? "pending" : "done";
	$: label = $_(`tools.chat.toolSteps.${step.tool}.${phase}`, {
		default: $_(`tools.chat.toolSteps.fallback.${phase}`, { values: { tool: step.tool } })
	});
	$: args = argsPreview(step.args);
</script>

<div class="tool-step" class:tool-step--error={step.status === "error"}>
	<button
		class="tool-step__header"
		type="button"
		aria-expanded={open}
		title={step.tool}
		on:click={() => (open = !open)}
	>
		<span class="tool-step__icon">
			{#if step.status === "pending"}
				<span class="tool-step__spinner" />
			{:else if step.status === "error"}
				<ErrorFilled size={16} />
			{:else}
				<CheckmarkFilled size={16} />
			{/if}
		</span>
		<span class="tool-step__label">{label}</span>
		<span class="tool-step__chevron" class:tool-step__chevron--open={open}>
			<ChevronRight size={16} />
		</span>
	</button>

	{#if open}
		<div class="tool-step__body">
			{#if args && args !== "{}"}
				<pre class="tool-step__code">{args}</pre>
			{/if}
			{#if step.status === "error"}
				<span class="tool-step__error">{step.error}</span>
			{:else if step.status === "pending"}
				<span class="tool-step__muted">{$_("tools.chat.toolSteps.waiting")}</span>
			{:else if typeof step.content === "string"}
				<pre class="tool-step__text">{step.content}</pre>
			{:else}
				<ResultTable content={step.content} />
			{/if}
		</div>
	{/if}
</div>

<style>
	.tool-step {
		width: 100%;
		font-size: 0.75rem;
		color: var(--cds-text-02, #525252);
	}

	.tool-step__header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.25rem 0;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.tool-step__header:hover .tool-step__label {
		color: var(--cds-text-01, #161616);
	}

	.tool-step__icon {
		display: flex;
		flex-shrink: 0;
		color: var(--cds-support-02, #24a148);
	}

	.tool-step--error .tool-step__icon,
	.tool-step__error {
		color: var(--cds-support-01, #da1e28);
	}

	.tool-step__label {
		flex: 1;
		min-width: 0;
		font-style: italic;
	}

	.tool-step__chevron {
		display: flex;
		flex-shrink: 0;
		color: var(--cds-text-03, #a8a8a8);
		transition: transform 0.15s ease;
	}

	.tool-step__chevron--open {
		transform: rotate(90deg);
	}

	/* Een draaiend rondje zolang de tool bezig is. */
	.tool-step__spinner {
		width: 0.75rem;
		height: 0.75rem;
		margin: 0.125rem;
		border: 2px solid var(--cds-text-03, #a8a8a8);
		border-bottom-color: transparent;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* Ingesprongen onder het label, met een lijn links: zo hoort het bij de regel erboven. */
	.tool-step__body {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin: 0.25rem 0 0.25rem 0.5rem;
		padding: 0.25rem 0 0.25rem 0.75rem;
		border-left: 2px solid var(--cds-ui-03, #e0e0e0);
	}

	/* Zonder pre-wrap duwt een lange SQL-regel het paneel horizontaal open. */
	.tool-step__code,
	.tool-step__text {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-family: var(--cds-code-01-font-family, monospace);
		font-size: 0.6875rem;
	}

	.tool-step__text {
		max-height: 12rem;
		overflow-y: auto;
	}

	.tool-step__error {
		overflow-wrap: anywhere;
	}

	.tool-step__muted {
		color: var(--cds-text-03, #a8a8a8);
		font-style: italic;
	}

	@media (prefers-reduced-motion: reduce) {
		.tool-step__spinner {
			animation-duration: 2s;
		}

		.tool-step__chevron {
			transition: none;
		}
	}
</style>
