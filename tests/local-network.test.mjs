import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { localAuthRuntime } from "./helpers/local-auth-runtime.mjs";
const runtime = await localAuthRuntime();
const { household } = runtime;
after(() => runtime.close());
beforeEach(() => runtime.database.exec("DELETE FROM local_auth_attempts; DELETE FROM local_auth_sessions"));
const configure = origins => household.configureHouseholdRuntime({ RAG_CHEF_HOSTED: "0", RAG_CHEF_LAN_AUTH: "0", RAG_CHEF_LAN_PASSWORD_SHA256: "", RAG_CHEF_LAN_ORIGINS: origins });
const request = (origin, options = {}) => new Request(`${origin}/api/kitchen/state`, options);

const secureOrigin = "https://ragchef.local:3443";
const testCredentials = "chef:test-only-kitchen-password";
const passwordHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(testCredentials))), byte => byte.toString(16).padStart(2, "0")).join("");
const basic = credentials => `Basic ${btoa(credentials)}`;
const configureSecure = (extra = {}) => household.configureHouseholdRuntime({ DB: runtime.binding, RAG_CHEF_HOSTED: "0", RAG_CHEF_LAN_AUTH: "1", RAG_CHEF_LAN_PASSWORD_SHA256: passwordHash, RAG_CHEF_LAN_ORIGINS: `${secureOrigin},https://192.168.1.20:3443`, ...extra });


test("standalone remains loopback-only until an exact private LAN origin is configured", async () => {
  configure("");
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) assert.doesNotThrow(() => household.requireLocalRequest(request(origin)));
  for (const origin of ["http://192.168.1.20:3000", "http://10.1.2.3:3000", "https://example.com"]) {
    assert.throws(() => household.requireLocalRequest(request(origin)), /private LAN origin/);
    assert.equal((await household.authorizeApplicationRequest(request(origin))).status, 503);
  }
  configure("http://192.168.1.20:3000, https://10.1.2.3:4443");
  for (const origin of ["http://192.168.1.20:3000", "https://10.1.2.3:4443"]) {
    const context = await household.requireHousehold(request(origin));
    assert.equal(context.mode, "local"); assert.equal(context.householdId, "local-household");
    assert.equal(await household.authorizeApplicationRequest(request(origin)), null);
  }
  for (const origin of ["https://192.168.1.20:3000", "http://192.168.1.20:3001", "http://192.168.1.21:3000", "http://10.1.2.3:4443"]) assert.throws(() => household.requireLocalRequest(request(origin)), /private LAN origin/);
});

test("LAN origin configuration rejects public, ambiguous, wildcard, credential and path entries", () => {
  const invalid = [
    "http://8.8.8.8:3000", "http://172.15.1.2:3000", "http://172.32.1.2:3000", "http://169.254.1.2:3000", "http://100.64.0.1:3000", "http://0.0.0.0:3000",
    "http://127.0.0.1:3000", "http://localhost:3000", "http://kitchen.local:3000", "http://*.example.com:3000", "http://192.168.*.*:3000", "http://[fd00::1]:3000",
    "http://192.168.1.20", "http://192.168.1.20:0", "http://192.168.1.20:65536", "http://192.168.1.20:003000",
    "http://192.168.1.20:3000/", "http://192.168.1.20:3000/path", "http://192.168.1.20:3000?x=1", "http://192.168.1.20:3000#fragment", "http://user@192.168.1.20:3000",
    "http://192.168.001.20:3000", "http://3232235796:3000", "http://0xc0a80114:3000", "http://192.168.1.256:3000", "ftp://192.168.1.20:3000",
  ];
  for (const origin of invalid) assert.deepEqual(household.standaloneLanOrigins(origin), [], origin);
  assert.deepEqual(household.standaloneLanOrigins(" http://10.0.0.1:3000,https://172.16.0.1:4443,http://172.31.255.254:3000,http://192.168.1.20:3000,http://10.0.0.1:3000"), ["http://10.0.0.1:3000", "https://172.16.0.1:4443", "http://172.31.255.254:3000", "http://192.168.1.20:3000"]);
});

test("LAN writes retain the same-origin boundary and disabling sharing immediately closes access", async () => {
  const origin = "http://192.168.1.20:3000"; configure(origin);
  const allowed = request(origin, { method: "PUT", headers: { origin, "sec-fetch-site": "same-origin" } });
  assert.equal((await household.requireHousehold(allowed)).mode, "local");
  for (const headers of [{ origin: "https://evil.example" }, { origin: "http://192.168.1.20:3001" }, { origin: "null" }, { origin, "sec-fetch-site": "cross-site" }]) {
    const denied = request(origin, { method: "PUT", headers });
    await assert.rejects(household.requireHousehold(denied), error => error.code === "CROSS_ORIGIN_WRITE");
    assert.equal((await household.authorizeApplicationRequest(denied)).status, 403);
  }
  configure("");
  await assert.rejects(household.requireHousehold(allowed), error => error.code === "HOSTED_NOT_CONFIGURED");
});

