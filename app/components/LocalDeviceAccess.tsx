"use client";

import { useEffect, useState } from "react";
import { useAppSession, type AppSession } from "../lib/app-session";

function expiryLabel(expiresAt: string | undefined, timeZone: string): string | null {
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null;
  const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone };
  try { return new Intl.DateTimeFormat("en", options).format(new Date(expiresAt)); }
  catch { return new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" }).format(new Date(expiresAt)); }
}

/** The initial render uses UTC until the browser supplies its own time zone. */
export function LocalDeviceAccess() {
  const { session, signOut } = useAppSession();
  const [browser, setBrowser] = useState({ origin: "", timeZone: "UTC" });
  useEffect(() => {
    const timer = window.setTimeout(() => setBrowser({ origin: window.location.origin, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }), 0);
    return () => window.clearTimeout(timer);
  }, []);
  return <LocalDeviceAccessDetails session={session} origin={browser.origin} timeZone={browser.timeZone} signOut={() => void signOut()} />;
}

export function LocalDeviceAccessDetails({ session, origin = "", timeZone = "UTC", signOut }: { session: AppSession; origin?: string; timeZone?: string; signOut: () => void }) {
  if (session.mode !== "local" || !session.authenticated) return null;
  const protectedKitchen = Boolean(session.localServer?.requiresPassword);
  const access = session.localAccess;
  const expiry = expiryLabel(access?.expiresAt, timeZone);
  return <section className="panel settings-panel local-access-panel" aria-label="This device’s access">
    <span className="eyebrow">Devices &amp; access</span>
    <h2>{protectedKitchen ? "Your signed-in device" : "Your local kitchen"}</h2>
    {protectedKitchen ? <>
      <p><strong>{access ? access.remembered ? "Remembered on this browser" : "12-hour sign-in" : "Signed in on this browser"}</strong></p>
      {expiry && access ? <p>Sign-in ends <time dateTime={access.expiresAt}>{expiry}</time>.</p> : <p className="quantity-note">The sign-in end time is unavailable.</p>}
      {access && <p className="quantity-note">{access.remembered ? "This browser stays signed in for up to 30 days from sign-in. Using the kitchen does not extend that time." : "This sign-in lasts up to 12 hours. Your browser may end it sooner."}</p>}
    </> : <p>This kitchen is running locally on your computer.</p>}
    {origin && <label>This browser’s kitchen address<input readOnly value={origin} onFocus={event => event.currentTarget.select()} /></label>}
    {protectedKitchen && <>
      <p className="quantity-note">Use this same address when you return. A different kitchen address needs its own sign-in.</p>
      <p>Sign out when you finish on a shared device. Your saved pantry and dinners stay in the kitchen.</p>
      <button className="secondary-button" onClick={signOut}>Sign out of this device</button>
    </>}
  </section>;
}
