import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { APPROVED_DOMAINS, checkSourceUrl, hostMatches, normalizeDomain } from "@/lib/docs-source";
import { DocsSourceStore } from "@/server/docs-source/store";
import { createSyncRig, defaultPages, startSite, type Site, type SyncRig } from "./support/sync-rig";
import { freshRepo } from "./helpers";

describe("approved documentation domains (pure rules)", () => {
  it("accepts the approved domain and its subdomains over https", () => {
    for (const url of ["https://dash.gtps.cloud/docs", "https://gtps.cloud/", "https://a.b.gtps.cloud/x"]) assert.equal(checkSourceUrl(url).ok, true, url);
  });
  it("refuses lookalikes, other hosts, http, credentials and junk", () => {
    const cases: Array<[unknown, string]> = [
      ["https://evilgtps.cloud/docs", "domain_not_approved"],
      ["https://gtps.cloud.evil.example/docs", "domain_not_approved"],
      ["https://example.com/docs", "domain_not_approved"],
      ["http://dash.gtps.cloud/docs", "unsupported_scheme"],
      ["https://user:pw@dash.gtps.cloud/docs", "credentials"],
      ["ftp://gtps.cloud", "unsupported_scheme"],
      ["not a url", "invalid_url"],
      ["", "invalid_url"],
      [42, "invalid_url"],
    ];
    for (const [input, problem] of cases) {
      const check = checkSourceUrl(input);
      assert.equal(check.ok, false, String(input));
      if (!check.ok) assert.equal(check.problem, problem, String(input));
    }
  });
  it("hostMatches never treats a suffix without a dot as a subdomain", () => {
    assert.equal(hostMatches("evilgtps.cloud", "gtps.cloud"), false);
    assert.equal(hostMatches("DASH.GTPS.CLOUD", "gtps.cloud"), true);
  });
  it("extra domains are honoured only when listed; plain http is allowed only for loopback", () => {
    assert.equal(checkSourceUrl("https://docs.example.com/x", ["example.com"]).ok, true);
    assert.equal(checkSourceUrl("http://docs.example.com/x", ["example.com"]).ok, false);
    assert.equal(checkSourceUrl("http://127.0.0.1:8080/docs", ["127.0.0.1"]).ok, true);
    assert.equal(checkSourceUrl("http://127.0.0.1:8080/docs").ok, false);
  });
  it("normalizeDomain cleans input and refuses wildcards, TLDs and bad IPs", () => {
    assert.equal(normalizeDomain(" HTTPS://Docs.Example.com:8443/path "), "docs.example.com");
    assert.equal(normalizeDomain("127.0.0.1:3000"), "127.0.0.1");
    for (const bad of ["", "*.example.com", "com", "999.1.1.1", "a b.com", "user@example.com", "-bad.com"]) assert.equal(normalizeDomain(bad), null, bad);
  });
  it("the approved list is what the page shows (no hidden entries)", () => assert.deepEqual([...APPROVED_DOMAINS], ["gtps.cloud"]));
});

describe("DocsSourceStore", () => {
  it("starts with the defaults and persists valid changes", () => {
    const { repo } = freshRepo();
    const store = new DocsSourceStore(repo);
    assert.equal(store.get().sourceUrl, "https://dash.gtps.cloud/docs");
    store.update({ sourceUrl: "https://docs.gtps.cloud/v2", websiteUrl: "https://www.gtps.cloud/" });
    const again = new DocsSourceStore(repo).get();
    assert.equal(again.sourceUrl, "https://docs.gtps.cloud/v2");
    assert.equal(again.websiteUrl, "https://www.gtps.cloud/");
  });
  it("writes nothing when one field is refused", () => {
    const { repo } = freshRepo();
    const store = new DocsSourceStore(repo);
    assert.throws(() => store.update({ sourceUrl: "https://docs.gtps.cloud/ok", websiteUrl: "https://example.com" }), /not an approved/);
    assert.equal(store.get().sourceUrl, "https://dash.gtps.cloud/docs");
  });
  it("a hand-edited database cannot smuggle in an unapproved source", () => {
    const { repo } = freshRepo();
    repo.setMeta("docs_source.url", "https://evil.example/docs");
    assert.equal(new DocsSourceStore(repo).get().sourceUrl, "https://dash.gtps.cloud/docs");
  });
  it("adds and removes extra domains, and refuses removing one that is still in use", () => {
    const { repo } = freshRepo();
    const store = new DocsSourceStore(repo);
    store.addDomain("Docs.Example.com");
    assert.deepEqual(store.get().extraDomains, ["docs.example.com"]);
    store.addDomain("docs.example.com");
    store.addDomain("dash.gtps.cloud"); // already approved: not added
    assert.deepEqual(store.get().extraDomains, ["docs.example.com"]);
    store.update({ sourceUrl: "https://docs.example.com/docs" });
    assert.throws(() => store.removeDomain("docs.example.com"), /used by the documentation source/);
    store.update({ sourceUrl: "https://dash.gtps.cloud/docs" });
    store.removeDomain("docs.example.com");
    assert.deepEqual(store.get().extraDomains, []);
  });
  it("caps the number of extra domains", () => {
    const { repo } = freshRepo();
    const store = new DocsSourceStore(repo);
    for (let i = 0; i < 20; i++) store.addDomain(`d${i}.example.com`);
    assert.throws(() => store.addDomain("one-more.example.com"), /At most 20/);
  });
});

