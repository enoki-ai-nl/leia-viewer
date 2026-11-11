import { LayerConfig } from "$lib/map-core/layer-config";
import { LayerConfigGroup } from "$lib/map-core/layer-config-group";

import { fetchTileInfo, authHeaders, type ApiContext, type TileInfo } from "../ui-tools/tiles-api";
import { getUserKey } from "../user-key";

import type { LayerLibrary } from "$lib/map-core/layer-library";

/* De datasets van Gaia als lagen in de laagbibliotheek: een groep met één laag per dataset
   van de ingelogde gebruiker, elk als GeoJSON-laag. */

export const GAIA_GROUP_ID = "gaia-datasets";
export const GAIA_GROUP_TITLE = "AI lagen";

interface DatasetSummary {
	id: string;
	display_name: string | null;
	original_filename: string;
	z: number;
}

/* De laagconfiguratie voor een dataset: de hele dataset als GeoJSON (WGS84), geladen zodra de
   laag voor het eerst zichtbaar wordt (zie CesiumLayer.ensureLoaded). Geen vector tiles: Cesium's
   MVTDataProvider (experimenteel in 1.146) legt punten niet op het terrein en maakt van
   ingewikkelde vlakken slierten en gaten. GeoJsonLayer legt alles met clampToGround op het
   terrein en blijft aanklikbaar en herkleurbaar. Nadeel: de hele laag komt in één keer. */
export function datasetGeoJsonConfig(
	api: ApiContext,
	info: TileInfo,
	options: { id: string; groupId: string; title?: string; defaultOn?: boolean; description?: string }
): LayerConfig {
	return new LayerConfig({
		id: options.id,
		title: options.title ?? info.name ?? info.id,
		description: options.description,
		type: "geojson",
		groupId: options.groupId,
		defaultOn: options.defaultOn ?? false,
		settings: {
			url: `${api.apiUrl}/get/${encodeURIComponent(info.id)}`,
			headers: () => authHeaders(api),
			datasetId: info.id
		}
	});
}

const GEOMETRY_NAMES: Record<string, string> = {
	point: "punten",
	multipoint: "punten",
	linestring: "lijnen",
	multilinestring: "lijnen",
	polygon: "vlakken",
	multipolygon: "vlakken"
};

function describeDataset(info: TileInfo): string {
	const kind = GEOMETRY_NAMES[(info.geometry_type ?? "").toLowerCase()];
	return `${info.feature_count.toLocaleString("nl-NL")} objecten${kind ? ` (${kind})` : ""}`;
}

/* Laadt de datasets van de API en zet ze als laag op de kaart (verborgen, de gebruiker
   zet ze aan), onder één groep in de bibliotheek. Een dataset die niet te laden is wordt
   overgeslagen en gelogd; de rest blijft werken. Roep dit één keer per API aan. */
export async function addGaiaLayers(library: LayerLibrary, apiUrl: string): Promise<number> {
	const api: ApiContext = { apiUrl, userKey: await getUserKey(apiUrl) };

	const response = await fetch(`${apiUrl}/datasets`, { headers: authHeaders(api) });
	if (!response.ok) throw new Error(`Datasets ophalen mislukt: ${response.status}`);
	const datasets: DatasetSummary[] = (await response.json()).datasets ?? [];

	const infos = await Promise.all(
		datasets.map(async (dataset) => {
			try {
				return { dataset, info: await fetchTileInfo(api, dataset.id) };
			} catch (error) {
				console.error(`Dataset '${dataset.display_name ?? dataset.id}' is niet beschikbaar als laag:`, error);
				return undefined;
			}
		})
	);
	const available = infos
		.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
		.sort((a, b) => (a.dataset.display_name ?? "").localeCompare(b.dataset.display_name ?? "", "nl"));
	if (available.length === 0) return 0;

	if (!library.findGroup(GAIA_GROUP_ID)) library.addLayerConfigGroup(new LayerConfigGroup(GAIA_GROUP_ID, GAIA_GROUP_TITLE));
	for (const { dataset, info } of available) {
		const id = `gaia-${dataset.id}`;
		if (library.findLayer(id)) continue;
		const options = {
			id,
			groupId: GAIA_GROUP_ID,
			title: dataset.display_name ?? dataset.original_filename,
			description: describeDataset(info)
		};
		/* Allemaal verborgen op de kaart, zodat elke laag de volledige laagbediening heeft;
		   de data komt pas als de gebruiker de laag aanzet. */
		const config = datasetGeoJsonConfig(api, info, options);
		library.addLayerConfig(config);
		config.added.set(true);
	}
	return available.length;
}
