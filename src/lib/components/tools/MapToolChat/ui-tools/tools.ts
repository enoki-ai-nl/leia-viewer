import { get } from "svelte/store";

import { LayerConfig } from "$lib/map-core/layer-config";
import { LayerConfigGroup } from "$lib/map-core/layer-config-group";

import { findLayer, isStylable, labelLayers, layerProperties, newId } from "./layers";
import { describeStyle, otherRuleColor } from "./styles";
import { zoomToBbox } from "./zoom";
import { fetchTileInfo } from "./datasets-api";
import { datasetConfigs, datasetMvtConfig, GAIA_GROUP_ID, GAIA_GROUP_TITLE, sessionLayerId } from "../GaiaLayers/gaia-layers";
import { isSessionLayer, sessionLayer } from "$lib/map-core/session-layer";

import type { Map } from "$lib/map-cesium/map";
import { MvtLayer } from "$lib/map-cesium/layers/mvt-layer";
import { parseCondition, type DataDrivenStyle, type LayerStyle } from "$lib/map-cesium/providers/mvt-style";
import type { LabelledLayer } from "./layers";
import type { UiTool, UiToolContext } from "./types";

/* De assistent stijlt alleen MVT-lagen (de datasets van de gebruiker): op eigenschap kleuren
   (`color_layer_by_property`) en eigen kleuren (`set_layer_style`). GeoJSON-, WFS- en andere
   lagen laat hij zoals ze zijn. Omdat elke frontend zelf zijn tools aanmeldt, hoeft de
   backend daar niets van te weten. */

function asObject(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("De argumenten moeten een JSON-object zijn.");
	}
	return raw as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
	const value = obj[key];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`"${key}" is verplicht en moet een niet-lege tekst zijn.`);
	}
	return value.trim();
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`"${key}" moet een tekst zijn.`);
	return value.trim() || undefined;
}

/* `layer_ref` mag alleen een van de lagen op de kaart zijn. */
const layerRefProperty = (layers: LabelledLayer[]) => ({
	type: "string",
	enum: layers.map(({ label }) => label),
	description: "Welke laag op de kaart. Moet exact een van de genoemde namen zijn."
});

interface LayerRefArgs {
	layerRef: string;
}

const parseLayerRef = (raw: unknown): LayerRefArgs => ({ layerRef: requireString(asObject(raw), "layer_ref") });

const layerRefParameters = (layers: LabelledLayer[]) => ({
	type: "object",
	properties: { layer_ref: layerRefProperty(layers) },
	required: ["layer_ref"]
});

interface AddLayerArgs {
	serviceType: "wfs" | "wms" | "dataset";
	url?: string;
	layerName: string;
	title?: string;
}

/* Een laag op de kaart. Een dataset uit de database hoort bij de "Ingeladen lagen" (zie
   addDatasetLayer); een webservice (WFS/WMS) niet: die staat alleen op de kaart, zonder groep,
   en de agent kan hem pas bevragen als hij hem met wfs_load_to_table inlaadt. */
