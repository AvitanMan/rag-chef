import { emailAllowed, householdDb, householdError, HouseholdAuthError, hostedMode, membershipFor, requireHousehold, requireIdentity, requireOwner, requireSameOrigin, requireLocalRequest, type HouseholdContext } from "./household";

export function householdJson(body: unknown, status = 200): Response { return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
export async function readHouseholdBody(request: Request): Promise<Record<string, unknown>> {
  requireSameOrigin(request);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new HouseholdAuthError("INVALID_BODY", "Send application/json.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new HouseholdAuthError("INVALID_BODY", "A request body is required.", 400);
  let text = "", size = 0;
  const decoder = new TextDecoder();
  while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 16_384) { await reader.cancel(); throw new HouseholdAuthError("BODY_TOO_LARGE", "The request is too large.", 413); } text += decoder.decode(chunk.value, { stream: true }); }
  let value: unknown; try { value = JSON.parse(text + decoder.decode()); } catch { throw new HouseholdAuthError("INVALID_BODY", "Send valid JSON.", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HouseholdAuthError("INVALID_BODY", "Send a JSON object.", 400);
  return value as Record<string, unknown>;
}
function hostedOnly(): void { if (!hostedMode()) throw new HouseholdAuthError("LOCAL_MODE", "Household sharing requires hosted mode.", 400); }
function nameValue(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.trim().length > 80) throw new HouseholdAuthError("INVALID_NAME", "Use a household name of 1 to 80 characters.", 400); return value.trim(); }
function timezoneValue(value: unknown): string { if (typeof value !== "string" || value.length > 80) throw new HouseholdAuthError("INVALID_TIMEZONE", "Choose a valid timezone.", 400); try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); } catch { throw new HouseholdAuthError("INVALID_TIMEZONE", "Choose a valid timezone.", 400); } return value; }
function emailValue(value: unknown): string { if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new HouseholdAuthError("INVALID_EMAIL", "Enter a valid email address.", 400); return value.trim().toLowerCase(); }
export function ownerPredicate(): string { return `EXISTS(SELECT 1 FROM member m JOIN session s ON s.userId=m.userId WHERE m.organizationId=? AND m.userId=? AND m.role='owner' AND s.id=? AND s.expiresAt>?)`; }
function ownerBindings(context: HouseholdContext): string[] { return [context.householdId, context.userId, context.sessionId ?? "", new Date().toISOString()]; }
async function ownerContext(request: Request): Promise<HouseholdContext> { hostedOnly(); requireSameOrigin(request); const context = await requireHousehold(request); requireOwner(context); return context; }