test("configured LAN origins never bypass hosted sign-in", async () => {
  const origin = "http://192.168.1.20:3000";
  household.configureHouseholdRuntime({ RAG_CHEF_HOSTED: "1", RAG_CHEF_LAN_ORIGINS: origin });
  await assert.rejects(household.requireHousehold(request(origin)), error => error.code === "SIGN_IN_REQUIRED");
  const denied = await household.authorizeApplicationRequest(request(origin));
  assert.equal(denied.status, 401); assert.equal((await denied.json()).error.code, "SIGN_IN_REQUIRED");
  configure("");
});


test("HTTPS mDNS origins are exact and reject wildcard, public, malformed or HTTP names", () => {
  assert.deepEqual(household.standaloneLanOrigins("https://ragchef.local:3443,https://Kitchen.Home.local:4443"), [secureOrigin, "https://kitchen.home.local:4443"]);
  for (const origin of ["http://ragchef.local:3443", "https://ragchef.local.evil.com:3443", "https://*.local:3443", "https://ragchef.local.:3443", "https://-kitchen.local:3443", "https://kitchen-.local:3443", "https://local:3443", "https://ragchef.local:3443/path", "https://user@ragchef.local:3443", "https://ragchef.local:3443?x=1", "https://ragchef.local:3443#x", "https://ragchef.local", "https://ragchef.local:0"]) assert.deepEqual(household.standaloneLanOrigins(origin), [], origin);
});

test("secure LAN exposes only the login shell and authenticates API tooling without browser challenges", async () => {
  configureSecure();
  for (const path of ["/", "/?_rsc=opaque", "/api/session", "/favicon.svg", "/og.png", "/assets/app.js", "/assets/app.css"]) {
    assert.equal(await household.authorizeApplicationRequest(new Request(`${secureOrigin}${path}`)), null, path);
  }
  for (const path of ["/api/kitchen", "/api/admin/recipes/import", "/other", "/kitchen-sw.js", "/kitchen-shell.json", "/assets/data.json"]) {
    const denied = await household.authorizeApplicationRequest(new Request(`${secureOrigin}${path}`));
    assert.equal(denied.status, 401, path); assert.equal(denied.headers.get("WWW-Authenticate"), null); assert.equal(denied.headers.get("Cache-Control"), "no-store");
  }
  const headers = { authorization: basic(testCredentials), "x-rag-chef-client": "cli" };
  assert.equal(await household.authorizeApplicationRequest(request(secureOrigin, { headers })), null);
  for (const extra of [{ "sec-fetch-mode": "cors" }, { "sec-fetch-site": "same-origin" }, { "sec-fetch-dest": "empty" }]) {
    assert.equal((await household.authorizeApplicationRequest(request(secureOrigin, { headers: { ...headers, ...extra } }))).status, 401);
  }
  assert.equal((await household.authorizeApplicationRequest(new Request(`${secureOrigin}/private`, { headers }))).status, 401);
  await assert.rejects(household.requireHousehold(request(secureOrigin)), error => error.code === "LAN_SIGN_IN_REQUIRED");
  assert.equal((await household.requireHousehold(request(secureOrigin, { headers }))).localCli, true);
  configure("");
});

test("secure LAN rejects malformed credentials without leaking the password or stored hash", async () => {
  configureSecure();
  for (const authorization of ["", "Bearer ignored", "Basic !!!!", "Basic Y2hlZjph=", "Basic Y2hlZjph====", `Basic ${"Y".repeat(1024)}`, basic("wrong:test-only-kitchen-password"), basic("chef:wrong"), basic("chef:"), basic("chef:line\nbreak"), basic("chef:control\u0000")]) {
    const denied = await household.authorizeApplicationRequest(request(secureOrigin, { headers: { authorization } }));
    assert.equal(denied.status, 401); const body = await denied.text();
    assert.ok(!body.includes(testCredentials)); assert.ok(!body.includes(passwordHash));
  }
  for (const hash of ["", "malformed", "g".repeat(64), "0".repeat(63), "0".repeat(65)]) {
    configureSecure({ RAG_CHEF_LAN_PASSWORD_SHA256: hash });
    const denied = await household.authorizeApplicationRequest(request(secureOrigin, { headers: { authorization: basic(testCredentials), "x-rag-chef-client": "cli" } }));
    assert.equal(denied.status, 503); assert.equal((await denied.json()).error.code, "LAN_AUTH_NOT_CONFIGURED");
  }
  configure("");
});

