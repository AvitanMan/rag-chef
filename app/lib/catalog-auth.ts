import { hostedMode, isPlatformAdminRequest, requireIdentity, emailAllowed, householdError, HouseholdAuthError, requireSameOrigin, initializeHouseholdRuntime } from "./household";
/** Shared admin boundary: CLI requests have no Origin; browser writes must be same-origin. */
export async function authorizeCatalogRequest(request: Request): Promise<Response | null> {
  await initializeHouseholdRuntime();
  if (hostedMode()) {
    try {
      requireSameOrigin(request);
      if (isPlatformAdminRequest(request)) return null;
      const identity = await requireIdentity(request);
      if (!emailAllowed(identity.user.email, "PLATFORM_ADMIN_EMAILS")) throw new HouseholdAuthError("PLATFORM_ADMIN_REQUIRED", "Platform administrator access is required.");
      return null;
    } catch (error) { return householdError(error); }
  }
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
