/** Server-only household authorization. Browser input never selects a household. */
export interface HouseholdContext {
  mode: "local" | "hosted";
  userId: string;
  householdId: string;
  role: "owner" | "member";
  timezone: string;
  assistantEnabled: boolean;
  /** Internal session identity, rechecked by atomic writes. Never sent to clients. */
  sessionId?: string;
  localAccess?: { sessionId: string; credentialVersion: string; origin: string };
  localCli?: boolean;
}

export class HouseholdAuthError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 403) {
    super(message); this.name = "HouseholdAuthError";
  }
}

type Bindings = Record<string, unknown> & { DB?: D1Database };
let runtimeBindings: Bindings | undefined;
export function configureHouseholdRuntime(bindings: object): void { runtimeBindings = bindings as Bindings; }
/** Vinext development can dispatch routes without the production Worker entry. */
export async function initializeHouseholdRuntime(): Promise<void> {
  if (runtimeBindings) return;
  try { configureHouseholdRuntime((await import("cloudflare:workers")).env); }
  catch { /* Node source tests use process.env or an explicitly injected binding. */ }
}
export function householdSetting(name: string): string {
  const value = runtimeBindings?.[name] ?? (typeof process !== "undefined" ? process.env[name] : undefined);
  return typeof value === "string" ? value.trim() : "";
}
export function hostedMode(): boolean { return householdSetting("RAG_CHEF_HOSTED") === "1"; }
export function secureLanMode(): boolean { return !hostedMode() && householdSetting("RAG_CHEF_LAN_AUTH") === "1"; }

/** Exact private IPv4 origins or HTTPS mDNS names only. Never trust forwarded
 * headers, wildcard bind addresses, or the client's supplied Origin as a host. */
export function standaloneLanOrigins(value: string): string[] {
  return [...new Set(value.split(",").flatMap(entry => {
    const match = entry.trim().match(/^(https?):\/\/([^/:]+):([1-9]\d{0,4})$/i);
    if (!match || Number(match[3]) > 65535) return [];
    const hostname = match[2].toLowerCase();
    if (match[1].toLowerCase() === "https" && hostname.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/.test(hostname)) return [new URL(entry.trim()).origin];
    const octets = hostname.split(".");
    if (octets.length !== 4 || octets.some(part => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return [];
    const [first, second] = octets.map(Number);
    if (!(first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168)) return [];
    return [new URL(entry.trim()).origin];
  }))];
}

export function requireLocalRequest(request: Request): void {
  if (hostedMode()) return;
  const url = new URL(request.url);
  if (secureLanMode() && url.protocol !== "https:") throw new HouseholdAuthError("LAN_HTTPS_REQUIRED", "Open this kitchen using its configured HTTPS address.");
  const allowed = standaloneLanOrigins(householdSetting("RAG_CHEF_LAN_ORIGINS")).includes(url.origin);
  if (!allowed && (secureLanMode() || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new HouseholdAuthError("HOSTED_NOT_CONFIGURED", "Standalone kitchens require loopback access or an explicitly configured private LAN origin in RAG_CHEF_LAN_ORIGINS. Public access requires hosted sign-in.", 503);
  }
}

/** Browser access uses an opaque session cookie; explicit CLI calls may use Basic. */
export async function requireSecureLanAccess(request: Request): Promise<HouseholdContext["localAccess"] | null> {
  if (!secureLanMode()) return null;
  const { requireLocalAccess } = await import("./local-auth");
  return requireLocalAccess(request);
}
export async function householdDb(): Promise<D1Database> {
  const binding = runtimeBindings?.DB ?? ((await import("cloudflare:workers")).env as unknown as Bindings).DB;
  if (!binding) {
    if (!hostedMode()) throw new Error("The kitchen D1 binding is unavailable.");
    throw new HouseholdAuthError("HOSTED_UNAVAILABLE", "The household database is unavailable.", 503);
  }
  return binding;
}
export function localHousehold(): HouseholdContext {
  return { mode: "local", userId: "local-user", householdId: "local-household", role: "owner", timezone: "UTC", assistantEnabled: true };
}
export function emailAllowed(email: string, key: string): boolean {
  return householdSetting(key).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).includes(email.toLowerCase());
}
export function requireSameOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site" || ((hostedMode() || secureLanMode()) && !origin)) {
    throw new HouseholdAuthError("CROSS_ORIGIN_WRITE", "A same-origin request is required.");
  }
}
export function requireOwner(context: HouseholdContext): void {
  if (context.role !== "owner") throw new HouseholdAuthError("OWNER_REQUIRED", "Only the household owner can change this setting.");
}
export function householdError(error: unknown): Response {
  const known = error instanceof HouseholdAuthError;
  return Response.json({ error: { code: known ? error.code : "HOUSEHOLD_UNAVAILABLE", message: known ? error.message : "The household is temporarily unavailable." } }, { status: known ? error.status : 503, headers: { "Cache-Control": "no-store", ...(known && "retryAfter" in error && typeof error.retryAfter === "number" ? { "Retry-After": String(error.retryAfter) } : {}) } });
}

