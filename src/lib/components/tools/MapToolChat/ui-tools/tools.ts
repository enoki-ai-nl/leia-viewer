import { get } from "svelte/store";

import { LayerConfig } from "$lib/map-core/layer-config";
import { LayerConfigGroup } from "$lib/map-core/layer-config-group";

import { findLayer, isStylable, labelLayers, layerProperties, newId } from "./layers";
import { describeStyle, graduatedFromBreaks } from "./styles";
import { fetchTileInfo } from "./tiles-api";
import { datasetMvtConfig, GAIA_GROUP_ID } from "../GaiaLayers/gaia-layers";

import type { Map } from "$lib/map-cesium/map";
import { MvtLayer } from "$lib/map-cesium/layers/mvt-layer";
import type { DataDrivenStyle, LayerStyle } from "$lib/map-cesium/providers/mvt-style";
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

const addLayer: UiTool<AddLayerArgs> = {
	name: "add_layer",
	description:
		"Add a layer to the user's map. service_type 'wfs' or 'wms': a web service; use its url and layer name " +
		"exactly as the user gave them or as a dataset search returned them - never invent either. " +
		"service_type 'dataset': one of the user's own datasets (layer_name is its table name from AVAILABLE DATASETS, " +
		"or the table you just loaded); no url. Only call this when the user wants to see that data on the map.",
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
			? `Voeg de dataset "${args.title ?? args.layerName}" toe aan de kaart`
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

		const config = registerLayer(map, new LayerConfig({
			id: newId(),
			title: args.title ?? args.layerName,
			type: args.serviceType,
			groupId: GAIA_GROUP_ID,
			defaultOn: true,
			settings:
				args.serviceType === "wfs"
					? { url: args.url, featureType: args.layerName }
					: { url: args.url, featureName: args.layerName }
		}));

		/* De kaart meldt een mislukte laag zelf, maar zet dan alleen `added` terug. */
		const layer = map.getLayerById(config.id);
		if (!layer || !get(config.added)) {
			map.layerLibrary.removeLayerConfig(config);
			throw new Error(`Kon de laag "${args.layerName}" niet toevoegen: de dienst reageert niet zoals verwacht of kent de laag niet.`);
		}
		return `${args.serviceType.toUpperCase()}-laag "${layer.title}" is aan de kaart toegevoegd.`;
	}
};

/* Zet een laagconfig in de bibliotheek (in een eigen groep) en voegt hem aan de kaart toe. */
function registerLayer(map: Map, config: LayerConfig): LayerConfig {
	const library = map.layerLibrary;
	if (!library.findGroup(GAIA_GROUP_ID)) {
		library.addLayerConfigGroup(new LayerConfigGroup(GAIA_GROUP_ID, "Door de assistent toegevoegd"));
	}
	library.addLayerConfig(config);
	config.added.set(true);
	return config;
}

/* Een dataset van de gebruiker als vector tiles (zie datasetMvtConfig). */
async function addDatasetLayer(args: AddLayerArgs, context: UiToolContext): Promise<string> {
	const { map } = context;
	const existing = get(map.layers).find((layer) => layer.config.settings?.datasetId === args.layerName);
	if (existing) return `De dataset staat al op de kaart als "${existing.title}".`;

	const info = await fetchTileInfo(context, args.layerName);
	const config = registerLayer(
		map,
		datasetMvtConfig(context, info, { id: newId(), groupId: GAIA_GROUP_ID, title: args.title, defaultOn: true })
	);

	const layer = map.getLayerById(config.id);
	if (!(layer instanceof MvtLayer)) {
		map.layerLibrary.removeLayerConfig(config);
		throw new Error(`Kon de dataset "${args.layerName}" niet als laag toevoegen.`);
	}
	if (config.cameraPosition) map.flyTo(config.cameraPosition);
	return `Dataset "${layer.title}" is aan de kaart toegevoegd (${info.feature_count} objecten). Eigenschappen om op te kleuren: ${
		info.properties.slice(0, 15).map((p) => `${p.name} (${p.kind})`).join(", ")
	}.`;
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
	description: "Remove a layer from the map. Only when the user asks for it.",
	defaultApproval: "ask",
	eligibleLayers: (layers) => layers,
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
	/* Eigen klassengrenzen (oplopend); zonder deze kiest de API ze. */
	breaks?: number[];
	/* Eén kleur per klasse (breaks.length + 1); null = de eigen kleur van de laag houden. */
	colors?: (string | null)[];
}

const MAX_BREAKS = 6;

