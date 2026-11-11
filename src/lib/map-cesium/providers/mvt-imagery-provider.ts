import * as Cesium from "cesium";
import MVT from "ol/format/MVT.js";
import { toContext } from "ol/render.js";
import RenderFeature from "ol/render/Feature.js";

import type { StyleFunction } from "ol/style/Style.js";

/* Vector tiles (MVT) als Cesium-afbeeldingslaag. Cesium kent geen MVT (MVTDataProvider is
   experimenteel en tekent geen punten op het terrein), dus de tiles worden hier gedecodeerd
   en met OpenLayers' tekenfuncties op een canvas gezet, en als gewone afbeelding aan Cesium
   gegeven. Dat is wat ol-cesium doet (olcs/MVTImageryProvider), maar los van OpenLayers'
   kaart en van ol-cesium zelf.

   - Tiles van 512 px: de objecten blijven in 256 eenheden getekend (lijndiktes kloppen met
     een tile van 256 px), maar op een 2x canvas, dus scherper.
   - Een afbeelding ligt vast als hij getekend is: een andere stijl is een nieuwe provider.
     Daarom is de stijl een argument, en de gedecodeerde tiles zijn te delen (`featureCache`),
     zodat een nieuwe provider (andere stijl, markering) niets opnieuw hoeft te downloaden.
   - Selectie loopt via Cesium zelf: `pickFeatures` wordt aangeroepen met de tile onder de
     klik, en zoekt de objecten die daar liggen in de gedecodeerde geometrie. */

const TILE_UNITS = 256; // tekeneenheden per tile
const PIXEL_RATIO = 2; // pixels per eenheid: 512 px per tile
const TILE_SIZE = TILE_UNITS * PIXEL_RATIO;
const MVT_EXTENT = 4096; // coördinaten in een MVT-tile lopen van 0 tot 4096
const HIT_TOLERANCE_PX = 6; // zo dicht bij een lijn of punt telt als erop klikken
const MAX_LEVEL = 18;

/* Een afgeleide laagnaam, zodat een kolom die "layer" heet niet door de naam van de tile-laag
   wordt overschreven (zo noemt OpenLayers 'm standaard). */
const LAYER_PROPERTY = "_layer";
const format = new MVT({ featureClass: RenderFeature, layerName: LAYER_PROPERTY });

/* Wat "hetzelfde object" is bij selecteren: de feature-id die de backend in de tile zet
   (app_fid), anders de eigenschappen. */
export function featureKey(feature: { getId(): string | number | undefined; getProperties(): object }): string {
	const id = feature.getId();
	return id !== undefined ? String(id) : JSON.stringify(feature.getProperties());
}

/* Een kleine LRU-cache (de oudste valt eruit), voor de gedecodeerde tiles. */
export class LruCache<T> {
	private entries = new Map<string, T>();
	constructor(private readonly size: number) {}

	get(key: string): T | undefined {
		const value = this.entries.get(key);
		if (value !== undefined) {
			this.entries.delete(key);
			this.entries.set(key, value);
		}
		return value;
	}

	set(key: string, value: T): void {
		this.entries.delete(key);
		this.entries.set(key, value);
		if (this.entries.size > this.size) this.entries.delete(this.entries.keys().next().value!);
	}

	delete(key: string): void {
		this.entries.delete(key);
	}
}

export type FeatureCache = LruCache<Promise<RenderFeature[]>>;

export interface MvtImageryProviderOptions {
	/* URL-sjabloon met {z}, {x} en {y}. */
	url: string;
	/* Headers per tile-verzoek (bijv. een sleutel). Een functie, zodat zo'n sleutel niet in de
	   zichtbare laaginstellingen hoeft te staan. */
	headers?: () => Record<string, string>;
	/* Hoe een object getekend wordt; `undefined` = niet tekenen (en dus ook niet selecteerbaar). */
	style: StyleFunction;
	/* Gedecodeerde tiles om te delen met andere providers van dezelfde bron. */
	featureCache?: FeatureCache;
	/* [west, zuid, oost, noord] in graden: er worden geen tiles buiten gevraagd. */
	extent?: [number, number, number, number];
	/* Diepste niveau waarop tiles gevraagd worden; daaronder rekt Cesium het beeld op. */
	maximumLevel?: number;
	/* Meldt een tile die niet te laden of te tekenen was; de tile blijft dan leeg. */
	onError?: (error: Error) => void;
	/* Kan er geselecteerd worden? Niet voor de markeringslaag: die zit er bovenop. */
	pickable?: boolean;
	/* Hoeveel niveaus dieper dan de rest van de globe deze laag tiles kiest (standaard 1).
	   Cesium kiest het niveau van een afbeeldingslaag bij de terreintile, op basis van de
	   `tileWidth` die de provider opgeeft; elke stap halveert die opgegeven breedte, dus kiest
	   Cesium een niveau dieper. Getekend wordt nog steeds 512 px. Het terrein, de andere
	   afbeeldingslagen en 3D tiles merken er niets van. Elke stap kost zo'n 4x zoveel tiles. */
	detail?: number;
}

