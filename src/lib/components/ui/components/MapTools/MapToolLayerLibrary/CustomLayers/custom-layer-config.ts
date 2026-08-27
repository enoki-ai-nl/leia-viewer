import { LayerConfig } from "$lib/components/map-core/layer-config";
import { Dispatcher } from "$lib/components/map-core/event/dispatcher";
import { get, writable, type Unsubscriber, type Writable } from "svelte/store";
import { fetchWfsFeatureTypes, type WfsFeatureType } from "$lib/components/map-cesium/module/providers/wfs-capabilities";



export class CustomLayerConfigTracker extends Dispatcher {
	
	public layerConfig: LayerConfig;
	public isValid: Writable<boolean> = writable(false);

	public titleInput: Writable<string>;
	public layerTypeInput: Writable<string>;
	public settingsInput: Writable<any>;
	public added: Writable<boolean>;

	public validType: Writable<boolean> = writable(false);
	public validUrl: Writable<boolean> = writable(false);

	// Feature types die de ingevulde WFS zelf aanbiedt. Leeg zolang er geen
	// geldige WFS-URL staat, of wanneer de dienst geen bruikbare catalogus geeft -
	// het formulier valt dan terug op handmatige invoer.
	public availableFeatureTypes: Writable<Array<WfsFeatureType>> = writable([]);
	private lastCapabilitiesUrl: string = "";

	private unsubscribers: Array<Unsubscriber> = new Array<Unsubscriber>();

	constructor(layerConfig?: LayerConfig) {
		super();
		this.layerConfig = layerConfig ?? new LayerConfig({id: String(Math.floor(Math.random() * 1000)), groupId: "myData", title: "New layer", settings: {}});
		this.titleInput = writable(this.layerConfig.title);
		this.layerTypeInput = writable(this.layerConfig.type);
		this.settingsInput = writable(this.layerConfig.settings);
		this.added = writable(get(this.layerConfig.added)); //Clone store

		this.setupValidators();
	}

	private setupValidators() {
		this.unsubscribers[0] = this.titleInput.subscribe((value) => {
			this.layerConfig.title = value;
			this.onInputChange();
		});

		this.unsubscribers[1] = this.layerTypeInput.subscribe((value) => {
			this.layerConfig.type = value;
			this.onInputChange();
		});

		this.unsubscribers[2] = this.settingsInput.subscribe((value) => {
			this.layerConfig.settings = value;
			this.onInputChange();
		});

		this.unsubscribers[3] = this.added.subscribe(async(value) => {
			if (value) {
				const exists = await this.checkIfUrlExists();
				if (!exists) {
					this.dispatch("urlError", {});
					this.added.set(false);
				} else {
					this.layerConfig.added.set(true);
				}
				this.dispatch("updated", {});
			} else {
				this.layerConfig.added.set(false);
				this.dispatch("updated", {});
			}
		});
	}


	private onInputChange(): void {
		this.validateLayerConfig();
		this.refreshFeatureTypes();
		this.dispatch("updated", {});
		if (this.unsubscribers[3]) this.added.set(false); // Checking this.unsubscribers[3] to see if setup is finished
	}

	/**
	 * Haalt de feature types op zodra er een geldige WFS-URL staat. Onthoudt welke
	 * URL het laatst is opgehaald, want `onInputChange` vuurt bij elke toetsaanslag
	 * en anders zou elke letter een nieuw verzoek de deur uit sturen.
	 */
	private async refreshFeatureTypes(): Promise<void> {
		if (this.layerConfig.type !== "wfs" || !get(this.validUrl)) {
			this.lastCapabilitiesUrl = "";
			this.availableFeatureTypes.set([]);
			return;
		}

		const url = get(this.settingsInput)?.url ?? "";
		if (url === this.lastCapabilitiesUrl) return;
		this.lastCapabilitiesUrl = url;

		this.availableFeatureTypes.set(await fetchWfsFeatureTypes(url));
	}

	private validateType(type: string): boolean {
		return ["3dtiles", "wms", "wfs", "wmts", "geojson", "modelanimation", "arcgis"].includes(type);
	}

	private validateSettings(settings: any = this.layerConfig.settings): boolean {
		if (["wms", "wmts"].includes(this.layerConfig.type) && !settings["featureName"]) return false;
		if (this.layerConfig.type === "wfs" && !settings["featureType"]) return false;
		if (this.layerConfig.type === "modelAnimation" && (!settings["modelUrl"] || !settings["timeKey"])) return false;
		else return true;
	}

	private validateUrl(settings: any = this.layerConfig.settings): boolean {
		if (!settings.url || !this.layerConfig.type) return false;
		try {
			const url = new URL(settings.url); // --> requires https:// at start
			if (!["https:", "http:"].includes(url.protocol)) return false;
			//if (this.layerConfig.type === "3dtiles" && !settings.url.endsWith("/tileset.json")) return false; //Google 3D Tiles does not end with tileset.json
			//if (this.layerConfig.type === "wms" && !url.href.includes("/wms")) return false; 
			//if (this.layerConfig.type === "wmts" && !url.href.includes("/wmts")) return false;
			if (this.layerConfig.type === "geojson" && !url.href.endsWith(".geojson")) return false;
			if (this.layerConfig.type === "modelanimation" && !url.href.endsWith(".geojson")) return false;
			return true; 
		} catch {
			return false;
		}
	}

	public validateLayerConfig(): void {
		this.validType.set(
			this.validateType(get(this.layerTypeInput))
		);
		this.validUrl.set(
			this.validateUrl(get(this.settingsInput))
		);
		const validSettings = this.validateSettings();
        this.isValid.set(
			get(this.validType) && get(this.validUrl) && validSettings
		);
		if (get(this.isValid) === false) this.added.set(false);
    }


	public async checkIfUrlExists(): Promise<boolean> {
		let url = this.layerConfig.settings.url;
		if (!url || !get(this.validUrl)) return false;
		if (this.layerConfig.type === "wms") url += "?service=wms&request=getcapabilities";
		if (this.layerConfig.type === "wmts") url += "?service=wmts&request=getcapabilities";
		// Een kale WFS-URL zonder parameters geeft bij veel diensten een foutstatus,
		// waardoor de laag ten onrechte als onbereikbaar zou gelden. Knip wat de
		// gebruiker plakte af en vraag zelf de catalogus op.
		if (this.layerConfig.type === "wfs") url = `${url.split("?")[0]}?service=wfs&request=getcapabilities`;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 1000); // if no response after 1000ms, then consider the request as failed

		return fetch(url, { signal: controller.signal }).then((response) => {
			clearTimeout(timeout)
			return (response.status === 200)
		}).catch(() => {
			clearTimeout(timeout)
			return false;
		});
	}


	public destroy() {
		for (let i = 0; i < this.unsubscribers.length; i++) {
			this.unsubscribers[i]();
		}
	}
}