test("secure LAN rejects protocol, host and forwarded-header bypasses even with valid credentials", async () => {
  configureSecure({ RAG_CHEF_LAN_ORIGINS: `${secureOrigin},http://192.168.1.20:3443` });
  for (const origin of ["http://ragchef.local:3443", "http://192.168.1.20:3443", "http://localhost:3443", "http://127.0.0.1:3443", "https://localhost:3443", "https://127.0.0.1:3443", "https://ragchef.local:3444", "https://other.local:3443", "https://example.com:3443"]) {
    const headers = { authorization: basic(testCredentials), "x-forwarded-proto": "https", "x-forwarded-host": "ragchef.local:3443", forwarded: "host=ragchef.local:3443;proto=https", "x-rag-chef-proxy-origin": secureOrigin };
    const denied = await household.authorizeApplicationRequest(request(origin, { headers }));
    assert.ok(denied && [403, 503].includes(denied.status), origin);
    await assert.rejects(household.requireHousehold(request(origin, { headers })), /HTTPS address|private LAN origin/);
  }
  configure("");
});

test("automatic Basic credentials cannot bypass same-origin protection for API or SSR writes", async () => {
  configureSecure();
  for (const path of ["/api/kitchen", "/api/admin/recipes/import"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const extra of [{}, { origin: "https://evil.example" }, { origin: "null" }, { origin: "http://ragchef.local:3443" }, { origin: secureOrigin, "sec-fetch-site": "cross-site" }]) {
        const denied = await household.authorizeApplicationRequest(new Request(`${secureOrigin}${path}`, { method, headers: { authorization: basic(testCredentials), ...extra } }));
        assert.equal(denied.status, 403, `${method} ${path}`); assert.equal((await denied.json()).error.code, "CROSS_ORIGIN_WRITE");
      }
      const allowed = new Request(`${secureOrigin}${path}`, { method, headers: { authorization: basic(testCredentials), "x-rag-chef-client": "cli", origin: secureOrigin } });
      assert.equal(await household.authorizeApplicationRequest(allowed), null);
    }
  }
  await assert.rejects(household.requireHousehold(request(secureOrigin, { method: "POST", headers: { authorization: basic(testCredentials), "x-rag-chef-client": "cli" } })), error => error.code === "CROSS_ORIGIN_WRITE");
  configure("");
});

test("secure LAN settings do not replace hosted authentication or alter normal loopback development", async () => {
  configureSecure({ RAG_CHEF_HOSTED: "1", RAG_CHEF_LAN_PASSWORD_SHA256: "invalid" });
  assert.equal(household.secureLanMode(), false);
  const denied = await household.authorizeApplicationRequest(request(secureOrigin, { headers: { authorization: basic(testCredentials), "x-rag-chef-client": "cli" } }));
  assert.equal(denied.status, 401); assert.equal(denied.headers.get("WWW-Authenticate"), null); assert.equal((await denied.json()).error.code, "SIGN_IN_REQUIRED");
  configure(""); assert.equal(household.secureLanMode(), false);
  assert.equal((await household.requireHousehold(request("http://localhost:3000", { method: "PUT" }))).mode, "local");
});

test("secure LAN accepts a configured admin login while the hash binds its username and password", async () => {
  const credentials = "admin:N6!qZ2";
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credentials))), byte => byte.toString(16).padStart(2, "0")).join("");
  configureSecure({ RAG_CHEF_LAN_PASSWORD_SHA256: hash });
  try {
    assert.equal(await household.authorizeApplicationRequest(request(secureOrigin, { headers: { authorization: basic(credentials), "x-rag-chef-client": "cli" } })), null);
    assert.equal((await household.requireHousehold(request(secureOrigin, { headers: { authorization: basic(credentials), "x-rag-chef-client": "cli" } }))).mode, "local");
    for (const invalid of ["chef:N6!qZ2", "Admin:N6!qZ2", "admin:other6", "admin:", ":N6!qZ2", "admin:line\nbreak"]) {
      const denied = await household.authorizeApplicationRequest(request(secureOrigin, { headers: { authorization: basic(invalid), "x-rag-chef-client": "cli" } }));
      assert.equal(denied.status, 401); assert.equal((await denied.json()).error.code, "LAN_SIGN_IN_REQUIRED");
    }
  } finally { configure(""); }
});

test("secure LAN rejects malformed credential fields even when their raw hash is configured", async () => {
  for (const credentials of [":N6!qZ2", "ad min:N6!qZ2", "admin\n:N6!qZ2", `${"a".repeat(65)}:N6!qZ2`, "admin:", "admin:short", "admin:line\nbreak", "admin:nul\u0000value", `admin:${"a".repeat(129)}`]) {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credentials))), byte => byte.toString(16).padStart(2, "0")).join("");
    configureSecure({ RAG_CHEF_LAN_PASSWORD_SHA256: hash });
    const denied = await household.authorizeApplicationRequest(request(secureOrigin, { headers: { authorization: basic(credentials), "x-rag-chef-client": "cli" } }));
    assert.equal(denied.status, 401); assert.equal((await denied.json()).error.code, "LAN_SIGN_IN_REQUIRED");
  }
  configure("");
});
