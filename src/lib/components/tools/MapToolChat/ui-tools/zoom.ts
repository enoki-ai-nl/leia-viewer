import { get } from "svelte/store";
import * as Cesium from "cesium";

import { getCameraPositionFromBoundingSphere } from "$lib/map-cesium/utils/layer-utils";
import type { Map } from "$lib/map-cesium/map";

/* [west, zuid, oost, noord] in WGS84-graden. */
export type Bbox = [number, number, number, number];

/* Rond een punt (of een heel klein gebied): een paar honderd meter, zodat een adres en zijn
   straat in beeld zijn. */
const MIN_HALF_SIZE_DEGREES = 0.003;

/* Vlieg de kaart naar een gebied: voor zoom_to_location en voor de regels van een
   zoekresultaat in de chat (sql_db_query geeft per rij met een geometrie zijn bbox). */
export function zoomToBbox(map: Map, [w, s, e, n]: Bbox): void {
	const cx = (w + e) / 2, cy = (s + n) / 2;
	const hx = Math.max((e - w) / 2, MIN_HALF_SIZE_DEGREES), hy = Math.max((n - s) / 2, MIN_HALF_SIZE_DEGREES);
	const sphere = Cesium.BoundingSphere.fromRectangle3D(Cesium.Rectangle.fromDegrees(cx - hx, cy - hy, cx + hx, cy + hy));
	map.flyTo(getCameraPositionFromBoundingSphere(sphere, get(map.options.use3DMode)));
}
