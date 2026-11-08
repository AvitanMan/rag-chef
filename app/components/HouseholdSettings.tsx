"use client";

import { useEffect, useState } from "react";
import { useAppSession } from "../lib/app-session";

type Member = { id: string; userId: string; name: string; email: string; role: string };
type Invitation = { id: string; email: string; status: string; expiresAt: string | number };
export function HouseholdSettings() {
  const { session, refreshSession, signOut, fetch: kitchenFetch } = useAppSession();
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [name, setName] = useState(session.household?.name ?? "");
  const [timezone, setTimezone] = useState(session.household?.timezone ?? "");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [deleteName, setDeleteName] = useState("");
  const owner = session.household?.role === "owner";
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await kitchenFetch("/api/household", { signal: controller.signal }); const result = await response.json() as { error?: { message?: string }; members?: Member[]; invitations?: Invitation[]; url?: string };
        if (!response.ok) throw new Error(result.error?.message ?? "Could not load family members.");
        if (!controller.signal.aborted) { setMembers(result.members ?? []); setInvitations(result.invitations ?? []); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load family members."); }
    })();
    return () => controller.abort();
  }, [reload, kitchenFetch]);
  async function change(url: string, method: string, body?: unknown) {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await kitchenFetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json() as { error?: { message?: string }; members?: Member[]; invitations?: Invitation[]; url?: string };
      if (!response.ok) throw new Error(result.error?.message ?? "The kitchen could not be updated.");
      if (result.url) { setLink(new URL(result.url, window.location.origin).href); setEmail(""); }
      setMessage("Kitchen settings updated."); setReload(value => value + 1); await refreshSession();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The kitchen could not be updated."); }
    finally { setBusy(false); }
  }
  return <section className="panel settings-panel wide-panel" aria-label="Shared kitchen settings">
    <div className="section-heading"><div><span className="eyebrow">Family kitchen</span><h2>{session.household?.name}</h2><p>Signed in as {session.user?.email} · {owner ? "Owner" : "Member"}</p></div><button className="secondary-button" disabled={busy} onClick={() => void signOut()}>Sign out</button></div>
    <p>Pantry, dinners, shopping, and applied changes are shared. Conversations, drafts, and AI keys are personal.</p>
    {owner && <><div className="form-grid"><label>Kitchen name<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label><label>Household timezone<input value={timezone} onChange={event => setTimezone(event.target.value)} /></label></div><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => void change("/api/household", "PATCH", { name, timezone })}>Save household details</button><button className="secondary-button" disabled={busy} onClick={() => void change("/api/household", "PATCH", { assistantEnabled: !session.household?.assistantEnabled })}>{session.household?.assistantEnabled ? "Disable" : "Enable"} assistant beta</button></div></>}
    <h3>Members</h3><ul className="household-members">{members.map(member => <li key={member.id}><span><strong>{member.name || member.email}</strong> · {member.role}</span>{owner && member.userId !== session.user?.id && member.role !== "owner" && <button className="text-button" disabled={busy} onClick={() => void change(`/api/household/members/${encodeURIComponent(member.id)}`, "DELETE")}>Remove {member.name || member.email}</button>}</li>)}</ul>
    {owner && <><form onSubmit={event => { event.preventDefault(); void change("/api/household/invitations", "POST", { email }); }}><label>Invite by Google email<input type="email" required value={email} onChange={event => setEmail(event.target.value)} /></label><button className="secondary-button" disabled={busy || !email.trim()}>Create invitation link</button></form>{link && <label>Share this invitation with the invited person<input readOnly value={link} onFocus={event => event.target.select()} /><button className="text-button" onClick={() => { void navigator.clipboard.writeText(link).then(() => setMessage("Invitation link copied.")).catch(() => setMessage("Select and copy the invitation link above.")); }}>Copy invitation</button></label>}
      {!!invitations.length && <><h3>Pending invitations</h3><ul>{invitations.filter(item => item.status === "pending").map(invitation => <li key={invitation.id}>{invitation.email} · expires {new Date(invitation.expiresAt).toLocaleDateString()} <button className="text-button" disabled={busy} onClick={() => void change(`/api/household/invitations/${encodeURIComponent(invitation.id)}`, "DELETE")}>Cancel invitation</button></li>)}</ul></>}
      <details><summary>Delete this household</summary><p>This removes its shared kitchen and memberships. Type the kitchen name to confirm.</p><label>Kitchen name to confirm deletion<input value={deleteName} onChange={event => setDeleteName(event.target.value)} /></label><button className="secondary-button" disabled={busy || deleteName !== session.household?.name} onClick={() => void change("/api/household", "DELETE")}>Delete household</button></details></>}
    {busy && <p role="status">Saving…</p>}{message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
