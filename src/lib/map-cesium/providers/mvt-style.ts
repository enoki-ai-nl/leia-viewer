import { asArray } from "ol/color.js";
import { Fill, Stroke, Style } from "ol/style.js";
import CircleStyle from "ol/style/Circle.js";

import type { FeatureLike } from "ol/Feature.js";
import type { StyleFunction } from "ol/style/Style.js";

/* Hoe een MVT-laag getekend wordt: dezelfde opties als de React-frontend met MapLibre
   (frontend/app/types, LayerStyle), plus een kleuring op eigenschap die de kleur van de
   geometrie overschrijft. Alles hier is puur OpenLayers-stijl: er komt geen Cesium bij kijken,
   en de uitkomst is een StyleFunction die MvtImageryProvider op de tiles loslaat. */

export interface LayerStyle {
	fillColor: string;
	fillOpacity: number;
	strokeColor: string;
	strokeWidth: number;
	strokeOpacity: number;
	pointRadius: number;
	pointStrokeColor: string;
	pointStrokeWidth: number;
}

/* Kleuring op een eigenschap. De assistent (of de gebruiker) kiest de eigenschap, de viewer
   kiest de kleuren (zie MapToolChat/ui-tools/styles.ts). */
export interface DataDrivenStyle {
	property: string;
	kind: "categorical" | "graduated";
	categories?: { value: string; color: string }[]; // categorical: één kleur per waarde
	breaks?: number[]; // graduated: ondergrens van elke klasse na de eerste, oplopend
	colors?: string[]; // graduated: één kleur per klasse, dus breaks.length + 1
	fallbackColor: string; // voor objecten zonder (bruikbare) waarde
}

/* Dezelfde vier vul-/lijnkleurparen als de React-app voor een nieuwe laag
   (frontend/app/utils/layerUtils.ts, randomLayerStyle). */
const FILL_COLORS = ["#ffbf00", "#e83f6f", "#2274a5", "#32936f"];
const STROKE_COLORS = ["#735600", "#770e2c", "#0f354a", "#174333"];

/* De volgende stijl uit het palet voor een nieuwe laag, zodat lagen die kort na elkaar worden
   toegevoegd een verschillende kleur krijgen. */
let nextPair = 0;
export function nextLayerStyle(): LayerStyle {
	const i = nextPair++ % FILL_COLORS.length;
	return {
		fillColor: FILL_COLORS[i],
		fillOpacity: 0.75,
		strokeColor: STROKE_COLORS[i],
		strokeWidth: 2,
		strokeOpacity: 1,
		pointRadius: 5,
		pointStrokeColor: "#ffffff",
		pointStrokeWidth: 2
	};
}

/* De kleur van een object bij een kleuring op eigenschap. Dezelfde regels als de MapLibre-
   expressie in de frontend (colorExpression): waarden worden als tekst vergeleken, een object
   zonder (bruikbare) waarde krijgt de terugvalkleur, en een klasse begint bij zijn ondergrens. */
export function dataDrivenColor(style: DataDrivenStyle, properties: Record<string, unknown>): string {
	const value = properties[style.property];
	const blank = value === undefined || value === null || value === "";

	if (style.kind === "categorical") {
		if (blank) return style.fallbackColor;
		const text = String(value);
		return style.categories?.find((category) => String(category.value) === text)?.color ?? style.fallbackColor;
	}

	if (blank) return style.fallbackColor;
	const colors = style.colors ?? [];
	const number = Number(value);
	const n = Number.isFinite(number) ? number : 0;
	const breaks = style.breaks ?? [];
	let index = 0;
	while (index < breaks.length && n >= breaks[index]) index++;
	return colors[index] ?? style.fallbackColor;
}

/* Een CSS-kleur met een doorzichtigheid erbij, als rgba(...). */
function withOpacity(color: string, opacity: number): string {
	const [r, g, b, a] = asArray(color);
	return `rgba(${r}, ${g}, ${b}, ${a * opacity})`;
}

type Kind = "point" | "line" | "polygon";

function kindOf(feature: FeatureLike): Kind {
	/* Bij een RenderFeature (zo komen tiles binnen) is de geometrie het object zelf. */
	const type = feature.getGeometry()?.getType() ?? "Polygon";
	if (type.endsWith("Point")) return "point";
	if (type.endsWith("LineString")) return "line";
	return "polygon";
}

/* De StyleFunction voor een laag: de basisstijl, met de kleur van de geometrie vervangen door
   die van de kleuring op eigenschap als er een is. Een Style per soort object en kleur wordt
   bewaard: een tile heeft er duizenden, de kleuren zijn er maar enkele. */
export function createStyleFunction(style: LayerStyle, dataDriven?: DataDrivenStyle): StyleFunction {
	const cache = new Map<string, Style>();
	const make = (kind: Kind, color: string): Style => {
		const stroke = new Stroke({ color: withOpacity(style.strokeColor, style.strokeOpacity), width: style.strokeWidth });
		if (kind === "line") {
			return new Style({ stroke: new Stroke({ color: withOpacity(color, style.strokeOpacity), width: style.strokeWidth }) });
		}
		const fill = new Fill({ color: withOpacity(color, style.fillOpacity) });
		if (kind === "point") {
			return new Style({
				image: new CircleStyle({
					radius: style.pointRadius,
					fill,
					stroke: new Stroke({ color: style.pointStrokeColor, width: style.pointStrokeWidth })
				})
			});
		}
		return new Style({ fill, stroke });
	};

	return (feature) => {
		const kind = kindOf(feature);
		const color = dataDriven
			? dataDrivenColor(dataDriven, feature.getProperties())
			: kind === "line"
				? style.strokeColor
				: style.fillColor;
		const key = `${kind}|${color}`;
		let result = cache.get(key);
		if (!result) cache.set(key, (result = make(kind, color)));
		return result;
	};
}

/* De markering van het geselecteerde object: alleen dat object krijgt een stijl, de rest
   `undefined` (niet getekend). `keyOf` bepaalt wat "hetzelfde object" is. */
export function createHighlightStyleFunction(
	keyOf: (feature: FeatureLike) => string,
	selectedKey: string,
	color: string
): StyleFunction {
	const point = new Style({
		image: new CircleStyle({
			radius: 9,
			fill: new Fill({ color: withOpacity(color, 0.85) }),
			stroke: new Stroke({ color: "#ffffff", width: 2 })
		})
	});
	const line = new Style({ stroke: new Stroke({ color, width: 5 }) });
	const polygon = new Style({
		fill: new Fill({ color: withOpacity(color, 0.6) }),
		stroke: new Stroke({ color, width: 4 })
	});
	return (feature) => {
		if (keyOf(feature) !== selectedKey) return undefined;
		const kind = kindOf(feature);
		return kind === "point" ? point : kind === "line" ? line : polygon;
	};
}
