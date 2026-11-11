import { tick } from "svelte";
import { get, writable, type Readable } from "svelte/store";
import { _, locale } from "svelte-i18n";
import { HttpAgent, type AgentSubscriber } from "@ag-ui/client";

import type { Map } from "$lib/map-cesium/map";
import { getWfsAttributeNames } from "$lib/map-cesium/providers/wfs-attributes";

import { chatApiUrl, datasetsChanged } from "./chat-store";
import type { ChatEvent, ChoiceEvent, ToolEvent, UiEvent } from "./chat-types";
import { exportConversation } from "./conversation-export";
import { authHeaders, getUserKey } from "./user-key";
import { getUiTool, toAgUiTools } from "./ui-tools/tools";
import { labelLayers, layerProperties, newId } from "./ui-tools/layers";
import { uiToolApproval, setApproval } from "./ui-tools/settings";
import type { UiTool } from "./ui-tools/types";
import { ANSWERED_IN_OWN_WORDS, describeAnswers, type AskArgs } from "./ui-tools/tools";

interface UiCall {
	tool: UiTool<unknown>;
	args: unknown;
}

const DECLINED = "The user declined this instruction.";

/* Backend-tools die een dataset in de database zetten: daarna moet de lijst met AI-lagen hem tonen. */
const DATASET_TOOLS = new Set(["wfs_load_to_table"]);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface ChatSession {
	events: Readable<ChatEvent[]>;
	/* De agent is aan het denken. */
	busy: Readable<boolean>;
	/* Het verbruik over het hele gesprek. */
	totalTokens: Readable<number>;
	/* De sleutel van de ingelogde gebruiker; leeg tot de eerste vraag erom vraagt. */
	userKey: Readable<string>;
	ask(question: string): Promise<void>;
	/* Stopt de lopende run; wat de agent al af had blijft staan. */
	stop(): void;
	applyUi(toolCallId: string): void;
	/* Kies een optie bij een vervolgvraag; zijn alle vragen beantwoord, dan gaat het antwoord
	   meteen naar de agent. */
	choose(toolCallId: string, questionIndex: number, optionIndex: number): void;
	dismissUi(toolCallId: string): void;
	alwaysApplyUi(toolCallId: string, toolName: string): void;
	exportConversation(reason: string): Promise<void>;
}

