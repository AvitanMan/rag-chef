/** Shared admin boundary: CLI requests have no Origin; browser writes must be same-origin. */
export function authorizeCatalogRequest(request: Request): Response | null {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site")) {
    return denied("CROSS_ORIGIN_WRITE", "Cross-origin catalog writes are not allowed.", 403);
  }
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  const token = typeof process !== "undefined" ? process.env.CATALOG_ADMIN_TOKEN?.trim() : "";
  if (!token) return denied("CATALOG_ADMIN_NOT_CONFIGURED", "Catalog administration is disabled until CATALOG_ADMIN_TOKEN is set.", 503);
  if (request.headers.get("authorization") !== `Bearer ${token}`) return denied("UNAUTHORIZED", "A valid catalog administrator token is required.", 401);
  return null;
}

function denied(code: string, message: string, status: number) {
  return Response.json({ ok: false, error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}