const addLayer: UiTool<AddLayerArgs> = {
	name: "add_layer",
	description:
		"Add a layer to the user's map; the map zooms to it. service_type 'wfs' or 'wms': a web service, only to look at - use its url and " +
		"layer name exactly as the user gave them or as a dataset search returned them, never invent either; to " +
		"query or analyse it, load it with wfs_load_to_table instead. service_type 'dataset': one of the user's own " +
		"datasets (layer_name is its table name from AVAILABLE DATASETS, or the table you just loaded or created); " +
		"no url. Only call this when the user wants to see that data on the map.",
	defaultApproval: "ask",
	parameters: () => ({
		type: "object",
		properties: {
			service_type: { type: "string", enum: ["wfs", "wms", "dataset"] },
			url: { type: "string", description: "Base URL of the service (wfs and wms only)." },
			layer_name: {
				type: "string",
				description: "WFS type name / WMS layer name on that service; for a dataset: its table name."
			},
			title: { type: "string", description: "Optional name to show for the layer." }
		},
		required: ["service_type", "layer_name"]
	}),
	parse: (raw) => {
		const obj = asObject(raw);
		const serviceType = requireString(obj, "service_type");
		if (serviceType !== "wfs" && serviceType !== "wms" && serviceType !== "dataset") {
			throw new Error('"service_type" moet "wfs", "wms" of "dataset" zijn.');
		}
		const layerName = requireString(obj, "layer_name");
		const title = optionalString(obj, "title");
		if (serviceType === "dataset") return { serviceType, layerName, title };

		const url = requireString(obj, "url");
		try {
			if (!["https:", "http:"].includes(new URL(url).protocol)) throw new Error();
		} catch {
			throw new Error('"url" moet een http(s)-URL zijn.');
		}
		return { serviceType, url, layerName, title };
	},
	describe: (args) =>
		args.serviceType === "dataset"
			? `Toon de dataset "${args.title ?? args.layerName}" op de kaart`
			: `Voeg de ${args.serviceType.toUpperCase()}-laag "${args.title ?? args.layerName}" toe aan de kaart`,
	execute: async (args, context) => {
		const { map } = context;
		if (args.serviceType === "dataset") return addDatasetLayer(args, context);

		/* Dezelfde dienst + laag staat er al: niet dubbel toevoegen. */
		const existing = get(map.layers).find((layer) => {
			const settings = layer.config.settings ?? {};
			const name = layer.config.type === "wfs"
				? settings.options?.featureType ?? settings.featureType
				: settings.featureName;
			return layer.config.type === args.serviceType && settings.url === args.url && name === args.layerName;
		});
		if (existing) return `De laag "${existing.title}" staat al op de kaart.`;

		/* Zonder groep: de bibliotheek zet hem bij de lagen zonder categorie, niet bij de
		   "Ingeladen lagen" - hij staat niet in de database. */
		const config = new LayerConfig({
			id: newId(),
			title: args.title ?? args.layerName,
			type: args.serviceType,
			defaultOn: true,
			settings:
				args.serviceType === "wfs"
					? { url: args.url, featureType: args.layerName }
					: { url: args.url, featureName: args.layerName }
		});
		map.layerLibrary.addLayerConfig(config);
		config.added.set(true);

		/* De kaart meldt een mislukte laag zelf, maar zet dan alleen `added` terug. */
		const layer = map.getLayerById(config.id);
		if (!layer || !get(config.added)) {
			map.layerLibrary.removeLayerConfig(config);
			throw new Error(`Kon de laag "${args.layerName}" niet toevoegen: de dienst reageert niet zoals verwacht of kent de laag niet.`);
		}
		return `${args.serviceType.toUpperCase()}-laag "${layer.title}" is aan de kaart toegevoegd. ` +
			"Hij staat niet in de database: laad hem in met wfs_load_to_table om hem te bevragen.";
	}
};

/* Een dataset van de gebruiker op de kaart. Staat hij al in de lijst (verborgen), dan wordt
   hij zichtbaar; anders komt hij erbij, onder dezelfde id als in de lijst, zodat hij er niet
   twee keer in komt. Daarna vliegt de kaart ernaartoe. */
async function addDatasetLayer(args: AddLayerArgs, context: UiToolContext): Promise<string> {
	const { map } = context;
	const library = map.layerLibrary;
	let config = datasetConfigs(library, args.layerName)[0];

	let info: Awaited<ReturnType<typeof fetchTileInfo>> | undefined;
	if (!config) {
		info = await fetchTileInfo(context, args.layerName);
		if (!library.findGroup(GAIA_GROUP_ID)) {
			library.addLayerConfigGroup(new LayerConfigGroup(GAIA_GROUP_ID, GAIA_GROUP_TITLE));
		}
		config = datasetMvtConfig(context, info, {
			id: sessionLayerId(info.id),
			groupId: GAIA_GROUP_ID,
			title: args.title,
			defaultOn: true
		});
		library.addLayerConfig(config);
	}
	config.added.set(true);

	const layer = map.getLayerById(config.id);
	if (!(layer instanceof MvtLayer)) {
		throw new Error(`Kon de dataset "${args.layerName}" niet als laag tonen.`);
	}
	layer.visible.set(true);
	if (config.cameraPosition) map.flyTo(config.cameraPosition);
	return `Dataset "${layer.title}" staat op de kaart${config.cameraPosition ? " en de kaart toont hem" : ""}.` + (info
		? ` (${info.feature_count} objecten). Eigenschappen om op te kleuren: ${
			info.properties.slice(0, 15).map((p) => `${p.name} (${p.kind})`).join(", ")
		}.`
		: "");
}

/* Alleen lagen met een bekende cameralocatie kunnen we aanvliegen - dezelfde regel
   als de zoomknop in de laagbeheerder. */
