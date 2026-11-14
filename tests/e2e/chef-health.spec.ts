import { test, expect } from "@playwright/test";

const modelURL = process.env.RAG_CHEF_TEST_MODEL_URL;
if (!modelURL || new URL(modelURL).hostname !== "127.0.0.1") throw new Error("Use the disposable model stub through pnpm test:e2e.");

async function modelCalls(): Promise<Array<{ path: string }>> {
  const response = await fetch(`${modelURL}/__test/control`);
  expect(response.ok).toBeTruthy();
  return (await response.json() as { calls: Array<{ path: string }> }).calls;
}

async function control(values: { mode?: string; resetCalls?: boolean; release?: boolean }) {
  const response = await fetch(`${modelURL}/__test/control`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values), signal: AbortSignal.timeout(3_000),
  });
  expect(response.ok).toBeTruthy();
}

test.beforeEach(async () => {
  await control({ resetCalls: true });
});
test.afterEach(async () => { await control({ release: true, resetCalls: true }); });

test("local health reaches the private Chef worker and reports actual model capabilities", async ({ request }) => {
  const before = await (await request.get("/api/kitchen")).json();
  const response = await request.get("/api/health?provider=ollama&model=test-model");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const health = await response.json();
  expect(health.ok).toBe(true);
  expect(health.providers.ollama.reachable).toBe(true);
  expect(health.providers.ollama.baseUrl).toBe(modelURL);
  expect(health.capabilities.generation).toMatchObject({ ready: true, model: "test-model" });
  expect(health.capabilities.verification).toMatchObject({ ready: true, model: "test-model" });
  expect(health.capabilities.embeddings.ready).toBe(false);
  expect((await modelCalls()).map(call => call.path)).toEqual(["/api/tags"]);
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
});

test("invalid health providers are rejected before probing or changing the kitchen", async ({ request }) => {
  const before = await (await request.get("/api/kitchen")).json();
  const response = await request.get("/api/health?provider=unsupported&model=test-model");
  expect(response.status()).toBe(400);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect((await response.json()).error.code).toBe("invalid_provider");
  expect(await modelCalls()).toEqual([]);
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
});

test("service readiness checks all private workers without model calls and public trace IDs cannot be chosen", async ({ request }) => {
  const before = await (await request.get("/api/kitchen")).json();
  const supplied = "11111111-1111-4111-8111-111111111111";
  const response = await request.get("/api/admin/services", { headers: { "x-request-id": supplied, "x-rag-chef-request-id": supplied } });
  expect(response.status(), await response.text()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const id = response.headers()["x-request-id"];
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(id).not.toBe(supplied);
  const report = await response.json();
  expect(report.ok).toBe(true);
  for (const service of ["gateway", "catalog", "chef"]) {
    expect(report.services[service]).toMatchObject({ ok: true, service, protocol: 1, controls: 1, schema: 9 });
  }
  expect(await modelCalls()).toEqual([]);
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
});

test("concurrent Chef requests share provider capacity and recover after held operations finish", async ({ request }) => {
  const before = await (await request.get("/api/kitchen")).json();
  const data = { query: "Tomato Rice", provider: "ollama" };
  await control({ mode: "hold", resetCalls: true });
  const pending = Promise.allSettled([
    request.post("/api/chef", { data, timeout: 15_000 }),
    request.post("/api/chef", { data, timeout: 15_000 }),
  ]);
  try {
    await expect.poll(async () => {
      const response = await fetch(`${modelURL}/__test/control`, { signal: AbortSignal.timeout(3_000) });
      return (await response.json() as { pending: number }).pending;
    }, { timeout: 5_000 }).toBe(2);
    const blocked = await request.post("/api/chef", { data, timeout: 5_000 });
    expect(blocked.status(), await blocked.text()).toBe(429);
    expect((await blocked.json()).error.code).toBe("service_busy");
    expect(Number(blocked.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
    expect((await modelCalls()).filter(call => call.path === "/api/chat")).toHaveLength(2);
  } finally {
    await control({ release: true });
    const completed = await pending;
    for (const result of completed) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") expect(result.value.status(), await result.value.text()).toBe(200);
    }
  }
  const recovered = await request.post("/api/chef", { data, timeout: 10_000 });
  expect(recovered.status(), await recovered.text()).toBe(200);
  expect((await recovered.json()).generation).toBe("ai");
  expect((await modelCalls()).filter(call => call.path === "/api/chat").length).toBeGreaterThan(2);
  expect(await (await request.get("/api/kitchen")).json()).toEqual(before);
});