export async function requireIdentity(request: Request) {
  await initializeHouseholdRuntime();
  const { getAuth } = await import("./auth");
  const session = await (await getAuth()).api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (!session) throw new HouseholdAuthError("SIGN_IN_REQUIRED", "Sign in with Google to continue.", 401);
  if (!session.user.emailVerified) throw new HouseholdAuthError("VERIFIED_EMAIL_REQUIRED", "A verified Google email is required.");
  const expectedActor = request.headers.get("x-rag-chef-actor");
  if (expectedActor && expectedActor !== session.user.id) throw new HouseholdAuthError("SESSION_SCOPE_CHANGED", "The signed-in account changed. Refresh before continuing.");
  return session;
}
export type Membership = { id: string; name: string; role: "owner" | "member"; timezone: string; assistantEnabled: number };
export async function membershipFor(userId: string): Promise<Membership | null> {
  return (await householdDb()).prepare(`SELECT o.id, o.name, m.role, h.timezone, h.assistantEnabled FROM member m JOIN organization o ON o.id=m.organizationId JOIN household_settings h ON h.organizationId=o.id WHERE m.userId=?`).bind(userId).first<Membership>();
}
export async function requireHousehold(request: Request): Promise<HouseholdContext> {
  await initializeHouseholdRuntime();
  if (!hostedMode()) {
    if (!request) {
      if (secureLanMode()) throw new HouseholdAuthError("LAN_SIGN_IN_REQUIRED", "Sign in to your kitchen to continue.", 401);
      return localHousehold();
    }
    requireLocalRequest(request); requireSameOrigin(request);
    const access = await requireSecureLanAccess(request);
    return { ...localHousehold(), ...(secureLanMode() ? access ? { localAccess: access } : { localCli: true } : {}) };
  }
  requireSameOrigin(request);
  const session = await requireIdentity(request);
  const membership = await membershipFor(session.user.id);
  if (!membership) throw new HouseholdAuthError("HOUSEHOLD_REQUIRED", "Create a household or accept an invitation to continue.");
  if (!["owner", "member"].includes(membership.role)) throw new HouseholdAuthError("MEMBERSHIP_REQUIRED", "A valid household membership is required.");
  const expectedHousehold = request.headers.get("x-rag-chef-household");
  if (expectedHousehold && expectedHousehold !== membership.id) throw new HouseholdAuthError("SESSION_SCOPE_CHANGED", "The active household changed. Refresh before continuing.");
  return { mode: "hosted", userId: session.user.id, householdId: membership.id, role: membership.role, timezone: membership.timezone, assistantEnabled: Boolean(membership.assistantEnabled), sessionId: session.session.id };
}

export async function validateHouseholdContext(context?: HouseholdContext): Promise<HouseholdContext> {
  await initializeHouseholdRuntime();
  if (!hostedMode()) {
    if (secureLanMode()) {
      if (!context || context.mode !== "local") throw new HouseholdAuthError("LAN_SIGN_IN_REQUIRED", "Sign in to your kitchen to continue.", 401);
      const { validateLocalContext } = await import("./local-auth");
      await validateLocalContext(context); return context;
    }
    return context?.mode === "hosted" ? context : localHousehold();
  }
  if (!context || context.mode !== "hosted" || !context.sessionId) throw new HouseholdAuthError("SIGN_IN_REQUIRED", "An authenticated household context is required.", 401);
  const row = await (await householdDb()).prepare(`SELECT m.role,h.timezone,h.assistantEnabled FROM member m JOIN session s ON s.userId=m.userId JOIN user u ON u.id=m.userId JOIN household_settings h ON h.organizationId=m.organizationId WHERE m.userId=? AND m.organizationId=? AND s.id=? AND s.expiresAt>? AND u.emailVerified=1`).bind(context.userId, context.householdId, context.sessionId, new Date().toISOString()).first<{ role: string; timezone: string; assistantEnabled: number }>();
  if (!row || row.role !== context.role || row.timezone !== context.timezone || Boolean(row.assistantEnabled) !== context.assistantEnabled) throw new HouseholdAuthError("MEMBERSHIP_CHANGED", "Your household access or settings changed. Refresh before continuing.", 403);
  return context;
}

const platformRequests = new WeakSet<Request>();
export function isPlatformAdminRequest(request: Request): boolean { return platformRequests.has(request); }
/** Central gate protects all existing and future API routes, including catalog reads. */
export async function authorizeApplicationRequest(request: Request): Promise<Response | null> {
  try {
    await initializeHouseholdRuntime();
    const path = new URL(request.url).pathname;
    if (secureLanMode()) {
      requireLocalRequest(request); requireSameOrigin(request);
      const read = request.method === "GET" || request.method === "HEAD";
      const publicRead = read && (path === "/" || path === "/api/session" || path === "/favicon.svg" || path === "/og.png" || /^\/assets\/[^/]+\.(?:js|css|woff2?|ttf|svg|png|webp)$/.test(path));
      const publicAction = request.method === "POST" && ["/api/local-auth/sign-in", "/api/local-auth/sign-out"].includes(path);
      if (publicRead || publicAction) return null;
      await requireSecureLanAccess(request);
    }
    if (!path.startsWith("/api/")) { if (secureLanMode()) requireSameOrigin(request); return null; }
    requireSameOrigin(request);
    if (!hostedMode()) { if (!path.startsWith("/api/admin/")) requireLocalRequest(request); return null; }
    const { validateHostedConfiguration } = await import("./auth");
    validateHostedConfiguration();
    if (path.startsWith("/api/auth/") || path === "/api/session") return null;
    if (path === "/api/household" && request.method === "POST" || path === "/api/household/invitations/accept") {
      await requireIdentity(request); return null;
    }
    if (path.startsWith("/api/admin/")) {
      const identity = await requireIdentity(request);
      if (!emailAllowed(identity.user.email, "PLATFORM_ADMIN_EMAILS")) throw new HouseholdAuthError("PLATFORM_ADMIN_REQUIRED", "Platform administrator access is required.");
      platformRequests.add(request); return null;
    }
    await requireHousehold(request);
    return null;
  } catch (error) { return householdError(error); }
}
