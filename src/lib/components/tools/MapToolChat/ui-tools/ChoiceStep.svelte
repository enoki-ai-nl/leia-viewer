<script lang="ts">
	import { createEventDispatcher } from "svelte";
	import { _ } from "svelte-i18n";

	import type { ChoiceEvent } from "../chat-types";

	/* Vervolgvragen van de assistent met een knop per antwoord (ask_clarifying_questions in tools.ts). Een aanbevolen optie
	   valt op en noemt haar reden. Zolang de vragen open staan kan de gebruiker ook zelf typen.
	   Meldt een keuze met `choose`; de sessie stuurt het antwoord als alles beantwoord is. */
	export let choice: ChoiceEvent;
	/* De agent is nog bezig: dan kan er (nog) niet geantwoord worden. */
	export let busy = false;

	const dispatch = createEventDispatcher<{ choose: { question: number; option: number } }>();

	$: open = choice.status === "open";
</script>

<div class="choice" class:choice--done={!open}>
	{#each choice.questions as question, q}
		<div class="choice__question">{question.question}</div>
		<div class="choice__options">
			{#each question.options as option, o}
				{@const selected = choice.answers[q] === o}
				<button
					type="button"
					class="choice__button"
					class:choice__button--recommended={option.recommended}
					class:choice__button--selected={selected}
					disabled={!open || busy}
					aria-pressed={selected}
					on:click={() => dispatch("choose", { question: q, option: o })}
				>
					{option.label}
					{#if option.recommended}<span class="choice__tag">{$_("tools.chat.choice.recommended")}</span>{/if}
				</button>
			{/each}
		</div>
		{#each question.options.filter((option) => option.recommended && option.reason) as option}
			<div class="choice__reason">{$_("tools.chat.choice.because", { values: { reason: option.reason } })}</div>
		{/each}
	{/each}

	{#if open}
		<div class="choice__hint">
			{choice.questions.length > 1 ? $_("tools.chat.choice.hintMany") : $_("tools.chat.choice.hintOne")}
		</div>
	{:else if choice.status === "typed"}
		<div class="choice__hint">{$_("tools.chat.choice.typed")}</div>
	{/if}
</div>

<style>
	.choice {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		border-left: 3px solid var(--cds-interactive-01, #0f62fe);
		background: var(--cds-field-01, #ffffff);
		font-size: 0.75rem;
		color: var(--cds-text-01, #161616);
	}

	.choice--done {
		border-left-color: var(--cds-ui-04, #8d8d8d);
	}

	.choice__question {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.choice__options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.choice__button {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.75rem;
		border: 1px solid var(--cds-ui-04, #8d8d8d);
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.choice__button--recommended {
		border-color: var(--cds-interactive-01, #0f62fe);
		border-width: 2px;
	}

	.choice__button--selected {
		border-color: var(--cds-interactive-01, #0f62fe);
		background: var(--cds-interactive-01, #0f62fe);
		color: var(--cds-text-04, #ffffff);
	}

	.choice__button:disabled {
		cursor: default;
	}

	.choice__button:disabled:not(.choice__button--selected) {
		opacity: 0.5;
	}

	.choice__tag {
		padding: 0 0.25rem;
		background: var(--cds-interactive-01, #0f62fe);
		color: var(--cds-text-04, #ffffff);
		font-size: 0.625rem;
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}

	.choice__button--selected .choice__tag {
		background: var(--cds-text-04, #ffffff);
		color: var(--cds-interactive-01, #0f62fe);
	}

	.choice__reason,
	.choice__hint {
		color: var(--cds-text-02, #525252);
		font-style: italic;
		overflow-wrap: anywhere;
	}
</style>
