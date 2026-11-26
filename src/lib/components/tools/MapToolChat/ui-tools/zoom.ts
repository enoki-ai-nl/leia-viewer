import { get } from "svelte/store";
import * as Cesium from "cesium";

import type { Map } from "$lib/map-cesium/map";

/* [west, zuid, oost, noord] in WGS84-graden. */
export type Bbox = [number, number, number, number];

/* Rond een punt (of een heel klein gebied): een paar honderd meter, zodat een adres en zijn
   straat in beeld zijn. */
const MIN_HALF_SIZE_DEGREES = 0.003;

/* Marge om het gebied heen: wat precies op de rand ligt (een punt, met zijn ring eromheen)
   valt anders net buiten beeld. */
const MARGIN = 1.3;

/* Schuin van boven in 3D, recht van boven in 2D (zoals Map.flyTo dat afdwingt). */
const PITCH_3D = -45;
const PITCH_2D = -89.9;

/* Vlieg de kaart naar een gebied: voor zoom_to_location en voor de regels van een
   zoekresultaat in de chat (sql_db_query geeft per rij met een geometrie zijn bbox). */
export function zoomToBbox(map: Map, [w, s, e, n]: Bbox): void {
	const cx = (w + e) / 2, cy = (s + n) / 2;
	const hx = Math.max((e - w) / 2, MIN_HALF_SIZE_DEGREES), hy = Math.max((n - s) / 2, MIN_HALF_SIZE_DEGREES);
	const sphere = Cesium.BoundingSphere.fromRectangle3D(Cesium.Rectangle.fromDegrees(cx - hx, cy - hy, cx + hx, cy + hy));
	sphere.radius *= MARGIN;
	/* Cesium rekent zelf de afstand uit waarop de hele bol binnen de kijkhoek valt (range 0).
	   getCameraPositionFromBoundingSphere zette de camera op één straal hoogte: bij 45 graden
	   en de standaard kijkhoek van 60 graden is dat te dichtbij, en vielen de randen weg. */
	const pitch = get(map.options.use3DMode) ? PITCH_3D : PITCH_2D;
	map.viewer.camera.flyToBoundingSphere(sphere, {
		offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(pitch), 0),
		duration: 1
	});
}
