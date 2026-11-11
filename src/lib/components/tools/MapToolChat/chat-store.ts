import { writable } from "svelte/store";

export const chatApiUrl = writable<string | undefined>(undefined);

/* Telt op als de agent een dataset in de database heeft gezet (zie chat-session), zodat de
   lijst met AI-lagen hem erbij haalt (zie MapToolChat.svelte). */
export const datasetsChanged = writable(0);
