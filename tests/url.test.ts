import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createConfig } from "@/server/scraper/config";
import { isDocumentationUrl, normalizeUrl, resolveDocLink } from "@/server/scraper/url";

const config = createConfig({ startUrl: "https://dash.gtps.cloud/docs" });
const page = "https://dash.gtps.cloud/docs/player";

describe("normalizeUrl", () => {
  it("removes hash, trailing slash and tracking params", () => {
    assert.equal(
      normalizeUrl("https://Dash.GTPS.cloud/docs/player/?utm_source=x#top"),
      "https://dash.gtps.cloud/docs/player",
    );
  });
  it("sorts query parameters so equivalent URLs match", () => {
    assert.equal(normalizeUrl("https://a.test/d?b=2&a=1"), normalizeUrl("https://a.test/d?a=1&b=2"));
  });
  it("keeps the root slash", () => {
    assert.equal(normalizeUrl("https://a.test/"), "https://a.test/");
  });
  it("rejects invalid and non-http URLs", () => {
    assert.equal(normalizeUrl("not a url"), null);
    assert.equal(normalizeUrl("ftp://a.test/x"), null);
  });
  it("resolves relative URLs against a base", () => {
    assert.equal(normalizeUrl("../docs/world", page), "https://dash.gtps.cloud/docs/world");
  });
});

describe("isDocumentationUrl / resolveDocLink", () => {
  it("accepts the docs root and pages below it", () => {
    assert.ok(isDocumentationUrl("https://dash.gtps.cloud/docs", config));
    assert.ok(isDocumentationUrl("https://dash.gtps.cloud/docs/shop-item", config));
  });
  it("rejects other origins and sibling paths", () => {
    assert.ok(!isDocumentationUrl("https://gtps.cloud/docs/player", config));
    assert.ok(!isDocumentationUrl("https://dash.gtps.cloud/docsets", config));
    assert.ok(!isDocumentationUrl("https://dash.gtps.cloud/login", config));
  });
  it("rejects static asset URLs", () => {
    assert.ok(!isDocumentationUrl("https://dash.gtps.cloud/docs/logo.png", config));
  });
  it("resolves relative links and drops anchors / mailto / javascript", () => {
    assert.equal(resolveDocLink("/docs/world", page, config), "https://dash.gtps.cloud/docs/world");
    assert.equal(resolveDocLink("world", page, config), "https://dash.gtps.cloud/docs/world");
    assert.equal(resolveDocLink("#methods", page, config), null);
    assert.equal(resolveDocLink("mailto:a@b.c", page, config), null);
    assert.equal(resolveDocLink("javascript:void(0)", page, config), null);
    assert.equal(resolveDocLink("https://discord.gg/x", page, config), null);
  });
});
