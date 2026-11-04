import { householdDb, householdSetting, HouseholdAuthError, requireLocalRequest, requireSameOrigin, secureLanMode, type HouseholdContext } from "./household";

export const LOCAL_SESSION_COOKIE = "__Host-rag-chef-local";
const SHORT_SECONDS = 12 * 60 * 60;
const REMEMBER_SECONDS = 30 * 24 * 60 * 60;
const THROTTLE_SECONDS = 15 * 60;
export type LocalAccess = { sessionId: string; expiresAt: string; remembered: boolean };
type SessionRow = { id: string; expires_at: number; remembered: number; credential_version: string; origin: string };
export type LocalSession = LocalAccess & { credentialVersion: string; origin: string };

function signInRequired(): never { throw new HouseholdAuthError("LAN_SIGN_IN_REQUIRED", "Sign in to your kitchen to continue.", 401); }
export async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
function configuredHash(): string {
  const value = householdSetting("RAG_CHEF_LAN_PASSWORD_SHA256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new HouseholdAuthError("LAN_AUTH_NOT_CONFIGURED", "Secure local access is not configured. Restart using the secure local launcher.", 503);
  return value;
}
export async function localCredentialVersion(): Promise<string> { return sha256(configuredHash()); }
function validCredentials(username: unknown, password: unknown): username is string {
  return typeof username === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(username) && typeof password === "string" && /^[\x21-\x7e]{6,128}$/.test(password);
}
async function credentialsMatch(username: unknown, password: unknown): Promise<boolean> {
  const expected = configuredHash();
  if (!validCredentials(username, password)) return false;
  const actual = await sha256(`${username}:${password}`);
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return difference === 0;
}
function tokenFrom(request: Request): string | null {
  const values = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${LOCAL_SESSION_COOKIE}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(LOCAL_SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
function sessionCookie(token: string, remembered: boolean, clear = false): string {
  return `${LOCAL_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict${clear ? "; Max-Age=0" : remembered ? `; Max-Age=${REMEMBER_SECONDS}` : ""}`;
}
function localOnly(request: Request) {
  if (!secureLanMode()) throw new HouseholdAuthError("LOCAL_SIGN_IN_DISABLED", "This kitchen does not use local password sign-in.", 404);
  requireLocalRequest(request);
  configuredHash();
}
async function localDb() {
  const db = await householdDb();
  try { await db.prepare("SELECT id FROM local_auth_sessions LIMIT 0").all(); await db.prepare("SELECT id FROM local_auth_attempts LIMIT 0").all(); }
  catch { throw new HouseholdAuthError("LAN_AUTH_MIGRATION_REQUIRED", "Local sign-in needs a database update. Run pnpm db:migrate on the kitchen computer, then restart it.", 503); }
  return db;
}
class LocalThrottleError extends HouseholdAuthError {
  constructor(public readonly retryAfter: number) { super("LAN_SIGN_IN_THROTTLED", "Too many sign-in attempts. Wait a few minutes, then try again.", 429); }
}
async function checkThrottle(db: D1Database, version: string, now: number): Promise<void> {
  const attempt = await db.prepare("SELECT failures, window_started FROM local_auth_attempts WHERE id=1 AND credential_version=?").bind(version).first<{ failures: number; window_started: number }>();
  if (attempt && attempt.window_started + THROTTLE_SECONDS * 1000 > now && attempt.failures >= 10) throw new LocalThrottleError(Math.ceil((attempt.window_started + THROTTLE_SECONDS * 1000 - now) / 1000));
}
async function authenticateCredentials(username: unknown, password: unknown): Promise<boolean> {
  const db = await localDb(), version = await localCredentialVersion(), now = Date.now();
  // Reserve capacity before testing the password. Counting only after a failed
  // comparison lets an unbounded parallel batch test guesses past the limit.
  // Pending checks count toward the limit until a successful check releases its
  // own reservation; failed checks retain it for the rest of the window.
  const row = await db.prepare("INSERT INTO local_auth_attempts(id,credential_version,window_started,failures) VALUES(1,?,?,1) ON CONFLICT(id) DO UPDATE SET failures=CASE WHEN credential_version<>excluded.credential_version OR window_started<=? THEN 1 ELSE failures+1 END, window_started=CASE WHEN credential_version<>excluded.credential_version OR window_started<=? THEN excluded.window_started ELSE window_started END, credential_version=excluded.credential_version WHERE credential_version<>excluded.credential_version OR window_started<=? OR failures<10 RETURNING failures,window_started").bind(version, now, now - THROTTLE_SECONDS * 1000, now - THROTTLE_SECONDS * 1000, now - THROTTLE_SECONDS * 1000).first<{ failures: number; window_started: number }>();
  if (!row) { await checkThrottle(db, version, Date.now()); throw new LocalThrottleError(THROTTLE_SECONDS); }
  if (!await credentialsMatch(username, password)) return false;
  // Valid CLI requests must not consume the failure budget, nor erase failures
  // made by other requests. A completed browser sign-in resets the window below.
  await db.prepare("UPDATE local_auth_attempts SET failures=MAX(0,failures-1) WHERE id=1 AND credential_version=? AND window_started=?").bind(version, row.window_started).run();
  return true;
}
export function isLocalCliRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith("/api/") && request.headers.get("x-rag-chef-client") === "cli" && !Array.from(request.headers.keys()).some(key => key.startsWith("sec-fetch-"));
}
export async function verifyLocalCli(request: Request): Promise<boolean> {
  if (!isLocalCliRequest(request)) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.length <= 1024 ? authorization.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i) : null;
  if (!match || match[1].length % 4 !== 0) return false;
  let credentials: string;
  try { credentials = atob(match[1]); } catch { return false; }
  if (btoa(credentials) !== match[1]) return false;
  const colon = credentials.indexOf(":");
  return colon > 0 && await authenticateCredentials(credentials.slice(0, colon), credentials.slice(colon + 1));
}
export async function readLocalSession(request: Request, requireScope = false): Promise<LocalSession | null> {
  localOnly(request);
  const token = tokenFrom(request);
  if (!token) return null;
  const version = await localCredentialVersion(), origin = new URL(request.url).origin;
  const row = await (await localDb()).prepare("SELECT id, expires_at, remembered, credential_version, origin FROM local_auth_sessions WHERE token_hash=? AND origin=? AND credential_version=? AND expires_at>?").bind(await sha256(token), origin, version, Date.now()).first<SessionRow>();
  if (!row) return null;
  const expected = request.headers.get("x-rag-chef-session");
  if ((requireScope && !expected) || (expected && expected !== row.id)) throw new HouseholdAuthError("SESSION_SCOPE_CHANGED", "Your kitchen sign-in changed. Sign in again before continuing.", 403);
  return { sessionId: row.id, expiresAt: new Date(row.expires_at).toISOString(), remembered: Boolean(row.remembered), credentialVersion: row.credential_version, origin: row.origin };
}
export async function requireLocalAccess(request: Request): Promise<LocalSession | null> {
  localOnly(request);
  if (await verifyLocalCli(request)) return null;
  const access = await readLocalSession(request, !["GET", "HEAD", "OPTIONS"].includes(request.method));
  return access ?? signInRequired();
}
export async function validateLocalContext(context: HouseholdContext): Promise<void> {
  if (context.localCli) return;
  const access = context.localAccess;
  if (!access || access.credentialVersion !== await localCredentialVersion()) signInRequired();
  const row = await (await localDb()).prepare("SELECT id FROM local_auth_sessions WHERE id=? AND credential_version=? AND origin=? AND expires_at>?").bind(access.sessionId, access.credentialVersion, access.origin, Date.now()).first();
  if (!row) signInRequired();
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new HouseholdAuthError("INVALID_CONTENT_TYPE", "Send application/json.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new HouseholdAuthError("INVALID_BODY", "Enter your kitchen username and password.", 400);
  let size = 0, body = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2048) { await reader.cancel(); throw new HouseholdAuthError("BODY_TOO_LARGE", "The sign-in request is too large.", 413); }
      body += decoder.decode(chunk.value, { stream: true });
    }
    const value: unknown = JSON.parse(body + decoder.decode());
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (error) { if (error instanceof HouseholdAuthError) throw error; }
  throw new HouseholdAuthError("INVALID_BODY", "Send a valid sign-in request.", 400);
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}) { return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", ...headers } }); }
function anonymous() { return { mode: "local", authenticated: false, localServer: { requiresPassword: true } }; }
export async function localSessionResponse(request: Request): Promise<Response> {
  localOnly(request);
  // Check schema even before a cookie exists, so missing migrations have an actionable message.
  await localDb();
  const session = await readLocalSession(request);
  if (!session && !await verifyLocalCli(request)) return json(anonymous());
  const { publicLocalServerConfig } = await import("./local-server-config");
  return json({ mode: "local", authenticated: true, platformAdmin: true, canCreateHousehold: false, localServer: publicLocalServerConfig(), ...(session ? { localAccess: { sessionId: session.sessionId, expiresAt: session.expiresAt, remembered: session.remembered } } : {}) });
}
export async function signInLocal(request: Request): Promise<Response> {
  localOnly(request); requireSameOrigin(request);
  const body = await readBody(request);
  if (body.remember !== undefined && typeof body.remember !== "boolean") throw new HouseholdAuthError("INVALID_BODY", "Choose whether to remember this device.", 400);
  const db = await localDb(), now = Date.now(), version = await localCredentialVersion();
  if (!await authenticateCredentials(body.username, body.password)) {
    return json({ error: { code: "LAN_INVALID_CREDENTIALS", message: "The username or password is incorrect. Try again." } }, 401);
  }
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const id = crypto.randomUUID(), remembered = body.remember === true, expires = now + (remembered ? REMEMBER_SECONDS : SHORT_SECONDS) * 1000;
  const previous = tokenFrom(request);
  await db.batch([
    db.prepare("DELETE FROM local_auth_sessions WHERE expires_at<=? OR credential_version<>? OR token_hash=?").bind(now, version, previous ? await sha256(previous) : ""),
    db.prepare("INSERT INTO local_auth_sessions(id,token_hash,origin,credential_version,created_at,expires_at,remembered) VALUES(?,?,?,?,?,?,?)").bind(id, await sha256(token), new URL(request.url).origin, version, now, expires, Number(remembered)),
    db.prepare("DELETE FROM local_auth_attempts WHERE id=1 AND credential_version=?").bind(version),
  ]);
  const { publicLocalServerConfig } = await import("./local-server-config");
  return json({ mode: "local", authenticated: true, platformAdmin: true, canCreateHousehold: false, localServer: publicLocalServerConfig(), localAccess: { sessionId: id, expiresAt: new Date(expires).toISOString(), remembered } }, 200, { "Set-Cookie": sessionCookie(token, remembered) });
}
export async function signOutLocal(request: Request): Promise<Response> {
  localOnly(request); requireSameOrigin(request);
  const session = await readLocalSession(request, true);
  if (session) await (await localDb()).prepare("DELETE FROM local_auth_sessions WHERE id=? AND origin=?").bind(session.sessionId, session.origin).run();
  return json(anonymous(), 200, { "Set-Cookie": sessionCookie("", false, true) });
}