const flyTo: UiTool<LayerRefArgs> = {
	name: "fly_to",
	description: "Move the map view to show a layer.",
	defaultApproval: "auto",
	eligibleLayers: (layers) => layers.filter(({ layer }) => layer.getLayerPosition() !== undefined),
	parameters: layerRefParameters,
	parse: parseLayerRef,
	describe: (args) => `Vlieg naar de laag "${args.layerRef}"`,
	execute: async (args, { map }) => {
		const layer = findLayer(get(map.layers), args.layerRef);
		const position = layer.getLayerPosition();
		if (!position) throw new Error(`Van "${layer.title}" is geen locatie bekend om naartoe te vliegen.`);
		map.flyTo(position);
		return `De kaart vliegt naar "${layer.title}".`;
	}
};

interface SetVisibilityArgs extends LayerRefArgs {
	visible: boolean;
}

const setLayerVisibility: UiTool<SetVisibilityArgs> = {
	name: "set_layer_visibility",
	description: "Show or hide a layer that is on the map, without removing it.",
	defaultApproval: "auto",
	eligibleLayers: (layers) => layers,
	parameters: (layers) => ({
		type: "object",
		properties: { layer_ref: layerRefProperty(layers), visible: { type: "boolean" } },
		required: ["layer_ref", "visible"]
	}),
	parse: (raw) => {
		const obj = asObject(raw);
		if (typeof obj.visible !== "boolean") throw new Error('"visible" is verplicht en moet true of false zijn.');
		return { layerRef: requireString(obj, "layer_ref"), visible: obj.visible };
	},
	describe: (args) => `${args.visible ? "Toon" : "Verberg"} de laag "${args.layerRef}"`,
	execute: async (args, { map }) => {
		const layer = findLayer(get(map.layers), args.layerRef);
		layer.visible.set(args.visible);
		return `De laag "${layer.title}" is nu ${args.visible ? "zichtbaar" : "verborgen"}.`;
	}
};

const removeLayer: UiTool<LayerRefArgs> = {
	name: "remove_layer",
	description:
		"Take a layer off the map. Only when the user asks for it. Not for the user's own datasets (they stay in the " +
		"session: hide them with set_layer_visibility, or delete them for good with delete_dataset).",
	defaultApproval: "ask",
	/* Een laag uit de sessie gaat nooit alleen van de kaart (map-core/session-layer.ts). */
	eligibleLayers: (layers) => layers.filter(({ layer }) => !isSessionLayer(layer.config)),
	parameters: layerRefParameters,
	parse: parseLayerRef,
	describe: (args) => `Verwijder de laag "${args.layerRef}" van de kaart`,
	execute: async (args, { map }) => {
		const layer = findLayer(get(map.layers), args.layerRef);
		layer.remove();
		return `De laag "${layer.title}" is van de kaart verwijderd.`;
	}
};

interface ColorByPropertyArgs extends LayerRefArgs {
	property: string;
	/* Eigen klassen, elk met zijn voorwaarde ("> 20") en kleur; zonder deze kiest de API ze. */
	rules?: { condition: string; color: string }[];
	/* De omlijning van alle objecten, in dezelfde stap ("groen met een zwarte rand"). */
	strokeColor?: string;
	/* Bij rules: de kleur voor wat geen regel raakt ("de rest rood"). */
	otherColor?: string;
}

const MAX_RULES = 6;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function parseRules(obj: Record<string, unknown>): ColorByPropertyArgs["rules"] {
	const raw = obj["rules"];
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RULES) {
		throw new Error(`"rules" moet een lijst van 1 tot ${MAX_RULES} regels zijn.`);
	}
	return raw.map((item, i) => {
		const entry = asObject(item);
		const condition = requireString(entry, "condition");
		const color = requireString(entry, "color");
		if (!HEX_COLOR.test(color)) throw new Error(`De kleur van klasse ${i + 1} moet de vorm #rrggbb hebben.`);
		parseCondition(condition, color);   // gooit met een uitleg als hij niet te lezen is
		return { condition, color };
	});
}

