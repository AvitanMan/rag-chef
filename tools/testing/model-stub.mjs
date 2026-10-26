import http from "node:http";

export async function startModelStub() {
  let unavailable = false;
  let mode = "valid";
  let pending = [];
  const release = () => { const waiting = pending; pending = []; for (const resolve of waiting) resolve(); };
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    try {
      let input = "";
      for await (const chunk of request) input += chunk;
      const body = input ? JSON.parse(input) : {};
      if (request.url === "/__test/control") {
        if (request.method === "POST") { unavailable = Boolean(body.unavailable); mode = body.mode ?? "valid"; if (body.resetCalls) calls.length = 0; if (body.release) release(); }
        send(200, { unavailable, mode, pending: pending.length, calls }); return;
      }
      calls.push({ path: request.url, body });
      if (unavailable) { send(503, { error: "Test provider is unavailable" }); return; }
      if (request.url === "/api/embed") { send(200, { embeddings: (Array.isArray(body.input) ? body.input : [body.input]).map(() => [1, 0, 0]) }); return; }
      if (request.url === "/api/tags") { send(200, { models: [{ name: "test-model" }] }); return; }
      if (request.url === "/api/chat") {
        if (mode === "hold") await new Promise((resolve) => pending.push(resolve));
        const prompt = body.messages?.find((item) => item.role === "user")?.content ?? "";
        const context = JSON.parse(prompt.startsWith("{") ? prompt : prompt.slice(prompt.lastIndexOf("\n\n") + 2));
        if (context.task === "verify_recipe_answer") {
          if (mode === "verification_hold") await new Promise((resolve) => pending.push(resolve));
          if (mode === "verification_unavailable") { send(503, { error: "Verification unavailable" }); return; }
          const sentences = context.sentences.map((claim) => ({ id: claim.id, verdict: ["verification_reject", "unverified_cause"].includes(mode) ? "unsupported" : "supported", supportRefs: mode === "mixed_help" ? context.evidence.filter(item => ["I1", "S1"].includes(item.evidenceId) || item.ref === "K1").map(item => item.ref) : [context.evidence.find(item => !claim.recipeId || item.recipeId === claim.recipeId).ref] }));
          send(200, { done: true, done_reason: "stop", message: { content: JSON.stringify({ sentences }) } }); return;
        }
        const recipe = context.retrievedRecipes?.[0];
        const evidenceSchema = body.format?.properties?.sourceFacts?.items?.properties?.evidenceId;
        const sourceFacts = recipe && evidenceSchema && mode !== "unsupported" ? (mode === "mixed_help" ? ["I1", "S1"] : [mode === "invalid_evidence" ? "I999" : "I1"]).map(evidenceId => ({ recipeId: recipe.recipeId, evidenceId })) : [];
        const chefChanges = recipe && (context.requestIntent?.adaptationDiets?.includes("vegan") || mode === "replacement_advice" && context.adaptationRequested) ? [{ recipeId: recipe.recipeId, change: "Consider a plant-based cheese substitute.", reason: "An advisory adaptation; original source ingredients are unchanged." }] : [];
        const amount = context.savedDinnerAmounts?.[0];
        const unsafeStatus = mode === "unsafe_clarification" ? "needs_clarification" : mode === "unsafe_unsupported" ? "unsupported" : undefined;
        const answer = mode === "unverified_cause" || unsafeStatus ? "Rinsing makes rice manufacture chlorophyll. Which pot do you use?" : mode === "unsupported" ? "The source does not establish this answer." : mode === "unverified_detail" ? "Cook for 99 minutes at 250°C." : mode === "mixed_help" && amount ? `Use ${amount.measure} ${amount.name}. ${recipe.evidence.find(item => item.evidenceId === "S1").text}` : "This catalog recipe matches your request.";
        send(200, { done: true, done_reason: "stop", message: { content: JSON.stringify({ answer, ...(body.format?.properties?.answerStatus ? { answerStatus: unsafeStatus ?? (mode === "unsupported" ? "unsupported" : "answered") } : {}), sourceFacts, chefChanges, recommendations: (context.retrievedRecipes ?? []).slice(0, body.format?.properties?.recommendations?.maxItems ?? 1).map(row => ({ recipeId: row.recipeId, reason: "Matches the requested recipe." })), warnings: unsafeStatus ? ["Rinsing manufactures chlorophyll."] : [] }) } }); return;
      }
      send(404, { error: "Unknown test-provider endpoint" });
    } catch (error) { send(400, { error: error.message }); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => { release(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); } };
}
