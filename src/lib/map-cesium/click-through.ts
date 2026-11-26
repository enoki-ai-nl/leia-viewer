import * as Cesium from "cesium";

/* Databronnen die alleen iets aanwijzen (zoals de markering van een chatresultaat) en zelf
   geen gegevens hebben: een klik erop gaat erdoorheen, naar het object eronder
   (FeatureInfoHandler.queryFeatureInfo). */
const clickThrough = new WeakSet<Cesium.DataSource>();

export function markClickThrough(source: Cesium.DataSource): void {
	clickThrough.add(source);
}

/* Of een resultaat van scene.pick/drillPick bij zo'n databron hoort. */
export function isClickThrough(picked: unknown): boolean {
	const id = (picked as { id?: unknown } | undefined)?.id;
	if (!(id instanceof Cesium.Entity)) return false;
	/* Geen `instanceof Cesium.DataSource`: dat is in Cesium alleen een interface, waar
	   GeoJsonDataSource en de andere niet van erven - die controle is altijd onwaar. */
	const owner = id.entityCollection?.owner as Cesium.DataSource | undefined;
	return owner !== undefined && clickThrough.has(owner);
}
