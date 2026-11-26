/* Het resultaat van een backend-tool (een "artifact") als tabel: SQL-rijen,
   GeoJSON-features of zoekresultaten. */

import type { ChatEvent } from "./chat-types";
import type { Bbox } from "./ui-tools/zoom";

export type Row = Record<string, unknown>;

/* Context-sleutel van de functie die de kaart naar een bbox laat vliegen (gezet in ChatPanel). */
export const ZOOM_CONTEXT = "chat-zoom-to-bbox";

/* Per rij de bbox [west, zuid, oost, noord] van zijn geometrie, of null: sql_db_query geeft ze
   mee voor een resultaat met een geometrie, zodat elke rij naar zijn plek kan zoomen. */
export function artifactBboxes(content: any): (Bbox | null)[] {
	return Array.isArray(content?.bboxes) ? content.bboxes : [];
}

export function artifactRows(content: any): Row[] {
	if (Array.isArray(content?.rows)) return content.rows;
	if (Array.isArray(content?.features)) return content.features.map((f: any) => f.properties ?? {});
	if (Array.isArray(content?.results)) return content.results;
	return [];
}

/* Alle kolommen die in minstens één rij voorkomen, in volgorde van opduiken. */
export const artifactColumns = (rows: Row[]) => [...new Set(rows.flatMap((row) => Object.keys(row)))];

/* Hoeveel resultaten er waren (de backend telt soms meer dan hij meestuurt) en waarvandaan. */
export function artifactSummary(content: any, rowCount: number): { count: number; source?: string } {
	return {
		count: content?.feature_count ?? rowCount,
		source: content?.queried_table ?? content?.type_name ?? content?.query
	};
}

export function formatCell(value: unknown): string {
	if (value === null || value === undefined) return "–";
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/* Eén tekstargument (meestal de SQL) los tonen, anders alles als JSON. */
export function argsPreview(args: unknown): string {
	if (typeof args === "string") return args;
	if (!args || typeof args !== "object") return "";
	const values = Object.values(args);
	return values.length === 1 && typeof values[0] === "string" ? values[0] : JSON.stringify(args, null, 2);
}

/* Wat een antwoord aanbiedt om naar te zoomen: de rijen met hun bbox, en de bbox om ze allemaal. */
export interface ZoomTarget {
	rows: Row[];
	bboxes: (Bbox | null)[];
	bbox: Bbox;
	count: number;
}

/* De bbox om alle gegeven bboxen heen, of null als er geen zijn. */
export function unionBbox(bboxes: (Bbox | null)[]): Bbox | null {
	const boxes = bboxes.filter((b): b is Bbox => b !== null);
	if (boxes.length === 0) return null;
	return [
		Math.min(...boxes.map((b) => b[0])),
		Math.min(...boxes.map((b) => b[1])),
		Math.max(...boxes.map((b) => b[2])),
		Math.max(...boxes.map((b) => b[3]))
	];
}

/* Per beurt (vanaf een vraag tot de volgende): onder het laatste antwoord een zoomknop, als de
   laatste sql_db_query van die beurt plekken opleverde. Alleen de laatste: eerdere queries in
   dezelfde beurt zijn vaak verkennend (een telling, een controle van de waarden). Niet voor de
   beurt die nog loopt. Geeft per index in `events` het doel. */
export function zoomTargets(events: ChatEvent[], busy: boolean): Record<number, ZoomTarget> {
	const targets: Record<number, ZoomTarget> = {};
	let lastAnswer = -1;
	let result: { rows: Row[]; bboxes: (Bbox | null)[] } | null = null;

	const close = () => {
		const bbox = result ? unionBbox(result.bboxes) : null;
		if (lastAnswer >= 0 && result && bbox)
			targets[lastAnswer] = { ...result, bbox, count: result.bboxes.filter(Boolean).length };
		lastAnswer = -1;
		result = null;
	};

	events.forEach((event, i) => {
		if (event.type === "question") close();
		else if (event.type === "answer") lastAnswer = i;
		else if (event.type === "tool" && event.tool === "sql_db_query" && event.status === "done") {
			const bboxes = artifactBboxes(event.content);
			if (bboxes.some(Boolean)) result = { rows: artifactRows(event.content), bboxes };
		}
	});
	if (!busy) close();
	return targets;
}
