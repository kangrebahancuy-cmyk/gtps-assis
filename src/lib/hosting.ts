/** Shared by the server (which answers) and the browser (which explains). */

export const BACKEND_UNAVAILABLE = "backend_unavailable";
export const STORAGE_UNAVAILABLE = "storage_unavailable";

export const HOSTED_MESSAGE =
  "This copy of GTPS Assistant runs on a hosting service and has no local backend. AI providers, documentation sync, documentation search and the script check need the backend, which runs on your own computer (see \"Running locally\" in the README). Chats, the Lua workspace, preferences and backups still work here, in your browser.";

export const STORAGE_MESSAGE =
  "The local backend could not open its database. Check that the data folder is writable (set GTPS_DB_PATH to another location if needed) and restart the app.";

/** True for the error codes that mean "the backend cannot do this here", as opposed to "this request was wrong". */
export const isUnavailableCode = (code: string | null | undefined): boolean => code === BACKEND_UNAVAILABLE || code === STORAGE_UNAVAILABLE;
