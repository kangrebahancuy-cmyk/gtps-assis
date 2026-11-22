/**
 * The access-password banner of a hosted deployment, in real Chromium, talking to the REAL auth handlers and the real
 * route guard (src/server/auth-api.ts, access.ts, hosting.ts): locked -> wrong password -> right password -> unlocked
 * (the cookie is really stored by the browser) -> reload keeps it -> lock. Plus "no password configured" and "local copy".
 * This is not Vercel: it proves the browser and handler logic, not a deployment.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";

import { handleAuthStatus, handleLogin, handleLogout, resetLoginLimiter } from "../../src/server/auth-api";
import { protectedRoute } from "../../src/server/hosting";
import { bundle, chromium, ROOT, serve, type TestSite } from "./support/browser";

const PASSWORD = "correct horse battery";
let env: Record<string, string | undefined> = { VERCEL: "1", GTPS_ACCESS_PASSWORD: PASSWORD };
let site: TestSite;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];

before(async () => {
  const routes = {
    "/api/auth/status": (e: typeof env) => protectedRoute(handleAuthStatus(e), { env: e }),
    "/api/auth/login": (e: typeof env) => protectedRoute(handleLogin(e), { env: e }),
    "/api/auth/logout": (e: typeof env) => protectedRoute(handleLogout(e), { env: e }),
  } as const;
  site = await serve(await bundle(join(ROOT, "tests/browser/entries/access-app.tsx")), [
    async (req, res) => {
      const make = routes[(req.url ?? "") as keyof typeof routes];
      if (!make) return false;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: req.method === "GET" ? undefined : Buffer.concat(chunks) });
      const response = await make(env)(request);
      const out: Record<string, string> = { "content-type": "application/json" };
      const cookie = response.headers.get("set-cookie");
      if (cookie) out["set-cookie"] = cookie;
      res.writeHead(response.status, out);
      res.end(await response.text());
      return true;
    },
  ]);
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await site.close();
});
const fresh = async () => {
  resetLoginLimiter();
  context = await browser.newContext();
  context.setDefaultTimeout(6000);
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(site.origin);
};
afterEach(async () => {
  await context.close();
  assert.deepEqual(errors, []);
  env = { VERCEL: "1", GTPS_ACCESS_PASSWORD: PASSWORD };
});

describe("access banner", () => {
  it("locked: asks for the password; a wrong one says so; the right one unlocks and the browser keeps the session across a reload; Lock signs out", async () => {
    await fresh();
    const banner = page.getByTestId("access-banner");
    await banner.getByText(/backend is locked/).waitFor();
    await page.getByLabel("Access password").fill("not it");
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /Wrong password/);

    await page.getByLabel("Access password").fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.getByText("Backend unlocked.").waitFor();
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === "gtps_session");
    assert.ok(session, "the browser stored the session cookie");
    assert.equal(session.httpOnly, true);
    assert.equal(session.sameSite, "Strict");
    assert.doesNotMatch(session.value, new RegExp(PASSWORD));
    assert.equal(await page.evaluate(() => document.cookie.includes("gtps_session")), false, "page scripts cannot read it");

    await page.reload();
    await page.getByText("Backend unlocked.").waitFor();

    await page.getByRole("button", { name: "Lock" }).click();
    await page.getByLabel("Access password").waitFor();
  });

  it("explains what the owner must do when no password is configured", async () => {
    env = { VERCEL: "1" };
    await fresh();
    await page.getByTestId("access-banner").getByText(/GTPS_ACCESS_PASSWORD/).waitFor();
    assert.equal(await page.getByLabel("Access password").count(), 0);
  });

  it("shows nothing on a local copy", async () => {
    env = {};
    await fresh();
    await page.getByTestId("page").waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.getByTestId("access-banner").count(), 0);
  });
});
