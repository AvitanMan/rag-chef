import http from "node:http";

export async function startModelStub() {
  let unavailable = false;
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    try {
      let input = "";
      for await (const chunk of request) input += chunk;
      const body = input ? JSON.parse(input) : {};
      if (request.url === "/__test/control") {
        if (request.method === "POST") { unavailable = Boolean(body.unavailable); if (body.resetCalls) calls.length = 0; }
        send(200, { unavailable, calls }); return;
      }
      calls.push({ path: request.url, body });
      if (unavailable) { send(503, { error: "Test provider is unavailable" }); return; }
      if (request.url === "/api/embed") { send(200, { embeddings: (Array.isArray(body.input) ? body.input : [body.input]).map(() => [1, 0, 0]) }); return; }
      if (request.url === "/api/tags") { send(200, { models: [{ name: "test-model" }] }); return; }
      if (request.url === "/api/chat") {
        const prompt = body.messages?.find((item) => item.role === "user")?.content ?? "";
        const context = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));
        const recipe = context.retrievedRecipes?.[0];
        send(200, { done: true, done_reason: "stop", message: { content: JSON.stringify({ answer: "This catalog recipe matches your request.", sourceFacts: [], chefChanges: [], recommendations: recipe ? [{ recipeId: recipe.recipeId, reason: "Matches the requested recipe." }] : [], warnings: [] }) } }); return;
      }
      send(404, { error: "Unknown test-provider endpoint" });
    } catch (error) { send(400, { error: error.message }); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