const colorLayerByProperty: UiTool<ColorByPropertyArgs> = {
	name: "color_layer_by_property",
	description:
		"Colour a layer's features by one of their properties, so features with different values get different " +
		"colours (e.g. \"colour the areas by type\"). `property` must be one of the layer's properties as listed " +
		"for that layer - never invent one. Without `rules` the app picks the colours: a number property gets a " +
		"gradient over its range, a text property one colour per value. Only some layers can be coloured this way.\n" +
		"For a number property you can give the classes yourself in `rules`: each one a condition in the user's own " +
		"terms and the colour for it. Conditions: \"> 20\", \">= 20\", \"< 5\", \"<= 5\", \"= 3\", \"between 5 and 20\" " +
		"(both ends included). \"More than 20\" is \"> 20\", \"20 or more\" is \">= 20\". The first class whose condition " +
		"holds gives the colour. Features that match no rule, or have no value, get `other_color` when the user names " +
		"one (\"the rest red\"); otherwise they keep the layer's own colour, or grey when that looks like a rule colour. " +
		"Example, \"colour the counts above 20 green with a black outline\": rules [{\"condition\": \"> 20\", " +
		"\"color\": \"#00ff00\"}], stroke_color \"#000000\".",
	defaultApproval: "auto",
	eligibleLayers: (layers) => layers.filter(({ layer }) => isStylable(layer)),
	parameters: (layers) => ({
		type: "object",
		properties: {
			layer_ref: layerRefProperty(layers),
			property: { type: "string", description: "The property whose values decide the colour." },
			rules: {
				type: "array",
				maxItems: MAX_RULES,
				items: {
					type: "object",
					properties: {
						condition: { type: "string", description: "e.g. \"> 20\", \">= 20\", \"< 5\", \"between 5 and 20\"." },
						color: { type: "string", description: "The colour for features meeting the condition, as #rrggbb." }
					},
					required: ["condition", "color"]
				},
				description: "Optional, number properties only: your own classes, each with its condition and colour."
			},
			other_color: {
				type: "string",
				description: "Optional, with rules only: the colour, as #rrggbb, for features that match no rule. " +
					"Only when the user names one."
			},
			stroke_color: {
				type: "string",
				description: "Optional: the outline colour of all features (polygons and points), as #rrggbb."
			}
		},
		required: ["layer_ref", "property"]
	}),
	parse: (raw) => {
		const obj = asObject(raw);
		const strokeColor = optionalString(obj, "stroke_color");
		if (strokeColor !== undefined && !HEX_COLOR.test(strokeColor)) throw new Error('"stroke_color" moet de vorm #rrggbb hebben.');
		const rules = parseRules(obj);
		const otherColor = optionalString(obj, "other_color");
		if (otherColor !== undefined && !HEX_COLOR.test(otherColor)) throw new Error('"other_color" moet de vorm #rrggbb hebben.');
		if (otherColor !== undefined && !rules) throw new Error('"other_color" hoort alleen bij "rules".');
		return {
			layerRef: requireString(obj, "layer_ref"),
			property: requireString(obj, "property"),
			rules,
			strokeColor,
			otherColor
		};
	},
	describe: (args) =>
		`Kleur de laag "${args.layerRef}" op basis van "${args.property}"` +
		(args.rules ? `: ${args.rules.map((c) => `${c.condition} ${c.color}`).join(", ")}` : "") +
		(args.otherColor ? `, overige ${args.otherColor}` : "") +
		(args.strokeColor ? `, omlijning ${args.strokeColor}` : ""),
	execute: async (args, context) => {
		const layer = findLayer(get(context.map.layers), args.layerRef);
		if (!isStylable(layer)) {
			throw new Error(`"${layer.title}" kan niet op eigenschap gekleurd worden (alleen MVT-lagen).`);
		}
		const available = layerProperties(layer);
		const property = available.find((p) => p.name === args.property);
		if (!property) {
			throw new Error(
				`"${layer.title}" heeft geen eigenschap "${args.property}". Eigenschappen: ${
					available.map((p) => `${p.name} (${p.kind})`).join(", ")
				}.`
			);
		}

		let style: DataDrivenStyle | undefined;
		if (args.rules) {
			if (property.kind !== "number") {
				throw new Error(`"${property.name}" is geen getal; eigen klassen gaan alleen bij getallen.`);
			}
			/* Voor wat geen regel raakt of geen waarde heeft: de gevraagde kleur, anders de eigen
			   kleur van de laag (vulling, of bij lijnen de lijnkleur), of grijs als die op een
			   regelkleur lijkt. */
			const base = get(layer.style);
			const own = geometryKind(layer) === "line" ? base.strokeColor : base.fillColor;
			style = {
				property: property.name,
				kind: "rules",
				rules: args.rules.map((c) => parseCondition(c.condition, c.color)),
				fallbackColor: otherRuleColor(own, args.rules.map((c) => c.color), args.otherColor)
			};
			layer.setDataDrivenStyle(style);
		} else {
			/* Een MVT-laag heeft de objecten niet in de browser (een tile bevat alleen wat in beeld
			   is): de klassen komen van de API, want die ziet de hele dataset. */
			style = await layer.colorBy(property.name);
		}

		/* De omlijning in dezelfde stap; MvtLayer bouwt de laag daarna één keer opnieuw op. */
		const kind = geometryKind(layer);
		let outline = "";
		if (args.strokeColor && kind !== "line") {
			layer.setStyle(kind === "point" ? { pointStrokeColor: args.strokeColor } : { strokeColor: args.strokeColor });
			outline = ` Omlijning: ${args.strokeColor}.`;
		} else if (args.strokeColor) {
			outline = " (stroke_color genegeerd: bij lijnen is de lijnkleur de kleuring zelf.)";
		}
		return `"${layer.title}" is gekleurd op "${property.name}". ${style ? describeStyle(style) : ""}.${outline}`;
	}
};

