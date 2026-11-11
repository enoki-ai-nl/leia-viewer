import { get, writable, type Writable } from "svelte/store";
import * as Cesium from "cesium";

import { CesiumImageryLayer } from "./imagery-layer";
import { getCameraPositionFromBoundingSphere } from "../utils/layer-utils";
import { LruCache, MvtImageryProvider, featureKey, type FeatureCache } from "../providers/mvt-imagery-provider";
import {
	createHighlightStyleFunction,
	createStyleFunction,
	nextLayerStyle,
	type DataDrivenStyle,
	type LayerStyle
} from "../providers/mvt-style";
import { CustomLayerControl } from "$lib/map-core/custom-layer-control";
import LayerControlMvt from "$lib/components/layer-controls/LayerControlMvt/LayerControlMvt.svelte";

import type { LayerConfig } from "$lib/map-core/layer-config";
import type { Map } from "../map";

export interface MvtProperty {
	name: string;
	kind: "number" | "text";
}

/* [west, zuid, oost, noord] als het een geldige extent in graden is, anders undefined. Een
   extent in een ander stelsel (bijv. RD in meters) laat Cesium vastlopen bij het berekenen van
   de camerapositie, en dan kan de laag niet eens worden toegevoegd. */
function degreesExtent(value: unknown): [number, number, number, number] | undefined {
	if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return undefined;
	const [west, south, east, north] = value as number[];
	const valid = -180 <= west && west <= east && east <= 180 && -90 <= south && south <= north && north <= 90;
	return valid ? [west, south, east, north] : undefined;
}

/* Een laag met vector tiles (MVT) van een XYZ-tileservice, getekend als afbeeldingslaag
   (MvtImageryProvider). Stijl en selectie werken zoals in de frontend met MapLibre:

   - stijl: `setStyle` (kleuren, lijndikte, puntgrootte) en `colorBy` / `setDataDrivenStyle`
     (kleuren op eigenschap). Een tile ligt vast als hij getekend is, dus een andere stijl
     betekent een nieuwe afbeeldingslaag op dezelfde plek in de stapel.
   - selectie: een klik loopt via de feature-info van de viewer (Cesium roept de provider aan),
     die `select` aanroept; `selected` is de sleutel van het geselecteerde object.

   settings:
     url          URL-sjabloon met {z}, {x} en {y}
     headers      () => headers per tile-verzoek (bijv. de sleutel van de gebruiker); een functie,
                  zodat die niet in de zichtbare instellingen staat
     extent       [west, zuid, oost, noord] in graden
     maxZoom      diepste niveau waarop tiles gevraagd worden (standaard 18)
     detail       hoeveel niveaus fijner dan de globe (0-3, standaard 1); alleen deze laag,
                  niet het terrein of 3D tiles (zie MvtImageryProvider)
     geometryType type van de objecten (bijv. "MultiPolygon"), alleen ter informatie
     properties   [{ name, kind }] - eigenschappen waarop gekleurd kan worden
     classes      (property, kind) => Promise<DataDrivenStyle>: de kleurklassen over de héle
                  dataset (een tile bevat alleen wat in beeld is); nodig voor `colorBy`
     style        deel van een LayerStyle om de standaardstijl te overschrijven
     Andere sleutels laat de laag ongemoeid: ze zijn voor wie de laag heeft aangemaakt. */
export class MvtLayer extends CesiumImageryLayer {
	public style: Writable<LayerStyle>;
	public dataDriven: Writable<DataDrivenStyle | undefined>;
	/* De sleutel van het geselecteerde object, of undefined. */
	public selected: Writable<string | undefined>;

	private featureCache: FeatureCache;
	private highlight: Cesium.ImageryLayer | undefined;
	/* Waar de nieuwe afbeeldingslaag in de stapel komt als de oude is vervangen. */
	private insertAt: number | undefined;
	private reportedError = false;

	constructor(map: Map, config: LayerConfig) {
		super(map, config);
		this.style = writable({ ...nextLayerStyle(), ...config.settings["style"] });
		this.dataDriven = writable(undefined);
		this.selected = writable(undefined);
		this.featureCache = new LruCache(300);

		const extent = degreesExtent(config.settings["extent"]);
		if (config.settings["extent"] && !extent) {
			console.warn(`Laag "${config.title}": extent ${JSON.stringify(config.settings["extent"])} is niet in graden; genegeerd.`);
		}
		if (extent) {
			/* Zodat "vlieg naar" werkt, net als bij de laagbeheerder. */
			const sphere = Cesium.BoundingSphere.fromRectangle3D(Cesium.Rectangle.fromDegrees(...extent));
			this.map.options.use3DMode.subscribe((use3D) => {
				this.config.cameraPosition = getCameraPositionFromBoundingSphere(sphere, use3D);
			});
		}

		const control = new CustomLayerControl();
		control.component = LayerControlMvt;
		control.props = { layer: this };
		this.addCustomControl(control);

		/* Niet pas bij `startLoading`: dat wordt al in de constructor van de basisklasse
		   aangeroepen, voordat de velden hierboven bestaan. Een afbeeldingslaag vraagt toch
		   niets op zolang hij verborgen is. */
		this.createLayer();
	}

