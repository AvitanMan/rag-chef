"use client";

import { useSyncExternalStore } from "react";

const KEY = "rag-chef-theme";
function systemTheme() { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new Event("kitchen-theme-change"));
}
function subscribe(notify: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const changeSystem = () => {
    try { if (localStorage.getItem(KEY)) return; } catch { /* System choice still works without storage. */ }
    applyTheme(systemTheme());
  };
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) applyTheme(event.newValue === "dark" || event.newValue === "light" ? event.newValue : systemTheme()); };
  window.addEventListener("kitchen-theme-change", notify);
  window.addEventListener("storage", storage);
  media.addEventListener("change", changeSystem);
  return () => { window.removeEventListener("kitchen-theme-change", notify); window.removeEventListener("storage", storage); media.removeEventListener("change", changeSystem); };
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme ?? systemTheme(), () => "light");
  const dark = theme === "dark";
  return <button className="secondary-button theme-toggle" aria-label="Dark mode" aria-pressed={dark} title={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={() => {
    const next = dark ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch { /* The toggle also works for this visit when storage is unavailable. */ }
    applyTheme(next);
  }}><span aria-hidden="true">{dark ? "☀" : "☾"}</span><span className="theme-toggle-label">{dark ? "Light" : "Dark"}</span></button>;
}