describe("/api/docs-source and /api/sync handlers", () => {
  let rig: SyncRig | undefined;
  let sites: Site[] = [];
  afterEach(async () => {
    rig?.close();
    rig = undefined;
    await Promise.all(sites.map((s) => s.close()));
    sites = [];
  });
  const setup = async (pages = defaultPages()) => {
    rig = createSyncRig();
    const site = await startSite(pages);
    sites.push(site);
    const r = rig;
    // The local user explicitly allows the loopback host, then points the source at it.
    assert.equal((await r.call("POST", "/api/docs-source/domains", { domain: site.host, confirm: true })).status, 200);
    const put = await r.call("PUT", "/api/docs-source", { sourceUrl: `${site.origin}/docs` });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    return { r, site };
  };

  it("GET returns defaults, approved domains and the live document count", async () => {
    rig = createSyncRig();
    const { status, body } = await rig.call("GET", "/api/docs-source");
    assert.equal(status, 200);
    assert.equal(body.settings.sourceUrl, "https://dash.gtps.cloud/docs");
    assert.deepEqual(body.approvedDomains, ["gtps.cloud"]);
    assert.equal(body.documents, 0);
    assert.equal(body.busy, false);
  });

  it("refuses an unapproved source URL with a readable reason and keeps the old one", async () => {
    rig = createSyncRig();
    const res = await rig.call("PUT", "/api/docs-source", { sourceUrl: "https://example.com/docs" });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "domain_not_approved");
    assert.match(res.body.error, /example\.com is not an approved/);
    assert.equal((await rig.call("GET", "/api/docs-source")).body.settings.sourceUrl, "https://dash.gtps.cloud/docs");
  });

  it("adding a domain needs confirm:true; the page cannot be tricked by a cross-site request", async () => {
    rig = createSyncRig();
    assert.equal((await rig.call("POST", "/api/docs-source/domains", { domain: "example.com" })).body.code, "confirmation_required");
    const cross = await rig.call("POST", "/api/docs-source/domains", { domain: "example.com", confirm: true }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    assert.equal(cross.status, 403);
    assert.deepEqual((await rig.call("GET", "/api/docs-source")).body.settings.extraDomains, []);
  });

  it("removing a domain: DELETE ?domain=, refused with 409 while the source still uses it", async () => {
    const { r, site } = await setup();
    const used = await r.call("DELETE", `/api/docs-source/domains?domain=${site.host}`);
    assert.equal(used.status, 409);
    assert.equal(used.body.code, "in_use");
    await r.call("PUT", "/api/docs-source", { sourceUrl: "https://dash.gtps.cloud/docs" });
    const ok = await r.call("DELETE", `/api/docs-source/domains?domain=${site.host}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.settings.extraDomains, []);
    assert.equal((await r.call("DELETE", "/api/docs-source/domains")).status, 400);
  });

  it("a user-approved domain makes a custom source usable and a real sync indexes it", async () => {
    const { r } = await setup();
    const status = await r.runSync("full");
    assert.equal(status.lastRun?.status, "completed");
    assert.equal(status.lastRun?.counts.added, 3);
    assert.equal(status.totals.documents, 3);
  });

  it("start refuses when the configured source is no longer allowed", async () => {
    rig = createSyncRig();
    // Simulate a corrupted config: the engine points at a host that was never approved.
    const { configForSource } = await import("@/server/sync/api");
    rig.service.setConfig(configForSource(rig.service.getConfig(), "https://example.com/docs"));
    const res = await rig.call("POST", "/api/sync/start", { mode: "full" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "domain_not_approved");
  });

  it("changing the source with indexed documents needs confirmation, and then keeps them", async () => {
    const { r } = await setup();
    await r.runSync("full");
    const siteB = await startSite({ "/docs": { text: "Site B overview text here." } });
    sites.push(siteB);
    // Same host (127.0.0.1) is already approved, so only the confirmation gate applies.
    const unconfirmed = await r.call("PUT", "/api/docs-source", { sourceUrl: `${siteB.origin}/docs` });
    assert.equal(unconfirmed.status, 409);
    assert.equal(unconfirmed.body.code, "confirmation_required");
    assert.equal(unconfirmed.body.documents, 3);
    assert.ok(!r.service.getConfig().startUrl.startsWith(siteB.origin), "nothing changed without confirmation");
    const confirmed = await r.call("PUT", "/api/docs-source", { sourceUrl: `${siteB.origin}/docs`, confirmChange: true });
    assert.equal(confirmed.status, 200);
    assert.equal(r.service.getConfig().origin, siteB.origin);
    assert.equal(confirmed.body.documents, 3, "indexed pages are kept");
  });

  it("after a source change the crawler never requests URLs of the old source", async () => {
    const { r, site } = await setup();
    await r.runSync("full");
    const siteB = await startSite({ "/docs": { text: "Site B overview text here." } });
    sites.push(siteB);
    await r.call("PUT", "/api/docs-source", { sourceUrl: `${siteB.origin}/docs`, confirmChange: true });
    site.hits.length = 0;
    const status = await r.runSync("full");
    assert.equal(site.hits.length, 0, `old source was contacted: ${site.hits.join(",")}`);
    assert.ok(siteB.hits.includes("/docs"));
    assert.equal(status.lastRun?.counts.added, 1);
    const logs = (await r.call("GET", "/api/sync/logs?limit=50")).body.logs as Array<{ message: string }>;
    assert.ok(logs.some((l) => /different documentation source/.test(l.message)));
  });

  it("cannot change the source while a sync is running", async () => {
    const { r, site } = await setup({ ...defaultPages(), "/docs": { text: "Slow overview page text.", links: ["/docs/alpha"], delayMs: 300 } });
    assert.equal((await r.call("POST", "/api/sync/start", { mode: "full" })).status, 202);
    const other = await startSite();
    sites.push(other);
    const res = await r.call("PUT", "/api/docs-source", { sourceUrl: `${other.origin}/docs` });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "busy");
    await r.service.whenIdle();
    assert.equal(r.service.getConfig().origin, site.origin);
  });

  it("sync settings: interval is validated, auto toggle persists", async () => {
    rig = createSyncRig();
    assert.equal((await rig.call("PUT", "/api/sync/settings", { intervalMinutes: 1 })).status, 400);
    assert.equal((await rig.call("PUT", "/api/sync/settings", { intervalMinutes: 30, autoEnabled: true })).status, 200);
    const read = await rig.call("GET", "/api/sync/settings");
    assert.deepEqual(read.body, { autoEnabled: true, intervalMinutes: 30, schedulePaused: false });
    assert.equal((await rig.call("PUT", "/api/sync/settings", "nope")).status, 400);
  });

  it("incremental, full and retry modes behave differently on a real site", async () => {
    const { r, site } = await setup();
    await r.runSync("full");
    site.hits.length = 0;
    const inc = await r.runSync("incremental");
    assert.equal(inc.lastRun?.mode, "incremental");
    assert.equal(inc.lastRun?.counts.added, 0);
    site.pages["/docs/alpha"] = { text: "Alpha page changed text.", status: 503 };
    const failed = await r.runSync("full");
    assert.equal(failed.lastRun?.counts.failed, 1);
    assert.equal(failed.totals.failedOutstanding, 1);
    assert.equal((await r.call("POST", "/api/sync/start", { mode: "retry" })).status, 202);
    await r.service.whenIdle();
    assert.equal(r.service.getStatus().totals.failedOutstanding, 1, "still failing");
    site.pages["/docs/alpha"] = { text: "Alpha page recovered text." };
    const retried = await r.runSync("retry");
    assert.equal(retried.lastRun?.mode, "retry");
    assert.equal(retried.totals.failedOutstanding, 0);
  });

  it("retry with nothing failed answers 409 with a message", async () => {
    rig = createSyncRig();
    const res = await rig.call("POST", "/api/sync/start", { mode: "retry" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "There are no failed documents to retry.");
  });

  it("logs come from the real run and can be limited", async () => {
    const { r } = await setup();
    await r.runSync("full");
    const all = (await r.call("GET", "/api/sync/logs?limit=200")).body.logs as Array<{ message: string; level: string }>;
    assert.ok(all.length >= 4);
    assert.ok(all.some((l) => /New page added/.test(l.message)));
    assert.equal(((await r.call("GET", "/api/sync/logs?limit=2")).body.logs as unknown[]).length, 2);
  });
});
