/** Shared by the server (which answers) and the browser (which explains). */

export const BACKEND_UNAVAILABLE = "backend_unavailable";
export const STORAGE_UNAVAILABLE = "storage_unavailable";

export const AUTH_REQUIRED = "auth_required";

export const HOSTED_MESSAGE =
  "This copy of GTPS Assistant runs on a hosting service. Its backend (AI providers, documentation sync and search, the script check) is locked. Chats, the Lua workspace, preferences and backups still work here, in your browser. To use everything, run it on your own computer (see \"Running locally\" in the README) or unlock the backend of this deployment.";

export const HOSTED_NEEDS_PASSWORD =
  "The backend of this deployment is locked because no access password is set. The owner must add GTPS_ACCESS_PASSWORD (at least 8 characters) to the host's environment variables and redeploy; AI keys go in GEMINI_API_KEY and GROQ_API_KEY. Until then only the browser features work (chats, Lua workspace, preferences, backups).";

export const AUTH_REQUIRED_MESSAGE = "Enter the access password (banner at the top of the page) to use the backend of this deployment.";

export const STORAGE_MESSAGE =
  "The local backend could not open its database. Check that the data folder is writable (set GTPS_DB_PATH to another location if needed) and restart the app.";

/** True for the error codes that mean "the backend cannot do this here", as opposed to "this request was wrong". */
export const isUnavailableCode = (code: string | null | undefined): boolean => code === BACKEND_UNAVAILABLE || code === STORAGE_UNAVAILABLE;