export class MvtImageryProvider {
	/* Wat Cesium van een afbeeldingsprovider verwacht. */
	readonly tilingScheme = new Cesium.WebMercatorTilingScheme();
	readonly rectangle: Cesium.Rectangle;
	/* Wat Cesium denkt dat een tile breed is (zie `detail`); het canvas is altijd TILE_SIZE. */
	readonly tileWidth: number;
	readonly tileHeight: number;
	readonly minimumLevel = 0;
	readonly maximumLevel: number;
	readonly hasAlphaChannel = true;
	readonly errorEvent = new Cesium.Event();
	readonly credit = undefined;
	readonly proxy = undefined;
	readonly tileDiscardPolicy = undefined;

	private readonly options: MvtImageryProviderOptions;
	private readonly featureCache: FeatureCache;
	private emptyTile: HTMLCanvasElement | undefined;

	constructor(options: MvtImageryProviderOptions) {
		this.options = options;
		this.featureCache = options.featureCache ?? new LruCache(300);
		this.maximumLevel = options.maximumLevel ?? MAX_LEVEL;
		const detail = Math.max(0, Math.min(3, Math.round(options.detail ?? 0.5)));
		this.tileWidth = this.tileHeight = TILE_SIZE / 2 ** detail;
		this.rectangle = options.extent ? Cesium.Rectangle.fromDegrees(...options.extent) : this.tilingScheme.rectangle;
	}

	getTileCredits(): Cesium.Credit[] {
		return [];
	}

	requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement> {
		return this.tileFeatures(level, x, y).then(
			(features) => this.rasterize(features),
			(error) => {
				this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
				return this.empty();
			}
		);
	}

	/* Cesium roept dit aan met de tile (x, y, level) onder de klik en de plek daarin. */
	pickFeatures(
		x: number,
		y: number,
		level: number,
		longitude: number,
		latitude: number
	): Promise<Cesium.ImageryLayerFeatureInfo[]> | undefined {
		if (this.options.pickable === false) return undefined;
		return this.tileFeatures(level, x, y).then(
			(features) => {
				const [px, py] = this.tileCoordinates(x, y, level, longitude, latitude);
				return pickAt(features, px, py, HIT_TOLERANCE_PX / PIXEL_RATIO, this.options.style).map(toFeatureInfo);
			},
			() => []
		);
	}

	/* De gedecodeerde objecten van een tile, uit de cache of van de server. Een mislukte tile
	   blijft niet in de cache staan: bij een volgende keer wordt hij opnieuw geprobeerd. */
	private tileFeatures(z: number, x: number, y: number): Promise<RenderFeature[]> {
		const key = `${z}/${x}/${y}`;
		let promise = this.featureCache.get(key);
		if (!promise) {
			promise = this.load(z, x, y);
			this.featureCache.set(key, promise);
			promise.catch(() => this.featureCache.delete(key));
		}
		return promise;
	}

	private async load(z: number, x: number, y: number): Promise<RenderFeature[]> {
		const url = this.options.url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
		const response = await fetch(url, { headers: this.options.headers?.() });
		/* Een tile zonder objecten is geen fout: 204, of 404 bij sommige services. */
		if (response.status === 204 || response.status === 404) return [];
		if (!response.ok) throw new Error(`Tile ${z}/${x}/${y} ophalen mislukt: ${response.status}`);
		return decode(await response.arrayBuffer());
	}

	private rasterize(features: RenderFeature[]): HTMLCanvasElement {
		const canvas = document.createElement("canvas");
		const context = toContext(canvas.getContext("2d")!, { size: [TILE_UNITS, TILE_UNITS], pixelRatio: PIXEL_RATIO });
		for (const feature of features) {
			const styles = this.options.style(feature, 1);
			if (!styles) continue;
			for (const style of Array.isArray(styles) ? styles : [styles]) {
				context.setStyle(style);
				context.drawGeometry(feature);
			}
		}
		return canvas;
	}

	private empty(): HTMLCanvasElement {
		if (!this.emptyTile) {
			this.emptyTile = document.createElement("canvas");
			this.emptyTile.width = TILE_SIZE;
			this.emptyTile.height = TILE_SIZE;
		}
		return this.emptyTile;
	}

	/* De plek (lengte- en breedtegraad, in radialen) als tekeneenheden binnen de tile. */
	private tileCoordinates(x: number, y: number, level: number, longitude: number, latitude: number): [number, number] {
		const tile = this.tilingScheme.tileXYToNativeRectangle(x, y, level);
		const point = this.tilingScheme.projection.project(new Cesium.Cartographic(longitude, latitude));
		return [
			((point.x - tile.west) / (tile.east - tile.west)) * TILE_UNITS,
			((tile.north - point.y) / (tile.north - tile.south)) * TILE_UNITS
		];
	}
}