export async function sessionResponse(request: Request): Promise<Response> {
  if (!hostedMode()) { requireLocalRequest(request); return householdJson({ mode: "local", authenticated: true, platformAdmin: true, canCreateHousehold: false }); }
  try {
    const identity = await requireIdentity(request);
    const household = await membershipFor(identity.user.id);
    return householdJson({ mode: "hosted", authenticated: true, user: { id: identity.user.id, name: identity.user.name, email: identity.user.email }, household: household ? { ...household, assistantEnabled: Boolean(household.assistantEnabled) } : undefined, canCreateHousehold: !household && emailAllowed(identity.user.email, "HOUSEHOLD_OWNER_EMAILS"), platformAdmin: emailAllowed(identity.user.email, "PLATFORM_ADMIN_EMAILS") });
  } catch (error) { if (error instanceof HouseholdAuthError && error.status === 401) return householdJson({ mode: "hosted", authenticated: false, canCreateHousehold: false, platformAdmin: false }); return householdError(error); }
}
export async function readHousehold(request: Request): Promise<Response> {
  const context = await requireHousehold(request); hostedOnly();
  const db = await householdDb();
  const [household, members, invitations] = await Promise.all([
    membershipFor(context.userId),
    db.prepare(`SELECT m.id,m.userId,m.role,u.name,u.email FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=? ORDER BY m.createdAt,m.id`).bind(context.householdId).all(),
    context.role === "owner" ? db.prepare(`SELECT id,email,status,expiresAt FROM invitation WHERE organizationId=? ORDER BY createdAt DESC LIMIT 100`).bind(context.householdId).all() : Promise.resolve({ results: [] }),
  ]);
  return householdJson({ household: household ? { ...household, assistantEnabled: Boolean(household.assistantEnabled) } : null, members: members.results, invitations: invitations.results });
}
export async function createHousehold(request: Request): Promise<Response> {
  hostedOnly(); const body = await readHouseholdBody(request), identity = await requireIdentity(request);
  if (!emailAllowed(identity.user.email, "HOUSEHOLD_OWNER_EMAILS")) throw new HouseholdAuthError("OWNER_INVITATION_REQUIRED", "This account has not been invited to create a household.");
  if (await membershipFor(identity.user.id)) throw new HouseholdAuthError("ALREADY_MEMBER", "This account already belongs to a household.", 409);
  const name = nameValue(body.name), timezone = timezoneValue(body.timezone ?? "UTC"), id = crypto.randomUUID(), at = new Date().toISOString(), db = await householdDb();
  try { await db.batch([
    db.prepare(`INSERT INTO organization(id,name,slug,createdAt) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM session WHERE id=? AND userId=? AND expiresAt>?)`).bind(id, name, id, at, identity.session.id, identity.user.id, at),
    db.prepare(`INSERT INTO household_settings(organizationId,timezone,assistantEnabled) VALUES(?,?,0)`).bind(id, timezone),
    db.prepare(`INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,'owner',?)`).bind(crypto.randomUUID(), id, identity.user.id, at),
  ]); } catch { throw new HouseholdAuthError("HOUSEHOLD_CREATE_CONFLICT", "Your membership changed. Reload and try again.", 409); }
  return householdJson({ household: { id, name, role: "owner", timezone, assistantEnabled: false } }, 201);
}
export async function updateHousehold(request: Request): Promise<Response> {
  const context = await ownerContext(request), body = await readHouseholdBody(request), db = await householdDb();
  const statements: D1PreparedStatement[] = [];
  if (body.name !== undefined) statements.push(db.prepare(`UPDATE organization SET name=? WHERE id=? AND ${ownerPredicate()}`).bind(nameValue(body.name), context.householdId, ...ownerBindings(context)));
  if (body.timezone !== undefined) statements.push(db.prepare(`UPDATE household_settings SET timezone=? WHERE organizationId=? AND ${ownerPredicate()}`).bind(timezoneValue(body.timezone), context.householdId, ...ownerBindings(context)));
  if (body.assistantEnabled !== undefined) { if (typeof body.assistantEnabled !== "boolean") throw new HouseholdAuthError("INVALID_SETTING", "Assistant enabled must be true or false.", 400); statements.push(db.prepare(`UPDATE household_settings SET assistantEnabled=? WHERE organizationId=? AND ${ownerPredicate()}`).bind(Number(body.assistantEnabled), context.householdId, ...ownerBindings(context))); }
  if (!statements.length) throw new HouseholdAuthError("INVALID_SETTING", "Choose a household setting to update.", 400);
  const result = await db.batch(statements); if (result.some((item) => !item.meta.changes)) throw new HouseholdAuthError("MEMBERSHIP_CHANGED", "Your owner access changed.");
  return readHousehold(request);
}
export async function deleteHousehold(request: Request): Promise<Response> {
  const context = await ownerContext(request), db = await householdDb();
  const result = await db.prepare(`DELETE FROM organization WHERE id=? AND ${ownerPredicate()}`).bind(context.householdId, ...ownerBindings(context)).run();
  if (!result.meta.changes) throw new HouseholdAuthError("MEMBERSHIP_CHANGED", "Your owner access changed.");
  return householdJson({ ok: true });
}
export async function createInvitation(request: Request): Promise<Response> {
  const context = await ownerContext(request), body = await readHouseholdBody(request), email = emailValue(body.email), db = await householdDb(), at = new Date().toISOString();
  const id = crypto.randomUUID(), expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const result = await db.prepare(`INSERT INTO invitation(id,organizationId,email,role,status,expiresAt,createdAt,inviterId) SELECT ?,?,?,'member','pending',?,?,? WHERE ${ownerPredicate()} AND (SELECT count(*) FROM invitation WHERE organizationId=? AND status='pending' AND expiresAt>?)<50`).bind(id, context.householdId, email, expiresAt, at, context.userId, ...ownerBindings(context), context.householdId, at).run();
  if (!result.meta.changes) throw new HouseholdAuthError("INVITATION_UNAVAILABLE", "Invitation limit reached or owner access changed.", 409);
  return householdJson({ invitation: { id, email, expiresAt }, url: `${new URL(request.url).origin}/?invitation=${id}` }, 201);
}
export async function acceptInvitation(request: Request): Promise<Response> {
  hostedOnly(); const body = await readHouseholdBody(request), identity = await requireIdentity(request), db = await householdDb();
  if (typeof body.invitationId !== "string" || body.invitationId.length > 100) throw new HouseholdAuthError("INVALID_INVITATION", "A valid invitation is required.", 400);
  const id = body.invitationId, at = new Date().toISOString(), memberId = crypto.randomUUID();
  // D1 batches are transactional. The SELECT binds both the verified email and live session;
  // the unique userId constraint makes simultaneous invitations mutually exclusive.
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO member(id,organizationId,userId,role,createdAt) SELECT ?,i.organizationId,?,'member',? FROM invitation i WHERE i.id=? AND lower(i.email)=? AND i.status='pending' AND i.expiresAt>? AND EXISTS(SELECT 1 FROM session s JOIN user u ON u.id=s.userId WHERE s.id=? AND s.userId=? AND s.expiresAt>? AND u.emailVerified=1 AND lower(u.email)=lower(i.email)) AND (SELECT count(*) FROM member WHERE organizationId=i.organizationId)<20`).bind(memberId, identity.user.id, at, id, identity.user.email.toLowerCase(), at, identity.session.id, identity.user.id, at),
      db.prepare(`UPDATE invitation SET status='accepted' WHERE id=? AND EXISTS(SELECT 1 FROM member WHERE id=?)`).bind(id, memberId),
    ]);
    if (!results[0].meta.changes) throw new HouseholdAuthError("INVALID_INVITATION", "This invitation is expired, used, or belongs to a different verified email.", 409);
  } catch (error) { if (error instanceof HouseholdAuthError) throw error; throw new HouseholdAuthError("ALREADY_MEMBER", "This account already belongs to a household.", 409); }
  return readHousehold(request);
}
export async function revokeInvitation(request: Request, id: string): Promise<Response> {
  const context = await ownerContext(request), db = await householdDb();
  const result = await db.prepare(`UPDATE invitation SET status='canceled' WHERE id=? AND organizationId=? AND status='pending' AND ${ownerPredicate()}`).bind(id, context.householdId, ...ownerBindings(context)).run();
  if (!result.meta.changes) throw new HouseholdAuthError("INVITATION_NOT_FOUND", "No pending invitation was found.", 404);
  return householdJson({ ok: true });
}
export async function removeMember(request: Request, id: string): Promise<Response> {
  const context = await ownerContext(request), db = await householdDb();
  // Revoke earlier invitation links in the same transaction as membership.
  // Otherwise a removed member could immediately restore access with an old link.
  const results = await db.batch([
    db.prepare(`UPDATE invitation SET status='canceled' WHERE organizationId=? AND status='pending' AND lower(email) IN (SELECT lower(u.email) FROM member target JOIN user u ON u.id=target.userId WHERE target.id=? AND target.organizationId=? AND target.role='member') AND ${ownerPredicate()}`).bind(context.householdId, id, context.householdId, ...ownerBindings(context)),
    db.prepare(`DELETE FROM member WHERE id=? AND organizationId=? AND role='member' AND ${ownerPredicate()}`).bind(id, context.householdId, ...ownerBindings(context)),
  ]);
  if (!results[1].meta.changes) throw new HouseholdAuthError("MEMBER_NOT_FOUND", "No removable member was found.", 404);
  return householdJson({ ok: true });
}
