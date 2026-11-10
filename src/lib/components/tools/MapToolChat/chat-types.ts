/* Wat het chatpaneel toont, in de volgorde waarin het gebeurde. */

export type UiStatus = "awaiting" | "running" | "applied" | "dismissed" | "failed" | "expired";

/* Een instructie van de assistent aan de viewer (bijv. "voeg deze laag toe"). */
export interface UiEvent {
	type: "ui";
	toolCallId: string;
	toolName: string;
	summary: string;
	status: UiStatus;
	detail?: string;
}

/* Een aanroep van een backend-tool en, zodra die er is, de uitkomst: JSON als het
   dat was, anders tekst. `pending` tot het resultaat binnen is. */
export interface ToolEvent {
	type: "tool";
	toolCallId: string;
	tool: string;
	args: unknown;
	status: "pending" | "done" | "error";
	content?: unknown;
	error?: string;
}

export type ChatEvent =
	/* De vraag van de gebruiker. */
	| { type: "question"; text: string }
	/* Een antwoord van de assistent, in markdown. */
	| { type: "answer"; markdown: string }
	| ToolEvent
	| UiEvent
	/* Een mislukte run, of een vraag die niet verstuurd kon worden. */
	| { type: "error"; error: string };