function decode(buffer: ArrayBuffer): RenderFeature[] {
	if (buffer.byteLength === 0) return [];
	const features = format.readFeatures(buffer) as RenderFeature[];
	/* De coördinaten komen binnen in tile-eenheden (0..4096); getekend wordt in 256. */
	const scale = TILE_UNITS / MVT_EXTENT;
	for (const feature of features) {
		const coordinates = feature.getFlatCoordinates();
		for (let i = 0; i < coordinates.length; i++) coordinates[i] *= scale;
	}
	return features;
}

/* --- Welke objecten liggen op een plek? ------------------------------------------------
   Een tile is alleen een afbeelding voor Cesium, dus de objecten onder de muis moeten uit de
   gedecodeerde geometrie komen. Punten en lijnen gaan voor vlakken, anders wint het vlak
   onder een weg altijd en zijn dunne lijnen niet te selecteren. */

const RANK = { point: 0, line: 1, polygon: 2 } as const;

function rankOf(type: string): number {
	return type.endsWith("Point") ? RANK.point : type.endsWith("LineString") ? RANK.line : RANK.polygon;
}

/* De delen (lijnen, ringen) van een geometrie als [begin, eind) in de platte coördinatenlijst. */
function parts(coordinates: ArrayLike<number>, ends: number[] | null): [number, number][] {
	const result: [number, number][] = [];
	let start = 0;
	for (const end of ends?.length ? ends : [coordinates.length]) {
		result.push([start, end]);
		start = end;
	}
	return result;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSquared = dx * dx + dy * dy;
	const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/* Hoe ver een punt van een object ligt: 0 in een vlak, anders de afstand tot het dichtstbijzijnde
   punt, lijnstuk of vlakrand. */
export function distanceTo(feature: RenderFeature, px: number, py: number): number {
	const type = feature.getType();
	const c = feature.getFlatCoordinates();

	if (type.endsWith("Point")) {
		let min = Infinity;
		for (let i = 0; i + 1 < c.length; i += 2) min = Math.min(min, Math.hypot(px - c[i], py - c[i + 1]));
		return min;
	}

	let min = Infinity;
	let inside = false;
	for (const [start, end] of parts(c, feature.getEnds() as number[] | null)) {
		for (let i = start; i + 3 < end; i += 2) {
			min = Math.min(min, distanceToSegment(px, py, c[i], c[i + 1], c[i + 2], c[i + 3]));
		}
		if (type === "Polygon") {
			/* Even-odd over alle ringen: gaten en losse delen van een multipolygoon kloppen zo vanzelf. */
			for (let i = start, j = end - 2; i < end; j = i, i += 2) {
				if (c[i + 1] > py !== c[j + 1] > py && px < ((c[j] - c[i]) * (py - c[i + 1])) / (c[j + 1] - c[i + 1]) + c[i]) {
					inside = !inside;
				}
			}
		}
	}
	return inside ? 0 : min;
}

/* De objecten binnen `tolerance` eenheden van een plek die ook getekend worden (`style` geeft iets
   terug), de beste eerst: punten, dan lijnen (dichtstbij eerst), dan vlakken (bovenste eerst). */
export function pickAt(
	features: RenderFeature[],
	px: number,
	py: number,
	tolerance: number,
	style: StyleFunction
): RenderFeature[] {
	const hits: { feature: RenderFeature; rank: number; distance: number; order: number }[] = [];
	features.forEach((feature, order) => {
		const distance = distanceTo(feature, px, py);
		if (distance <= tolerance && style(feature, 1)) {
			hits.push({ feature, rank: rankOf(feature.getType()), distance, order });
		}
	});
	/* Bij vlakken wint wat het laatst getekend is, want dat ligt bovenop. */
	hits.sort((a, b) => a.rank - b.rank || (a.rank === RANK.polygon ? b.order - a.order : a.distance - b.distance));
	return hits.map((hit) => hit.feature);
}

/* Een gevonden object als wat Cesium en de feature-info van de viewer verwachten. `data.key`
   is wat MvtLayer.select nodig heeft voor de markering. */
function toFeatureInfo(feature: RenderFeature): Cesium.ImageryLayerFeatureInfo {
	const { [LAYER_PROPERTY]: _tileLayer, ...properties } = feature.getProperties();
	const id = feature.getId();
	const info = new Cesium.ImageryLayerFeatureInfo();
	/* Zoals in de frontend: het id van het object in de tile is app_fid, geen eigenschap. */
	/* `properties` ontbreekt in Cesium's typings, maar de feature-info van de viewer leest het. */
	(info as unknown as { properties: object }).properties = { ...(id !== undefined ? { app_fid: id } : {}), ...properties };
	info.name = String(properties["name"] ?? id ?? "");
	info.data = { key: featureKey(feature) };
	return info;
}
