import type { DataDrivenStyle } from "$lib/map-cesium/providers/mvt-style";

/* Kleuren voor het kleuren van een laag op een eigenschap. De assistent noemt alleen de
   eigenschap en het soort indeling; de kleuren kiest de viewer, zodat het model nooit
   zelf kleuren per object hoeft te verzinnen.

   Bewust een kopie van frontend/app/utils/styleUtils.ts: de twee frontends delen geen
   bestanden (ze draaien op aparte servers), dus houd de paletten gelijk met de hand. */

/* Okabe-Ito plus enkele aanvullingen eerst (de eerste 12: ook te onderscheiden voor
   kleurenblinden), dan 18 uit de contrastpaletten van Kelly en Trubetskoy, tot de 30
   categorieën die de backend toestaat (MAX_CATEGORIES in services/tiles.py). Voorbij 12 is
   niet elk paar veilig voor kleurenblinden. */
const CATEGORICAL_PALETTE = [
	"#0072b2", "#e69f00", "#009e73", "#cc79a7", "#d55e00", "#56b4e9",
	"#f0e442", "#7f7f7f", "#8c564b", "#17becf", "#bcbd22", "#e377c2",
	"#be0032", "#875692", "#a1caf1", "#c2b280", "#f99379", "#604e97",
	"#b3446c", "#8db600", "#654522", "#2b3d26", "#000075", "#aaffc3",
	"#808000", "#ffd8b1", "#469990", "#dcbeff", "#800000", "#fabed4"
];

/* Licht naar donker, zodat een hogere waarde als "meer" leest. */
const SEQUENTIAL_PALETTES: Record<string, string[]> = {
	blues: ["#deebf7", "#9ecae1", "#4292c6", "#2171b5", "#08306b"],
	greens: ["#e5f5e0", "#a1d99b", "#41ab5d", "#238b45", "#00441b"],
	oranges: ["#feedde", "#fdbe85", "#fd8d3c", "#d94701", "#7f2704"],
	purples: ["#efedf5", "#bcbddc", "#807dba", "#6a51a3", "#3f007d"],
	viridis: ["#fde725", "#5ec962", "#21918c", "#3b528b", "#440154"]
};

export const FALLBACK_COLOR = "#bdbdbd";

// Hue (degrees), saturation and lightness (0-1) of a #rrggbb colour.
function hsl(hex: string): [number, number, number] {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
	if (d === 0) return [0, 0, l];
	const s = d / (1 - Math.abs(2 * l - 1));
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [(h * 60 + 360) % 360, s, l];
}

// Whether two colours would read as the same colour on the map: both clearly coloured and
// of nearly the same hue (two blues), or close in plain RGB (two greys, two dark colours).
export function colorsLookAlike(a: string, b: string): boolean {
	const [ha, sa, la] = hsl(a), [hb, sb, lb] = hsl(b);
	const vivid = (s: number, l: number) => s > 0.25 && l > 0.15 && l < 0.85;
	if (vivid(sa, la) && vivid(sb, lb)) {
		const dh = Math.abs(ha - hb);
		return Math.min(dh, 360 - dh) < 30;
	}
	const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
	const distance = Math.hypot(...[1, 3, 5].map((i) => channel(a, i) - channel(b, i)));
	return distance < 80;
}

// The colour for what matches no rule: the one asked for, else the layer's own colour -
// unless that looks like one of the rule colours, then grey, so the rules stay visible
// ("the counts above 10 blue" on a layer that already is blue).
export function otherRuleColor(own: string, ruleColors: string[], asked?: string): string {
	if (asked) return asked;
	return ruleColors.some((color) => colorsLookAlike(own, color)) ? FALLBACK_COLOR : own;
}
export const MAX_CATEGORIES = CATEGORICAL_PALETTE.length;

function hexToRgb(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb: number[]): string {
	return "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

/* `count` kleuren gelijkmatig langs de stops van een palet. */
function sampleRamp(stops: string[], count: number): string[] {
	if (count === 1) return [stops[Math.floor(stops.length / 2)]];
	return Array.from({ length: count }, (_, i) => {
		const position = (i / (count - 1)) * (stops.length - 1);
		const lower = Math.floor(position);
		const upper = Math.min(lower + 1, stops.length - 1);
		const t = position - lower;
		const a = hexToRgb(stops[lower]);
		const b = hexToRgb(stops[upper]);
		return rgbToHex(a.map((channel, k) => channel + (b[k] - channel) * t));
	});
}

/* Eén kleur per waarde; `values` komen het vaakst voorkomend eerst. */
export function categoricalFromValues(property: string, values: string[]): DataDrivenStyle {
	if (values.length === 0) throw new Error(`Geen enkel object heeft een waarde voor "${property}".`);
	if (values.length > MAX_CATEGORIES) {
		throw new Error(`"${property}" heeft ${values.length} verschillende waarden; meer dan ${MAX_CATEGORIES} zijn niet op kleur te onderscheiden.`);
	}
	return {
		property,
		kind: "categorical",
		categories: values.map((value, i) => ({ value, color: CATEGORICAL_PALETTE[i] })),
		fallbackColor: FALLBACK_COLOR
	};
}

/* Kleurklassen tussen grenswaarden (ondergrens van elke klasse na de eerste). */
export function graduatedFromBreaks(property: string, breaks: number[], palette = "blues"): DataDrivenStyle {
	const ramp = SEQUENTIAL_PALETTES[palette];
	if (!ramp) throw new Error(`Onbekend palet "${palette}". Kies uit: ${Object.keys(SEQUENTIAL_PALETTES).join(", ")}.`);
	if (breaks.length === 0) throw new Error(`Er valt niets in klassen te verdelen in "${property}".`);
	return {
		property,
		kind: "graduated",
		breaks,
		colors: sampleRamp(ramp, breaks.length + 1),
		fallbackColor: FALLBACK_COLOR
	};
}

/* Eén regel over de klassen en hun kleuren, om de assistent aan de gebruiker te laten doorgeven. */
export function describeStyle(style: DataDrivenStyle): string {
	if (style.kind === "categorical") {
		return (style.categories ?? []).map(({ value, color }) => `${value}: ${color}`).join("; ");
	}
	if (style.kind === "rules") {
		return [...(style.rules ?? []).map(({ label, color }) => `${label}: ${color}`), `overige: ${style.fallbackColor}`].join("; ");
	}
	const breaks = style.breaks ?? [];
	const round = (n: number) => Number(n.toPrecision(4));
	return (style.colors ?? [])
		.map((color, i) => {
			const label = i === 0 ? `onder ${round(breaks[0])}` : i < breaks.length ? `${round(breaks[i - 1])} tot ${round(breaks[i])}` : `vanaf ${round(breaks[i - 1])}`;
			return `${label}: ${color}`;
		})
		.join("; ");
}