interface SetStyleArgs extends LayerRefArgs {
	fillColor?: string;
	strokeColor?: string;
}

function optionalColor(obj: Record<string, unknown>, key: string): string | undefined {
	const value = optionalString(obj, key);
	if (value !== undefined && !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`"${key}" moet de vorm #rrggbb hebben.`);
	return value;
}

/* Wat voor objecten een MVT-laag tekent; undefined als dat niet bekend is. */
function geometryKind(layer: MvtLayer): "point" | "line" | "polygon" | undefined {
	const type = String(layer.config.settings["geometryType"] ?? "");
	if (type.endsWith("Point")) return "point";
	if (type.endsWith("LineString")) return "line";
	if (type.endsWith("Polygon")) return "polygon";
	return undefined;
}

const setLayerStyle: UiTool<SetStyleArgs> = {
	name: "set_layer_style",
	description:
		"Give ALL features of a layer the same colours (e.g. \"make the provinces yellow with a black outline\"). " +
		"fill_color is the colour of polygons and points; stroke_color is the outline of polygons and points, " +
		"and the colour of lines. Give at least one; what you leave out stays as it is. " +
		"If the user wants colours that differ per feature or value, use color_layer_by_property instead.",
	defaultApproval: "auto",
	/* Alleen MVT-lagen: dat zijn de datasets van de gebruiker, en alleen die kleurt de assistent. */
	eligibleLayers: (layers) => layers.filter(({ layer }) => layer instanceof MvtLayer),
	parameters: (layers) => ({
		type: "object",
		properties: {
			layer_ref: layerRefProperty(layers),
			fill_color: { type: "string", description: "Fill colour of polygons and points, as #rrggbb. Has no effect on lines." },
			stroke_color: { type: "string", description: "Outline colour of polygons and points, and the colour of lines, as #rrggbb." }
		},
		required: ["layer_ref"]
	}),
	parse: (raw) => {
		const obj = asObject(raw);
		const fillColor = optionalColor(obj, "fill_color");
		const strokeColor = optionalColor(obj, "stroke_color");
		if (!fillColor && !strokeColor) throw new Error('Geef "fill_color", "stroke_color" of allebei.');
		return { layerRef: requireString(obj, "layer_ref"), fillColor, strokeColor };
	},
	describe: (args) =>
		`Geef de laag "${args.layerRef}" ` +
		[args.fillColor && `vulling ${args.fillColor}`, args.strokeColor && `omlijning/lijn ${args.strokeColor}`]
			.filter(Boolean)
			.join(" en "),
	execute: async (args, { map }) => {
		const layer = findLayer(get(map.layers), args.layerRef);
		if (!(layer instanceof MvtLayer)) {
			throw new Error(`"${layer.title}" kan geen eigen kleuren krijgen (alleen MVT-lagen).`);
		}
		const kind = geometryKind(layer);
		if (kind === "line" && !args.strokeColor) {
			throw new Error(`"${layer.title}" is een lijnenlaag: lijnen hebben geen vulling, geef stroke_color.`);
		}

		/* Een punt heeft een eigen omlijning (pointStrokeColor); lijnen en vlakken strokeColor. */
		const patch: Partial<LayerStyle> = {};
		if (args.fillColor) patch.fillColor = args.fillColor;
		if (args.strokeColor) {
			if (kind === "point") patch.pointStrokeColor = args.strokeColor;
			else patch.strokeColor = args.strokeColor;
		}
		/* Een kleuring op eigenschap vervangt de hoofdkleur; die zetten maakt er een eind aan. */
		const replacesMainColor = kind === "line" ? Boolean(args.strokeColor) : Boolean(args.fillColor);
		if (replacesMainColor) layer.dataDriven.set(undefined);
		layer.setStyle(patch);   // bouwt de laag één keer opnieuw op

		const notes: string[] = [];
		if (kind === "line" && args.fillColor) notes.push("fill_color genegeerd: lijnen hebben geen vulling");

		const parts = [
			args.fillColor && kind !== "line" ? `vulling ${args.fillColor}` : "",
			args.strokeColor ? `${kind === "line" ? "lijnkleur" : "omlijning"} ${args.strokeColor}` : ""
		].filter(Boolean);
		return `"${layer.title}" heeft nu ${parts.join(" en ")} voor alle objecten${notes.length ? ` (${notes.join("; ")})` : ""}.`;
	}
};