	public createLayer(): void {
		this.source = this.buildLayer();
	}

	/* Zie createLayer: dat gebeurt al in de constructor. */
	protected startLoading(): void {}

	public get properties(): MvtProperty[] {
		return this.config.settings["properties"] ?? [];
	}

	/* --- Stijl ------------------------------------------------------------------------ */

	public setStyle(patch: Partial<LayerStyle>): void {
		this.style.update((style) => ({ ...style, ...patch }));
		this.rebuild();
	}

	/* Kleur de objecten op een eigenschap; `undefined` zet de basiskleur terug. */
	public setDataDrivenStyle(style: DataDrivenStyle | undefined): void {
		this.dataDriven.set(style);
		this.rebuild();
	}

	/* Kleur op een eigenschap, met klassen over de héle dataset (`settings.classes`). */
	public async colorBy(property: string | undefined): Promise<DataDrivenStyle | undefined> {
		if (!property) {
			this.setDataDrivenStyle(undefined);
			return undefined;
		}
		const kind = this.properties.find((candidate) => candidate.name === property)?.kind;
		if (!kind) throw new Error(`"${this.title}" heeft geen eigenschap "${property}".`);
		const classes = this.config.settings["classes"] as ((property: string, kind: string) => Promise<DataDrivenStyle>) | undefined;
		if (!classes) throw new Error(`"${this.title}" kan niet op eigenschap gekleurd worden: er is geen klassenindeling.`);
		const style = await classes(property, kind);
		this.setDataDrivenStyle(style);
		return style;
	}

	/* --- Selectie --------------------------------------------------------------------- */

	/* Markeer het object dat Cesium bij een klik vond (zie MvtImageryProvider.pickFeatures). */
	public select(feature: Cesium.ImageryLayerFeatureInfo): void {
		const key = feature.data?.key;
		if (key === undefined) return;
		this.clearSelection();

		const color = get(this.map.featureInfo.selectedFeatureColor);
		const layers = this.map.viewer.imageryLayers;
		/* Een eigen provider, want de stijl ligt vast in wat hij tekent; de gedecodeerde tiles
		   zijn gedeeld, dus dit haalt niets opnieuw op. Geen config_id: dit is niet de laag zelf. */
		const provider = this.createProvider(createHighlightStyleFunction(featureKey, key, color), false);
		this.highlight = new Cesium.ImageryLayer(provider as unknown as Cesium.ImageryProvider);
		layers.add(this.highlight);
		layers.raiseToTop(this.highlight);
		this.selected.set(key);
		this.map.refresh();
	}

	public clearSelection(): void {
		if (!this.highlight) return;
		this.map.viewer.imageryLayers.remove(this.highlight, true);
		this.highlight = undefined;
		this.selected.set(undefined);
		this.map.refresh();
	}

	/* --- Laag in de kaart ------------------------------------------------------------- */

	private createProvider(style: ReturnType<typeof createStyleFunction>, pickable: boolean): MvtImageryProvider {
		const settings = this.config.settings;
		return new MvtImageryProvider({
			url: settings["url"],
			headers: settings["headers"],
			style,
			featureCache: this.featureCache,
			extent: degreesExtent(settings["extent"]),
			maximumLevel: settings["maxZoom"],
			detail: settings["detail"],
			pickable,
			onError: (error) => {
				/* Eén melding per laag: bij een kapotte server faalt anders elke tile. */
				if (this.reportedError) return;
				this.reportedError = true;
				console.error(`MVT-laag "${this.title}":`, error);
			}
		});
	}

	private buildLayer(): Cesium.ImageryLayer {
		const provider = this.createProvider(createStyleFunction(get(this.style), get(this.dataDriven)), true);
		return new Cesium.ImageryLayer(provider as unknown as Cesium.ImageryProvider, {
			alpha: this.getOpacity(get(this.opacity)),
			show: get(this.visible)
		});
	}

	/* Een andere stijl: een nieuwe afbeeldingslaag op de plek van de oude. */
	private rebuild(): void {
		const layers = this.map.viewer.imageryLayers;
		const index = layers.indexOf(this.source);
		if (index >= 0) {
			layers.remove(this.source, true);
			this.insertAt = index;
		}
		this.source = this.buildLayer();
	}

	/* Anders dan de basisklasse op de plek van een vervangen laag, niet bovenaan. */
	public addToMap(): void {
		const layers = this.map.viewer.imageryLayers;
		const index = this.insertAt ?? (this.config.isBackground ? 0 : undefined);
		this.insertAt = undefined;
		if (index === undefined) layers.add(this.source);
		else layers.add(this.source, index);
		get(this.visible) ? this.show() : this.hide();
	}

	public removeFromMap(): void {
		this.clearSelection();
		super.removeFromMap();
	}

	/* Wat verborgen is kan niet geselecteerd zijn. */
	public hide(): void {
		super.hide();
		if (this.source) this.clearSelection();
	}
}
