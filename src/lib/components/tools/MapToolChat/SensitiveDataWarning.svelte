<script context="module" lang="ts">
	import { writable } from "svelte/store";

	/* Onthouden voor de browsersessie, dus bij een volgend bezoek komt de waarschuwing terug. */
	const STORAGE_KEY = "gaia.sensitiveDataWarningAccepted";

	function readAccepted(): boolean {
		try {
			return sessionStorage.getItem(STORAGE_KEY) === "true";
		} catch {
			return false; // sessionStorage geblokkeerd: dan elke keer opnieuw waarschuwen
		}
	}

	/* Of de gebruiker de waarschuwing heeft geaccepteerd; tot dan is de chat onbruikbaar. */
	export const warningAccepted = writable(readAccepted());

	function accept() {
		try {
			sessionStorage.setItem(STORAGE_KEY, "true");
		} catch {
			/* Niet op te slaan: dan alleen voor deze pagina geaccepteerd. */
		}
		warningAccepted.set(true);
	}
</script>

<script lang="ts">
	import { _ } from "svelte-i18n";
	import { WarningAltFilled } from "carbon-icons-svelte";

	/* Svelte-action: de knop heeft meteen de focus. */
	const focusOnMount = (node: HTMLElement) => node.focus();
</script>

<!-- Absolute binnen het chatpaneel (position: relative), net als ExportDialog: de overlay dekt
     het paneel, dat de chat eronder `inert` maakt tot de gebruiker accepteert. -->
<div class="sensitive-warning">
	<div
		class="sensitive-warning__box"
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="sensitive-warning-title"
		aria-describedby="sensitive-warning-text"
	>
		<div class="sensitive-warning__title" id="sensitive-warning-title">
			<WarningAltFilled size={20} class="sensitive-warning__icon" aria-hidden="true" />
			{$_("tools.chat.sensitiveDataWarning.title")}
		</div>
		<p class="sensitive-warning__text" id="sensitive-warning-text">
			{$_("tools.chat.sensitiveDataWarning.text")}
		</p>
		<div class="sensitive-warning__actions">
			<button class="sensitive-warning__button" type="button" use:focusOnMount on:click={accept}>
				{$_("tools.chat.sensitiveDataWarning.accept")}
			</button>
		</div>
	</div>
</div>

<style>
	.sensitive-warning {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
		background: rgb(0 0 0 / 40%);
		z-index: 12;
	}

	.sensitive-warning__box {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 100%;
		padding: 1rem;
		background: var(--cds-ui-01, #f4f4f4);
		border: 1px solid var(--cds-ui-03, #e0e0e0);
		border-left: 3px solid var(--cds-support-03, #f1c21b);
		box-shadow: 0 2px 12px rgb(0 0 0 / 25%);
	}

	.sensitive-warning__title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.sensitive-warning__title :global(.sensitive-warning__icon) {
		flex-shrink: 0;
		fill: var(--cds-support-03, #f1c21b);
	}

	.sensitive-warning__text {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.4;
	}

	.sensitive-warning__actions {
		display: flex;
		justify-content: flex-end;
	}

	.sensitive-warning__button {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--cds-interactive-01, #0f62fe);
		background: var(--cds-interactive-01, #0f62fe);
		color: var(--cds-text-04, #ffffff);
		font: inherit;
		cursor: pointer;
	}
</style>
