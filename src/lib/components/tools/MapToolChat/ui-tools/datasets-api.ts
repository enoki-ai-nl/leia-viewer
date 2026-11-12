import type { MvtProperty } from "$lib/map-cesium/layers/mvt-layer";

/* De dataset-endpoints van de API waar de assistent mee praat (zie ApiContext): wat een laag van
   een dataset nodig heeft (tileinfo, kleurklassen) en een dataset verwijderen. De tiles zelf
   haalt MvtImageryProvider op, met de sleutel in de headers. */

export interface ApiContext {
	apiUrl: string;
	userKey: string;
}

export interface TileInfo {
	id: string;
	name: string;
	/* URL-sjabloon met {z}/{x}/{y}, relatief aan de API, zonder sleutel: die gaat in de headers. */
	tile_path: string;
	source_layer: string;
	geometry_type: string | null;
	extent: [number, number, number, number] | null;
	feature_count: number;
	properties: (MvtProperty & { non_null: number })[];
}

export const authHeaders = ({ userKey }: ApiContext) => ({ Authorization: `Bearer ${userKey}` });

async function getJson<T>(api: ApiContext, path: string): Promise<T> {
	const response = await fetch(`${api.apiUrl}${path}`, { headers: authHeaders(api) });
	if (!response.ok) {
		/* De API legt een geweigerd verzoek uit in `detail`. */
		const body = await response.json().catch(() => null);
		throw new Error(typeof body?.detail === "string" ? body.detail : `Verzoek mislukt: ${response.status}`);
	}
	return response.json() as Promise<T>;
}

export const fetchTileInfo = (api: ApiContext, datasetId: string) =>
	getJson<TileInfo>(api, `/datasets/${encodeURIComponent(datasetId)}/tileinfo`);

/* Wat een stijl over de héle dataset moet weten: een tile bevat alleen wat in beeld is. */
export type ClassesResponse =
	| { kind: "categorical"; values: { value: string; count: number }[] }
	| { kind: "graduated"; breaks: number[]; min: number; max: number };

export function fetchClasses(
	api: ApiContext,
	datasetId: string,
	property: string,
	kind: "categorical" | "graduated",
	classes?: number
) {
	const query = new URLSearchParams({ property, kind });
	if (classes !== undefined) query.set("classes", String(classes));
	return getJson<ClassesResponse>(api, `/datasets/${encodeURIComponent(datasetId)}/classes?${query}`);
}

/* Verwijdert een dataset van de gebruiker voorgoed van de server (werkitem #53). Afgeleide lagen
   die ervan gemaakt zijn blijven bestaan (de server zet ze eerst om naar tabellen); hun namen
   komen terug in `converted`. */
export async function deleteDataset(api: ApiContext, datasetId: string): Promise<string[]> {
	const response = await fetch(`${api.apiUrl}/delete/${encodeURIComponent(datasetId)}`, {
		method: "DELETE",
		headers: authHeaders(api)
	});
	if (!response.ok) {
		const body = await response.json().catch(() => null);
		throw new Error(typeof body?.detail === "string" ? body.detail : `Verwijderen mislukt: ${response.status}`);
	}
	const body = await response.json().catch(() => ({}));
	return Array.isArray(body?.converted) ? body.converted : [];
}
