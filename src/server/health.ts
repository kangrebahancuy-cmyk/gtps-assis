import { hostedPlatform, protectedRoute } from "@/server/hosting";
import type { Db } from "@/server/db/database";

export interface Health {
  ok: boolean;
  /** "local": the backend runs here; "hosted": a hosting service that cannot run it. */
  mode: "local" | "hosted";
  backend: boolean;
  platform: string | null;
  node: string;
  /** Local mode only: the database opened and how many documents it holds. */
  database?: { ok: true; documents: number };
}

export interface HealthDeps {
  env?: NodeJS.ProcessEnv;
  node?: string;
  openDatabase: () => Db;
}

/** GET /api/health: answers on every host. It reveals no paths, keys or settings. */
export function handleHealth(deps: HealthDeps) {
  const env = deps.env ?? process.env;
  const node = deps.node ?? process.versions.node;
  const local = protectedRoute(async () => {
    const db = deps.openDatabase();
    const documents = (db.prepare("SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL").get() as { n: number }).n;
    const body: Health = { ok: true, mode: "local", backend: true, platform: null, node, database: { ok: true, documents } };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }, { env });
  return async (request: Request): Promise<Response> => {
    const platform = hostedPlatform(env);
    if (platform !== null) {
      const body: Health = { ok: true, mode: "hosted", backend: false, platform, node };
      return Response.json(body, { headers: { "cache-control": "no-store" } });
    }
    return local(request);
  };
}