export function createChatSession(getMap: () => Map | undefined): ChatSession {
	const events = writable<ChatEvent[]>([]);
	const busy = writable(false);
	const totalTokens = writable(0);
	const userKey = writable("");

	/* De gespreksdraad van deze pagina: herladen begint een nieuw gesprek. De backend
	   maakt er samen met het sessietoken de draad-id van. */
	const conversationId = newId();

	/* De AG-UI-client houdt het gesprek bij en stuurt het bij elke vraag opnieuw mee. */
	let agent: HttpAgent | undefined;

	/* Instructies die op de keuze van de gebruiker wachten. */
	const awaiting: Record<string, UiCall> = {};

	/* Uitkomsten van instructies die de agent nog niet kent. Ze gaan mee vóór de
	   volgende vraag: die volgorde verwacht de backend. */
	let pendingResults: { toolCallId: string; content: string; error?: string }[] = [];

	/* Breekt de lopende vraag af (zie stop); undefined als er geen loopt. */
	let runAbort: AbortController | undefined;
	/* Afbreken eindigt de run met een fout; die heeft de gebruiker zelf veroorzaakt. */
	const stopped = () => runAbort?.signal.aborted ?? false;

	/* Instructies lopen één voor één, in de volgorde van de agent. */
	let execution: Promise<void> = Promise.resolve();

	const push = (event: ChatEvent) => events.update((list) => [...list, event]);

	/* Een backend-tool krijgt zijn resultaat bij de stap van zijn aanroep. */
	function patchTool(toolCallId: string, patch: Partial<ToolEvent>) {
		events.update((list) =>
			list.map((e) => (e.type === "tool" && e.toolCallId === toolCallId ? { ...e, ...patch } : e))
		);
	}

	function patchUi(toolCallId: string, patch: Partial<UiEvent>) {
		events.update((list) =>
			list.map((e) => (e.type === "ui" && e.toolCallId === toolCallId ? { ...e, ...patch } : e))
		);
	}

	function finishUi(toolCallId: string, status: UiEvent["status"], detail: string) {
		patchUi(toolCallId, { status, detail });
		pendingResults.push({ toolCallId, content: detail, error: status === "failed" ? detail : undefined });
	}

	function runUi(toolCallId: string, call: UiCall) {
		patchUi(toolCallId, { status: "running" });
		execution = execution.then(async () => {
			try {
				const map = getMap();
				const apiUrl = get(chatApiUrl);
				if (!map) throw new Error("De kaart is niet beschikbaar.");
				if (!apiUrl) throw new Error("De backend-URL is niet bekend.");
				const detail = await call.tool.execute(call.args, { map, apiUrl, userKey: get(userKey) });
				finishUi(toolCallId, "applied", detail);
			} catch (error) {
				finishUi(toolCallId, "failed", errorText(error));
			}
			/* Laat Svelte de wijziging (bijv. een nieuwe laag) verwerken voor de volgende. */
			await tick();
		});
	}

	/* --- Vervolgvragen met keuzeknoppen (ask_clarifying_questions in ui-tools/tools.ts) --- */

	/* De vragen die op een antwoord wachten, met hun argumenten. */
	const openChoices: Record<string, AskArgs> = {};

	function patchChoice(toolCallId: string, patch: Partial<ChoiceEvent>) {
		events.update((list) =>
			list.map((e) => (e.type === "choice" && e.toolCallId === toolCallId ? { ...e, ...patch } : e))
		);
	}

	function choose(toolCallId: string, questionIndex: number, optionIndex: number) {
		const args = openChoices[toolCallId];
		const event = get(events).find((e): e is ChoiceEvent => e.type === "choice" && e.toolCallId === toolCallId);
		if (!args || !event || get(busy)) return;
		const answers = [...event.answers];
		answers[questionIndex] = optionIndex;
		patchChoice(toolCallId, { answers });
		if (answers.length < args.questions.length || answers.some((answer) => answer === undefined)) return;

		/* Alles beantwoord: de keuze als resultaat van de tool, en als bericht van de gebruiker,
		   zodat het gesprek gewoon doorgaat (en de keuze in de chat staat). */
		delete openChoices[toolCallId];
		const chosen = answers as number[];
		patchChoice(toolCallId, { status: "answered" });
		pendingResults.push({ toolCallId, content: describeAnswers(args, chosen) });
		void ask(args.questions.map((q, i) => q.options[chosen[i]].label).join("; "));
	}

	function handleUiCall(toolCallId: string, toolName: string, rawArgs: unknown) {
		const tool = getUiTool(toolName)!;
		let args: unknown;
		try {
			args = tool.parse(rawArgs);
		} catch (error) {
			/* De agent hoort waarom en kan het bij de volgende vraag opnieuw proberen. Zonder
			   geldige argumenten valt er niets te beschrijven: dan het label van de tool. */
			const summary = get(_)(`tools.chat.uiTools.${toolName}`, { default: toolName });
			push({ type: "ui", toolCallId, toolName, summary, status: "failed" });
			finishUi(toolCallId, "failed", errorText(error));
			return;
		}

		/* Een vraag aan de gebruiker: tonen en wachten, niets uitvoeren of goedkeuren. */
		if (tool.interactive) {
			const ask = args as AskArgs;
			openChoices[toolCallId] = ask;
			push({ type: "choice", toolCallId, questions: ask.questions, answers: [], status: "open" });
			return;
		}

		push({ type: "ui", toolCallId, toolName, summary: tool.describe(args), status: "awaiting" });
		if ((get(uiToolApproval)[toolName] ?? tool.defaultApproval) === "auto") {
			runUi(toolCallId, { tool, args });
		} else {
			awaiting[toolCallId] = { tool, args };
		}
	}

	function applyUi(toolCallId: string) {
		const call = awaiting[toolCallId];
		if (!call) return;
		delete awaiting[toolCallId];
		runUi(toolCallId, call);
	}

	function dismissUi(toolCallId: string) {
		if (!awaiting[toolCallId]) return;
		delete awaiting[toolCallId];
		finishUi(toolCallId, "dismissed", DECLINED);
	}

	function alwaysApplyUi(toolCallId: string, toolName: string) {
		setApproval(toolName, "auto");
		applyUi(toolCallId);
	}

	/* De AG-UI-events vertaald naar wat het paneel toont. */
	const subscriber: AgentSubscriber = {
		onTextMessageEndEvent: ({ textMessageBuffer }) => {
			if (textMessageBuffer.trim()) push({ type: "answer", markdown: textMessageBuffer });
		},

		onToolCallEndEvent: ({ event, toolCallName, toolCallArgs }) => {
			const toolCallId = event.toolCallId;
			if (getUiTool(toolCallName)) handleUiCall(toolCallId, toolCallName, toolCallArgs);
			else push({ type: "tool", toolCallId, tool: toolCallName, args: toolCallArgs, status: "pending" });
		},

		onToolCallResultEvent: ({ event }) => {
			if (event.metadata?.error) {
				patchTool(event.toolCallId, { status: "error", error: String(event.content) });
				return;
			}
			let content: unknown = event.content;
			try {
				if (typeof content === "string") content = JSON.parse(content);
			} catch {
				/* gewone tekst: laten zoals hij is */
			}
			patchTool(event.toolCallId, { status: "done", content });
			const call = get(events).find((e) => e.type === "tool" && e.toolCallId === event.toolCallId);
			if (call?.type === "tool" && DATASET_TOOLS.has(call.tool)) datasetsChanged.update((n) => n + 1);
		},

		/* Geen usage betekent dat geen modelaanroep iets meldde, niet dat het nul tokens waren. */
		onRunFinishedEvent: ({ event }) => {
			const tokens = (event.usage ?? []).reduce((sum, usage) => sum + (usage.totalTokens ?? 0), 0);
			totalTokens.update((total) => total + tokens);
		},

		onRunErrorEvent: ({ event }) => {
			if (!stopped()) push({ type: "error", error: event.message });
		},

		onRunFailed: ({ error }) => {
			if (stopped()) return;
			console.error("Agent-run mislukt:", error);
			push({ type: "error", error: get(_)("tools.chat.errors.noConnection") });
		}
	};

	async function ask(question: string) {
		if (get(busy)) return;
		busy.set(true);
		const abort = new AbortController();
		runAbort = abort;

		try {
			const apiUrl = get(chatApiUrl);
			if (!apiUrl) throw new Error(get(_)("tools.chat.errors.noApiUrl"));
			if (!get(userKey)) userKey.set(await getUserKey(apiUrl));
			const map = getMap();
			const refs = await webserviceRefs(map);

			/* Gestopt terwijl we nog inlogden of de lagen ophaalden: niets versturen. */
			if (abort.signal.aborted) {
				push({ type: "question", text: question });
				push({ type: "stopped" });
				return;
			}

			agent ??= new HttpAgent({ url: `${apiUrl}/agent/run`, threadId: conversationId });
			agent.headers = authHeaders(get(userKey));

			/* Onbeantwoorde instructies vervallen; de backend vult zelf "geen resultaat" in. */
			for (const toolCallId of Object.keys(awaiting)) {
				patchUi(toolCallId, { status: "expired" });
				delete awaiting[toolCallId];
			}

			/* Vervolgvragen waar niet op geklikt is: de gebruiker antwoordt met wat hij nu typte. */
			for (const toolCallId of Object.keys(openChoices)) {
				patchChoice(toolCallId, { status: "typed" });
				pendingResults.push({ toolCallId, content: ANSWERED_IN_OWN_WORDS });
				delete openChoices[toolCallId];
			}

			/* Eerst wat er met eerdere instructies is gebeurd, dan de nieuwe vraag. */
			for (const { toolCallId, content, error } of pendingResults) {
				agent.addMessage({ id: newId(), role: "tool", toolCallId, content, error });
			}
			pendingResults = [];
			agent.addMessage({ id: newId(), role: "user", content: question });

			/* De agent kent de lagen alleen hieruit: `layers` zijn de webservices die hij kan
			   bevragen, `map_layers` alles waar hij op kan werken, onder de namen die de
			   tools accepteren. */
			agent.state = {
				layers: refs,
				map_layers: labelLayers(map ? get(map.layers) : []).map(({ label, layer }) => ({
					name: label,
					type: layer.config.type,
					properties: layerProperties(layer)
				}))
			};

			push({ type: "question", text: question });

			/* De backend raadt de taal niet zelf, maar volgt de interface ("nl-NL" -> "nl"). */
			const language = get(locale)?.split("-")[0] ?? "en";
			await agent
				.runAgent({ tools: toAgUiTools(map), forwardedProps: { language }, abortController: abort }, subscriber)
				.catch(() => {
					/* al gemeld via onRunFailed */
				});

			/* Een aanroep zonder resultaat (de run brak af) blijft anders eeuwig "bezig". */
			const noResult = get(_)(abort.signal.aborted ? "tools.chat.toolSteps.stopped" : "tools.chat.toolSteps.noResult");
			events.update((list) =>
				list.map((e) => (e.type === "tool" && e.status === "pending" ? { ...e, status: "error", error: noResult } : e))
			);
			if (abort.signal.aborted) push({ type: "stopped" });
		} catch (error) {
			/* Inloggen of de lagen ophalen mislukte: dan is de vraag niet verstuurd. */
			console.error("Vraag niet verstuurd:", error);
			push({ type: "error", error: errorText(error) });
		} finally {
			runAbort = undefined;
			busy.set(false);
		}
	}

	/* De backend merkt de verbroken verbinding en stopt na de stap waar hij mee bezig is. */
	function stop() {
		runAbort?.abort();
	}

	async function exportCurrent(reason: string) {
		const apiUrl = get(chatApiUrl);
		if (!apiUrl || !get(userKey)) return;
		await exportConversation(apiUrl, get(userKey), conversationId, reason);
	}

	return {
		events,
		busy,
		totalTokens,
		userKey,
		ask,
		stop,
		applyUi,
		choose,
		dismissUi,
		alwaysApplyUi,
		exportConversation: exportCurrent
	};
}

/* Leia's WFS- en WMS-lagen als WebserviceLayerRef (backend/app/main.py). Alleen WFS
   krijgt attribuutnamen: WMS kent geen DescribeFeatureType. */
async function webserviceRefs(map: Map | undefined) {
	const layers = map ? get(map.layers) : [];
	return Promise.all(
		layers
			.filter((layer) => ["wfs", "wms"].includes(layer.config.type))
			.map(async ({ config: { type, title, settings } }) => {
				/* WMS-lagen hebben geen `options`. */
				const options = type === "wfs" ? settings.options : undefined;
				const ref = {
					service_endpoint: settings.url,
					layer_name: type === "wms" ? settings.featureName : (options?.featureType ?? settings.featureType),
					layer_label: title,
					service_type: type,
					service_version: options?.version ?? settings.version
				};
				if (type === "wms") return ref;
				const { service_endpoint, layer_name, service_version } = ref;
				return {
					...ref,
					attribute_names: await getWfsAttributeNames(service_endpoint, layer_name, service_version)
				};
			})
	);
}
