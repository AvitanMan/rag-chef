const base = process.env.RECIPES_APP_URL || "http://localhost:3000";
try {
  const response = await fetch(new URL("/api/admin/catalog", base), {
    method: "POST", headers: { "content-type": "application/json", ...(process.env.CATALOG_ADMIN_TOKEN ? { authorization: `Bearer ${process.env.CATALOG_ADMIN_TOKEN}` } : {}) },
    body: JSON.stringify({ embeddingsOnly: true }), signal: AbortSignal.timeout(300_000),
  });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok || !result.ok) process.exitCode = 1;
} catch (error) { console.error(`Embedding refresh failed: ${error.message}. Approved recipes remain saved; retry this command.`); process.exitCode = 1; }
