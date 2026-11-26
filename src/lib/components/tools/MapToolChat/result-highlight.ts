import * as Cesium from "cesium";

import { markClickThrough } from "$lib/map-cesium/click-through";
import type { Map } from "$lib/map-cesium/map";

/* De plekken waar een antwoord over gaat, gemarkeerd op de kaart als de gebruiker ernaar
   zoomt (de zoomknoppen onder een zoekresultaat). Eén databron, bij elke zoom opnieuw
   gevuld; weg bij de volgende vraag of een ander gesprek. */

/* Een GeoJSON-geometrie in WGS84, zoals sql_db_query die per rij meestuurt. */
export type Shape = { type: string; coordinates?: unknown; geometries?: unknown };

/* Alles als felblauwe lijn plat op het terrein, zonder vulling: een lijn als zichzelf, een
   vlak als zijn rand(en), een punt als ring eromheen. Zo blijft te zien wat eronder ligt (en
   een klik gaat erdoorheen, zie markClickThrough). De markering van een aangeklikt MVT-object
   is hier niet te gebruiken: die tekent de tiles van zijn laag opnieuw met alleen dat object,
   en een zoekresultaat is vaak geen object in een laag op de kaart (een berekende vorm, een
   laag die niet getoond wordt). */
const HIGHLIGHT_COLOR = Cesium.Color.fromCssColorString("#61FFFF");
const HIGHLIGHT_WIDTH = 4;

/* Een ring in meters wordt kleiner als je uitzoomt, dus zijn straal volgt de spreiding van de
   punten (de kaart zoomt naar die spreiding): een paar procent ervan, met een minimum voor
   één punt (straatniveau). */
const POINT_RING_MIN_RADIUS = 15; // meter
const POINT_RING_MAX_RADIUS = 2000; // meter
const POINT_RING_SPREAD_FRACTION = 0.02;
const POINT_RING_SEGMENTS = 64;

const METERS_PER_DEGREE = 111_320;

/* Een gesloten cirkel van `radius` meter rond een punt, als posities voor een lijn op het terrein. */
function ring(center: Cesium.Cartographic, radius: number): Cesium.Cartesian3[] {
	const lon = Cesium.Math.toDegrees(center.longitude);
	const lat = Cesium.Math.toDegrees(center.latitude);
	const dLat = radius / METERS_PER_DEGREE;
	const dLon = radius / (METERS_PER_DEGREE * Math.cos(center.latitude));
	const positions: Cesium.Cartesian3[] = [];
	for (let i = 0; i <= POINT_RING_SEGMENTS; i++) {
		const angle = (2 * Math.PI * i) / POINT_RING_SEGMENTS;
		positions.push(
			Cesium.Cartesian3.fromDegrees(lon + dLon * Math.cos(angle), lat + dLat * Math.sin(angle))
		);
	}
	return positions;
}

/* De straal van de ringen: een fractie van de diagonaal (in meters) om alle punten heen. */
function ringRadius(centers: Cesium.Cartographic[]): number {
	if (centers.length < 2) return POINT_RING_MIN_RADIUS;
	const box = Cesium.Rectangle.fromCartographicArray(centers);
	const middle = (box.south + box.north) / 2;
	const width = Cesium.Math.toDegrees(box.width) * METERS_PER_DEGREE * Math.cos(middle);
	const height = Cesium.Math.toDegrees(box.height) * METERS_PER_DEGREE;
	const radius = Math.hypot(width, height) * POINT_RING_SPREAD_FRACTION;
	return Math.min(Math.max(radius, POINT_RING_MIN_RADIUS), POINT_RING_MAX_RADIUS);
}

const sources = new WeakMap<Map, Cesium.GeoJsonDataSource>();
/* Laden gaat asynchroon: een tweede klik voordat de eerste klaar is, wint. */
let latest = 0;

function removeHighlight(map: Map): void {
	const source = sources.get(map);
	if (!source) return;
	map.viewer.dataSources.remove(source, true);
	sources.delete(map);
}

/* Markeer deze vormen en vervang een eerdere markering. Geen vormen: alleen weghalen. */
export async function highlightShapes(
	map: Map,
	shapes: (Shape | null | undefined)[]
): Promise<void> {
	const run = ++latest;
	removeHighlight(map);

	const features = shapes
		.filter((shape): shape is Shape => Boolean(shape))
		.map((geometry) => ({ type: "Feature", properties: {}, geometry }));
	if (features.length === 0) {
		map.refresh();
		return;
	}

	try {
		const source = await Cesium.GeoJsonDataSource.load(
			{ type: "FeatureCollection", features },
			{ clampToGround: true, stroke: HIGHLIGHT_COLOR, strokeWidth: HIGHLIGHT_WIDTH }
		);
		if (run !== latest) return;
		/* De vormen hebben geen eigen gegevens: een klik erop toont het object eronder. */
		markClickThrough(source);

		const now = map.viewer.clock.currentTime;

		/* Een punt wordt standaard een speld (billboard): in plaats daarvan een ring op het
		   terrein (zie POINT_RING_*). */
		const points = source.entities.values.filter((entity) => entity.billboard);
		const centers = points
			.map((entity) => entity.position?.getValue(now))
			.filter((position): position is Cesium.Cartesian3 => Boolean(position))
			.map((position) => Cesium.Cartographic.fromCartesian(position));
		const radius = ringRadius(centers);
		for (const entity of points) {
			entity.billboard = undefined;
			const position = entity.position?.getValue(now);
			if (!position) continue;
			entity.polyline = new Cesium.PolylineGraphics({
				positions: ring(Cesium.Cartographic.fromCartesian(position), radius),
				clampToGround: true,
				width: HIGHLIGHT_WIDTH,
				material: HIGHLIGHT_COLOR
			});
		}

		/* Een vlak: alleen zijn randen (buitenrand en gaten), als lijnen op het terrein. Het
		   vlak zelf gaat weg, zodat een klik erbinnen niet op een onzichtbaar vlak valt. */
		const outline = (positions: Cesium.Cartesian3[]) =>
			new Cesium.PolylineGraphics({
				positions: [...positions, positions[0]],
				clampToGround: true,
				width: HIGHLIGHT_WIDTH,
				material: HIGHLIGHT_COLOR
			});
		for (const entity of source.entities.values.filter((e) => e.polygon)) {
			const hierarchy: Cesium.PolygonHierarchy | undefined =
				entity.polygon?.hierarchy?.getValue(now);
			entity.polygon = undefined;
			if (!hierarchy?.positions?.length) continue;
			entity.polyline = outline(hierarchy.positions);
			for (const hole of hierarchy.holes ?? []) {
				if (hole.positions?.length) source.entities.add({ polyline: outline(hole.positions) });
			}
		}

		await map.viewer.dataSources.add(source);
		if (run !== latest) {
			map.viewer.dataSources.remove(source, true);
			return;
		}
		sources.set(map, source);
		map.refresh();
	} catch (error) {
		/* Alleen de markering gaat verloren; het zoomen is al gebeurd. */
		console.warn("Kon het resultaat niet markeren op de kaart:", error);
	}
}

export function clearHighlight(map: Map): void {
	latest++;
	removeHighlight(map);
	map.refresh();
}
