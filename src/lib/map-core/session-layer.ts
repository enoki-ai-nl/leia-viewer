import type { LayerConfig } from "./layer-config";
import type { LayerLibrary } from "./layer-library";

/* A session layer is one of the user's own datasets in the backend's database (the
   "Ingeladen lagen" of the chat): loaded by the agent, derived by it, or uploaded. It lives
   in the user's session on the server, not in the viewer's config, so it is never just taken
   off the map: it is shown or hidden, or deleted from the server for good (work item #53).

   The marker is `settings.session` on the layer's config, set only where such a layer is
   made (MapToolChat/GaiaLayers/gaia-layers.ts, datasetMvtConfig). It says where the data
   lives, not how it is drawn, so it holds for any layer type. */
export interface SessionLayer {
	datasetId: string;
	/* Deletes the dataset from the server and removes every layer showing it from the
	   library (and so from the map). Returns the names of derived layers that the server
	   turned into tables to keep them. */
	delete(library: LayerLibrary): Promise<string[]>;
}

export function sessionLayer(config: LayerConfig | undefined): SessionLayer | undefined {
	const session = config?.settings?.["session"];
	return session && typeof session.delete === "function" ? (session as SessionLayer) : undefined;
}

export const isSessionLayer = (config: LayerConfig | undefined): boolean => sessionLayer(config) !== undefined;