/* --- delete_dataset -----------------------------------------------------------------
   Een dataset van de gebruiker voorgoed van de server (werkitem #53). Loopt via de viewer, en
   vraagt standaard om akkoord: verwijderen kan niet ongedaan. Afgeleide lagen die ervan gemaakt
   zijn blijven bestaan (de server zet ze eerst om naar tabellen). */

const deleteDatasetTool: UiTool<LayerRefArgs> = {
	name: "delete_dataset",
	description:
		"Permanently delete one of the user's own datasets (a loaded or derived layer) from the server: the data is " +
		"gone, this cannot be undone. Only when the user clearly asks to delete it. If they may only want it out of " +
		"sight, hide it with set_layer_visibility; if unclear, ask first. Layers derived from this dataset stay available.",
	defaultApproval: "ask",
	eligibleLayers: (layers) => layers.filter(({ layer }) => isSessionLayer(layer.config)),
	parameters: layerRefParameters,
	parse: parseLayerRef,
	describe: (args) => `Verwijder de dataset "${args.layerRef}" voorgoed van de server`,
	execute: async (args, { map }) => {
		const layer = findLayer(get(map.layers), args.layerRef);
		const session = sessionLayer(layer.config);
		if (!session) throw new Error(`"${layer.title}" is geen dataset van de gebruiker en kan niet verwijderd worden.`);
		const converted = await session.delete(map.layerLibrary);
		return `De dataset "${layer.title}" is van de server verwijderd.` +
			(converted.length ? ` Deze lagen waren ervan gemaakt en blijven bestaan, nu als losse kopie: ${converted.join(", ")}.` : "");
	}
};

/* --- zoom_to_location -------------------------------------------------------------
   Naar een plek op de kaart, met de coördinaten die geocode_location (PDOK Locatieserver,
   backend/app/src/services/geocoding.py) teruggaf: een gebied naar zijn bounding box, een
   punt (adres) op straatniveau. fly_to werkt alleen op lagen. */

interface ZoomArgs {
	lon: number;
	lat: number;
	bbox?: [number, number, number, number];
	name?: string;
}

function finiteNumber(obj: Record<string, unknown>, key: string): number {
	const value = typeof obj[key] === "string" ? Number(obj[key]) : obj[key];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`"${key}" moet een getal zijn.`);
	return value;
}

const zoomToLocation: UiTool<ZoomArgs> = {
	name: "zoom_to_location",
	description:
		"Move the map view to a place, address or area. Use the lon, lat and bbox exactly as geocode_location returned " +
		"them - never guess coordinates. With a bbox the whole area is shown; without one (an address), the street level.",
	defaultApproval: "auto",
	parameters: () => ({
		type: "object",
		properties: {
			lon: { type: "number", description: "Longitude, WGS84 (EPSG:4326)." },
			lat: { type: "number", description: "Latitude, WGS84 (EPSG:4326)." },
			bbox: {
				type: "array",
				items: { type: "number" },
				minItems: 4,
				maxItems: 4,
				description: "Optional [west, south, east, north] in WGS84, for an area."
			},
			name: { type: "string", description: "Optional name of the place, to show the user." }
		},
		required: ["lon", "lat"]
	}),
	parse: (raw) => {
		const obj = asObject(raw);
		const lon = finiteNumber(obj, "lon");
		const lat = finiteNumber(obj, "lat");
		if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new Error('"lon"/"lat" liggen buiten de wereld; geef WGS84-graden.');
		let bbox: ZoomArgs["bbox"];
		if (obj.bbox !== undefined && obj.bbox !== null) {
			const b = obj.bbox;
			if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === "number" && Number.isFinite(v))) {
				throw new Error('"bbox" moet [west, zuid, oost, noord] in graden zijn.');
			}
			const [w, s, e, n] = b as number[];
			if (!(w <= e && s <= n && w >= -180 && e <= 180 && s >= -90 && n <= 90)) {
				throw new Error('"bbox" moet [west, zuid, oost, noord] in graden zijn, west <= oost en zuid <= noord.');
			}
			bbox = [w, s, e, n];
		}
		return { lon, lat, bbox, name: optionalString(obj, "name") };
	},
	describe: (args) => `Ga naar ${args.name ? `"${args.name}"` : `${args.lat.toFixed(4)}, ${args.lon.toFixed(4)}`}`,
	execute: async (args, { map }) => {
		zoomToBbox(map, args.bbox ?? [args.lon, args.lat, args.lon, args.lat]);
		return `De kaart toont nu ${args.name ?? `${args.lat}, ${args.lon}`}.`;
	}
};

