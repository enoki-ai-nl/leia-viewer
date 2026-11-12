import { LayerConfig } from "$lib/map-core/layer-config";
import { LayerConfigGroup } from "$lib/map-core/layer-config-group";

import { deleteDataset, fetchClasses, fetchTileInfo, authHeaders, type ApiContext, type TileInfo } from "../ui-tools/datasets-api";
import { categoricalFromValues, graduatedFromBreaks } from "../ui-tools/styles";
import { getUserKey } from "../user-key";

import type { LayerLibrary } from "$lib/map-core/layer-library";
import { isSessionLayer, type SessionLayer } from "$lib/map-core/session-layer";
import { get } from "svelte/store";

/* De datasets van Gaia als lagen in de laagbibliotheek: een groep met één laag per dataset
   van de ingelogde gebruiker, elk als vector tiles (MVT), zodat ook grote datasets snel zijn,
   op eigenschap te kleuren en aan te klikken. */

export const GAIA_GROUP_ID = "gaia-datasets";
export const GAIA_GROUP_TITLE = "AI lagen";

interface DatasetSummary {
	id: string;
	display_name: string | null;
	original_filename: string;
	z: number;
}

/* De laagconfiguratie voor een dataset: vector tiles van de API, getekend door MvtLayer
   (OpenLayers op een canvas, als afbeeldingslaag in Cesium). De sleutel van de gebruiker gaat
   in de headers van elk tile-verzoek; `headers` is een functie, zodat hij niet in de zichtbare
   laaginstellingen komt te staan. `classes` geeft de kleurklassen over de héle dataset: een tile
   bevat alleen wat in beeld is. */
export function datasetMvtConfig(
	api: ApiContext,
	info: TileInfo,
	options: { id: string; groupId: string; title?: string; defaultOn?: boolean; description?: string }
): LayerConfig {
	return new LayerConfig({
		id: options.id,
		title: options.title ?? info.name ?? info.id,
		description: options.description,
		type: "mvt",
		groupId: options.groupId,
		defaultOn: options.defaultOn ?? false,
		settings: {
			url: api.apiUrl + info.tile_path,
			headers: () => authHeaders(api),
			extent: info.extent ?? undefined,
			geometryType: info.geometry_type,
			properties: info.properties.map(({ name, kind }) => ({ name, kind })),
			classes: async (property: string, kind: "number" | "text") => {
				const classes = await fetchClasses(api, info.id, property, kind === "number" ? "graduated" : "categorical");
				return classes.kind === "categorical"
					? categoricalFromValues(property, classes.values.map((v) => v.value))
					: graduatedFromBreaks(property, classes.breaks);
			},
			/* Een laag uit de sessie van de gebruiker (map-core/session-layer.ts): alleen tonen of
			   verbergen, of voorgoed van de server verwijderen. */
			session: {
				datasetId: info.id,
				delete: async (library: LayerLibrary) => {
					const converted = await deleteDataset(api, info.id);
					for (const config of datasetConfigs(library, info.id)) library.removeLayerConfig(config);
					return converted;
				}
			} satisfies SessionLayer,
			datasetId: info.id
		}
	});
}

/* De id van de laag van een dataset: dezelfde voor de lijst en voor add_layer, zodat een
   dataset er nooit twee keer in staat. */
export const sessionLayerId = (datasetId: string) => `gaia-${datasetId}`;

/* Alle laagconfiguraties in de bibliotheek die deze dataset tonen: die onder "Ingeladen lagen"
   en een die de assistent er los bij zette. */
export function datasetConfigs(library: LayerLibrary, datasetId?: string): LayerConfig[] {
	const found: LayerConfig[] = [];
	const walk = (groups: LayerConfigGroup[]) => {
		for (const group of groups) {
			for (const config of get(group.layerConfigs)) {
				const id = config.settings?.datasetId;
				if (id !== undefined && (datasetId === undefined || id === datasetId)) found.push(config);
			}
			walk(get(group.childGroups));
		}
	};
	walk(get(library.groups));
	return found;
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
   overgeslagen en gelogd; de rest blijft werken. Opnieuw aanroepen voegt alleen nieuwe
   datasets toe (zie datasetsChanged). Geeft het aantal toegevoegde lagen terug. */
export async function addGaiaLayers(library: LayerLibrary, apiUrl: string): Promise<number> {
	const api: ApiContext = { apiUrl, userKey: await getUserKey(apiUrl) };

	const response = await fetch(`${apiUrl}/datasets`, { headers: authHeaders(api) });
	if (!response.ok) throw new Error(`Datasets ophalen mislukt: ${response.status}`);
	const all: DatasetSummary[] = (await response.json()).datasets ?? [];

	/* Wat de server niet meer heeft (de agent verving een laag door een nieuwe met dezelfde
	   naam): weg uit de lijst, anders blijft er een laag zonder data staan. */
	const ids = new Set(all.map((dataset) => dataset.id));
	for (const config of datasetConfigs(library)) {
		if (isSessionLayer(config) && !ids.has(config.settings.datasetId)) library.removeLayerConfig(config);
	}

	/* Alleen wat nog niet in de bibliotheek staat: tileinfo telt de data, en dit wordt opnieuw
	   aangeroepen als de agent een dataset heeft toegevoegd. */
	const datasets: DatasetSummary[] = all.filter(
		(dataset: DatasetSummary) => !library.findLayer(`gaia-${dataset.id}`)
	);

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
		const id = sessionLayerId(dataset.id);
		if (library.findLayer(id)) continue;
		const options = {
			id,
			groupId: GAIA_GROUP_ID,
			title: dataset.display_name ?? dataset.original_filename,
			description: describeDataset(info)
		};
		/* Allemaal verborgen op de kaart, zodat elke laag de volledige laagbediening heeft;
		   de data komt pas als de gebruiker de laag aanzet. */
		const config = datasetMvtConfig(api, info, options);
		library.addLayerConfig(config);
		config.added.set(true);
	}
	return available.length;
}