function parseBreaks(obj: Record<string, unknown>): Pick<ColorByPropertyArgs, "breaks" | "colors"> {
	const rawBreaks = obj["breaks"];
	const rawColors = obj["colors"];
	if (rawBreaks === undefined || rawBreaks === null) {
		if (rawColors !== undefined && rawColors !== null) throw new Error('"colors" gaat alleen samen met "breaks".');
		return {};
	}
	if (!Array.isArray(rawBreaks) || rawBreaks.length === 0 || rawBreaks.length > MAX_BREAKS) {
		throw new Error(`"breaks" moet een lijst van 1 tot ${MAX_BREAKS} getallen zijn.`);
	}
	const breaks = rawBreaks.map((value) => (typeof value === "string" ? Number(value) : value));
	if (!breaks.every((value): value is number => typeof value === "number" && Number.isFinite(value))) {
		throw new Error('"breaks" mag alleen getallen bevatten.');
	}
	if (breaks.some((value, i) => i > 0 && value <= breaks[i - 1])) {
		throw new Error('"breaks" moet strikt oplopend zijn.');
	}
	if (rawColors === undefined || rawColors === null) return { breaks };
	if (!Array.isArray(rawColors) || rawColors.length !== breaks.length + 1) {
		throw new Error(`"colors" moet precies ${breaks.length + 1} kleuren hebben: één per klasse, dus één meer dan "breaks".`);
	}
	const colors = rawColors.map((color) => {
		if (color === null || color === "") return null;
		if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) {
			throw new Error('Elke kleur in "colors" moet de vorm #rrggbb hebben, of null.');
		}
		return color;
	});
	return { breaks, colors };
}

const colorLayerByProperty: UiTool<ColorByPropertyArgs> = {
	name: "color_layer_by_property",
	description:
		"Colour a layer's features by one of their properties, so features with different values get different " +
		"colours (e.g. \"colour the areas by type\"). `property` must be one of the layer's properties as listed " +
		"for that layer - never invent one. The app picks the colours, you cannot: a number property gets a " +
		"gradient over its range, a text property one colour per value. Only some layers can be coloured this way.\n" +
		"For a number property you can set the classes yourself with `breaks` (ascending class boundaries) and " +
		"optionally `colors` (exactly one per class, so one more than breaks). A value equal to a break falls in " +
		"the higher class. Use null in `colors` to keep the layer's own colour for that class. Example, \"colour the " +
		"areas larger than 1000 red\": breaks [1000], colors [null, \"#ff0000\"]. Without `colors` the app picks a " +
		"gradient. Features without a value keep the layer's own colour.",
	defaultApproval: "auto",
	eligibleLayers: (layers) => layers.filter(({ layer }) => isStylable(layer)),
	parameters: (layers) => ({
		type: "object",
		properties: {
			layer_ref: layerRefProperty(layers),
			property: { type: "string", description: "The property whose values decide the colour." },
			breaks: {
				type: "array",
				items: { type: "number" },
				description: `Optional, number properties only: ascending class boundaries (1 to ${MAX_BREAKS}). ` +
					"Class 1 is below breaks[0]; each next class starts at its break."
			},
			colors: {
				type: "array",
				items: { type: ["string", "null"] },
				description: "Optional, with breaks only: one #rrggbb colour per class (breaks.length + 1 entries), " +
					"or null to keep the layer's own colour for that class."
			}
		},
		required: ["layer_ref", "property"]
	}),
	parse: (raw) => {
		const obj = asObject(raw);
		return { layerRef: requireString(obj, "layer_ref"), property: requireString(obj, "property"), ...parseBreaks(obj) };
	},
	describe: (args) =>
		`Kleur de laag "${args.layerRef}" op basis van "${args.property}"` +
		(args.breaks ? ` met grenzen ${args.breaks.join(", ")}` : ""),
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
		if (args.breaks) {
			if (property.kind !== "number") {
				throw new Error(`"${property.name}" is geen getal; eigen grenzen ("breaks") gaan alleen bij getallen.`);
			}
			/* De eigen kleur van de laag: vulling, of bij lijnen de lijnkleur. Die geldt voor de
			   klassen met null, en voor objecten zonder waarde. */
			const base = get(layer.style);
			const own = /LineString/.test(String(layer.config.settings["geometryType"] ?? "")) ? base.strokeColor : base.fillColor;
			const ramp = graduatedFromBreaks(property.name, args.breaks);
			const style: DataDrivenStyle = {
				...ramp,
				colors: args.colors ? args.colors.map((color) => color ?? own) : ramp.colors,
				fallbackColor: own
			};
			layer.setDataDrivenStyle(style);
			return `"${layer.title}" is gekleurd op "${property.name}" met eigen grenzen. ${describeStyle(style)}.`;
		}

		/* Een MVT-laag heeft de objecten niet in de browser (een tile bevat alleen wat in beeld
		   is): de klassen komen van de API, want die ziet de hele dataset. */
		const style = await layer.colorBy(property.name);
		return `"${layer.title}" is gekleurd op "${property.name}". ${style ? describeStyle(style) : ""}.`;
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

/* Op `UiTool<unknown>` gezet aan de rand van de lijst: aanroepers gaan altijd eerst
   langs tool.parse, en dat maakt het argumenttype betrouwbaar. */
export const UI_TOOLS = [addLayer, flyTo, setLayerVisibility, colorLayerByProperty, setLayerStyle, removeLayer] as unknown as UiTool<unknown>[];

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