/* --- ask_clarifying_questions ------------------------------------------------------- */

/* Vervolgvragen met keuzeknoppen (werkitem #55), met een aanbevolen keuze (#56).

   Is een vraag dubbelzinnig ("Oosterland" ligt in Zeeland én in Noord-Holland), dan vraagt de
   agent door in plaats van zelf te kiezen. De viewer toont de vragen met knoppen; de keuze gaat
   terug als resultaat van deze tool, samen met een nieuw bericht van de gebruiker (zie
   chat-session). De gebruiker kan ook zelf een antwoord typen. Hooguit 3 vragen per beurt en 3
   knoppen per vraag; geen maximum op het aantal rondes.

   Een optie kan aanbevolen zijn, met een reden. De aanbevolen knop is de knop waar iemand zonder
   nadenken op klikt, dus de agent mag alleen iets aanbevelen met een concrete grond (wat in het
   kaartbeeld of op de kaart staat, of een eerder antwoord), en moet die grond noemen. */

export const MAX_QUESTIONS = 3;
export const MAX_OPTIONS = 3;

export interface ChoiceOption {
	label: string;
	recommended: boolean;
	/* Waarom deze optie aanbevolen is; alleen bij een aanbevolen optie. */
	reason?: string;
}

export interface ChoiceQuestion {
	question: string;
	options: ChoiceOption[];
}

export interface AskArgs {
	questions: ChoiceQuestion[];
}

