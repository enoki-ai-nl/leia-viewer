import type { MvtProperty } from "$lib/map-cesium/layers/mvt-layer";

/* De tile-endpoints van de API waar de assistent mee praat (zie ApiContext). De tiles zelf
   haalt Cesium op; hier staat al het andere. */

export interface ApiContext {
	apiUrl: string;
	userKey: string;
}

export interface TileInfo {
	id: string;
	name: string;
	/* URL-sjabloon (met {z}/{x}/{y}) mét een eigen toegangstoken. Cesium bouwt elk tile-adres
	   alleen uit het sjabloon en kan geen headers meesturen, dus het token zit in de URL: een
	   ondertekend, alleen-lezen token voor déze dataset dat verloopt - nooit de sleutel van de gebruiker. */
	tile_path: string;
	access_expires: number; /* unix-tijd waarop het token verloopt */
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