function text(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} moet een niet-lege tekst zijn.`);
	return value.trim();
}

function parseOption(raw: unknown, q: number, o: number): ChoiceOption {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`Optie ${o + 1} van vraag ${q + 1} moet een object zijn met een "label".`);
	}
	const obj = raw as Record<string, unknown>;
	/* Een aanbeveling die niet klopt, laat de vraag zelf niet mislukken: de vraag is waar het om
	   gaat. Een reden zonder aanbeveling vervalt; een aanbeveling zonder reden ook, want de
	   gebruiker moet kunnen zien waarop ze gebaseerd is. */
	const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : undefined;
	const recommended = obj.recommended === true && reason !== undefined;
	return {
		label: text(obj.label, `Het label van optie ${o + 1} van vraag ${q + 1}`),
		recommended,
		reason: recommended ? reason : undefined
	};
}

export function parseAsk(raw: unknown): AskArgs {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("De argumenten moeten een JSON-object zijn.");
	}
	const questions = (raw as Record<string, unknown>).questions;
	if (!Array.isArray(questions) || questions.length < 1 || questions.length > MAX_QUESTIONS) {
		throw new Error(`"questions" moet 1 tot ${MAX_QUESTIONS} vragen bevatten.`);
	}
	return {
		questions: questions.map((rawQuestion, q) => {
			if (typeof rawQuestion !== "object" || rawQuestion === null || Array.isArray(rawQuestion)) {
				throw new Error(`Vraag ${q + 1} moet een object zijn met "question" en "options".`);
			}
			const obj = rawQuestion as Record<string, unknown>;
			const options = obj.options;
			if (!Array.isArray(options) || options.length < 2 || options.length > MAX_OPTIONS) {
				throw new Error(`Vraag ${q + 1} moet 2 tot ${MAX_OPTIONS} opties hebben.`);
			}
			let parsed = options.map((option, o) => parseOption(option, q, o));
			/* Meer dan één aanbevolen optie is geen aanbeveling: dan geen. */
			if (parsed.filter((option) => option.recommended).length > 1) {
				parsed = parsed.map((option) => ({ ...option, recommended: false, reason: undefined }));
			}
			const labels = parsed.map((option) => option.label.toLowerCase());
			if (new Set(labels).size !== labels.length) throw new Error(`Vraag ${q + 1} heeft twee opties met hetzelfde label.`);
			return { question: text(obj.question, `De tekst van vraag ${q + 1}`), options: parsed };
		})
	};
}

/* Wat de agent te horen krijgt als de gebruiker op knoppen heeft geklikt. */
export function describeAnswers(args: AskArgs, answers: number[]): string {
	return (
		"The user answered by clicking: " +
		args.questions
			.map(({ question, options }, i) => {
				const option = options[answers[i]];
				return `"${question}" -> "${option.label}"${option.recommended ? " (the option you recommended)" : ""}`;
			})
			.join("; ") +
		"."
	);
}

/* Wat de agent te horen krijgt als de gebruiker niet klikte maar zelf typte. */
export const ANSWERED_IN_OWN_WORDS =
	"The user did not click an option; they answered in their own words in their next message.";

export const askClarifyingQuestions: UiTool<AskArgs> = {
	name: "ask_clarifying_questions",
	interactive: true,
	description:
		"Ask the user one to three follow-up questions with answer buttons when their request is ambiguous and the " +
		"answer would change what you do (e.g. \"Oosterland\" exists in Zeeland and in Noord-Holland; \"combine A and B\" " +
		"can mean different results). Do this instead of picking one interpretation yourself. Ask only what you need; " +
		`at most ${MAX_QUESTIONS} questions, each with 2 to ${MAX_OPTIONS} short, clearly different options. The user ` +
		"may also type their own answer instead. Call this tool alone, then wait: the answer comes in the next turn. " +
		"Use it for EVERY question to the user, also when you want to ask something after looking things up: never " +
		"write the question or its options in your text while this tool is available.\n" +
		"You may mark at most one option per question as recommended, ONLY when there is a concrete reason in this " +
		"conversation - what is on the user's map or in their map view, or what they said before - and then give that " +
		"reason (e.g. \"lies in your current map view\"). Which option is more common, more likely or better known is " +
		"NOT a reason: then recommend nothing. Users tend to click the recommended option without thinking.",
	defaultApproval: "auto",
	parameters: () => ({
		type: "object",
		properties: {
			questions: {
				type: "array",
				minItems: 1,
				maxItems: MAX_QUESTIONS,
				items: {
					type: "object",
					properties: {
						question: { type: "string", description: "The question, short, in the user's language." },
						options: {
							type: "array",
							minItems: 2,
							maxItems: MAX_OPTIONS,
							items: {
								type: "object",
								properties: {
									label: { type: "string", description: "The answer as it appears on the button; a few words." },
									recommended: { type: "boolean", description: "At most one option per question; only with a concrete reason." },
									reason: { type: "string", description: "Required when recommended: why, in a few words, in the user's language." }
								},
								required: ["label"]
							}
						}
					},
					required: ["question", "options"]
				}
			}
		},
		required: ["questions"]
	}),
	parse: parseAsk,
	describe: (args) => args.questions.map((q) => q.question).join(" / "),
	/* Wordt niet uitgevoerd: de chat toont de vragen en wacht op de gebruiker (zie chat-session). */
	execute: async () => {
		throw new Error("ask_clarifying_questions wacht op de gebruiker en wordt niet uitgevoerd.");
	}
};

/* Op `UiTool<unknown>` gezet aan de rand van de lijst: aanroepers gaan altijd eerst
   langs tool.parse, en dat maakt het argumenttype betrouwbaar. */
export const UI_TOOLS = [addLayer, flyTo, setLayerVisibility, colorLayerByProperty, setLayerStyle, removeLayer, deleteDatasetTool, zoomToLocation, askClarifyingQuestions] as unknown as UiTool<unknown>[];

export function getUiTool(name: string): UiTool<unknown> | undefined {
	return UI_TOOLS.find((tool) => tool.name === name);
}

/* De tools zoals AG-UI RunAgentInput.tools ze wil, voor de lagen op de kaart nu. */
export function toAgUiTools(map: Map | undefined) {
	const layers = labelLayers(map ? get(map.layers) : []);
	return UI_TOOLS.flatMap((tool) => {
		const eligible = tool.eligibleLayers ? tool.eligibleLayers(layers) : [];
		if (tool.eligibleLayers && eligible.length === 0) return [];
		return [{ name: tool.name, description: tool.description, parameters: tool.parameters(eligible) }];
	});
}
