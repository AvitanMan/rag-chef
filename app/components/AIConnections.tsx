"use client";

import { useEffect, useRef, useState } from "react";
import { useAppSession } from "../lib/app-session";
import { listLocalModels, LOCAL_AI_KEY, localOllamaEndpoint, readLocalAI, testLocalModel, type AISelection } from "../lib/browser-ai";

export function AIConnections({ settings, setSettings }: { settings: AISelection; setSettings: (next: AISelection) => void }) {
  const { local: storage, fetch: kitchenFetch } = useAppSession();
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:11434");
  const [models, setModels] = useState<string[]>([]);
  const [key, setKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [lastFour, setLastFour] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    void (async () => {
      const local = readLocalAI(storage); if (local) setEndpoint(local.endpoint);
      try {
        const response = await kitchenFetch("/api/ai/connections/openai", { signal: current.signal });
        const result = await response.json() as { error?: { message?: string }; openai?: { configured?: boolean; lastFour?: string } };
        if (!response.ok) throw new Error(result.error?.message ?? "Could not load your AI connection.");
        if (!current.signal.aborted) { setConfigured(Boolean(result.openai?.configured)); setLastFour(result.openai?.lastFour ?? ""); }
      } catch (cause) { if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load connection status."); }
    })();
    return () => { current.abort(); controller.current?.abort(); };
  }, [storage, kitchenFetch]);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setBusy(true); setError(""); setNotice("");
    try { await action(current.signal); } catch (cause) { if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : "Connection failed."); }
    finally { if (!current.signal.aborted) setBusy(false); }
  }
  async function openai(method: string, body?: unknown, suffix = "") {
    const response = await kitchenFetch(`/api/ai/connections/openai${suffix}`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.current?.signal });
    const result = await response.json() as { error?: { message?: string }; openai?: { configured?: boolean; lastFour?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? "Your OpenAI connection could not be updated.");
    return result;
  }
  return <section className="panel settings-panel wide-panel" aria-label="Your AI connections">
    <div className="section-heading"><div><span className="eyebrow">Your AI</span><h2>Connect your assistant</h2><p>Connections belong to you. Family members use their own models or keys.</p></div></div>
    <div className="provider-grid"><button type="button" className={`provider-card ${settings.provider === "ollama" ? "selected" : ""}`} aria-pressed={settings.provider === "ollama"} onClick={() => setSettings({ ...settings, provider: "ollama" })}><strong>Local Ollama</strong><small>This computer · no API key</small></button><button type="button" className={`provider-card ${settings.provider === "openai" ? "selected" : ""}`} aria-pressed={settings.provider === "openai"} onClick={() => setSettings({ ...settings, provider: "openai" })}><strong>OpenAI</strong><small>Your key · usage billed to you</small></button></div>
    <p className="quantity-note">Active: {settings.provider === "ollama" ? `Local Ollama · ${settings.ollamaModel}` : `OpenAI · ${settings.openaiModel}`}. Chef never switches providers automatically.</p>
    {settings.provider === "ollama" ? <>
      <p>Use desktop Chrome or Edge on the computer running Ollama. Connect grants this site access to your local model; nothing is installed by RAG Chef.</p>
      <details><summary>Allow this website in Ollama</summary><p>Set <code>OLLAMA_ORIGINS</code> to <code>{typeof window !== "undefined" ? window.location.origin : "this website’s HTTPS origin"}</code>, then restart Ollama. Keep its default loopback binding. Allow local-network access when your browser asks.</p><a href="https://docs.ollama.com/faq" target="_blank" rel="noreferrer">Ollama setup instructions</a></details>
      <label>Ollama on this computer<input value={endpoint} onChange={event => setEndpoint(event.target.value)} spellCheck={false} /></label>
      <div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => void run(async signal => { const found = await listLocalModels(endpoint, signal); setModels(found); if (found.length && !found.includes(settings.ollamaModel)) setSettings({ ...settings, ollamaModel: found[0] }); setNotice(found.length ? "Connected. Choose a model, then test and save it." : "Ollama is running but has no installed models. Install a model in Ollama, then connect again."); })}>Connect to Ollama</button></div>
      <label>Local model{models.length ? <select value={settings.ollamaModel} onChange={event => setSettings({ ...settings, ollamaModel: event.target.value })}>{models.map(model => <option key={model}>{model}</option>)}</select> : <input value={settings.ollamaModel} onChange={event => setSettings({ ...settings, ollamaModel: event.target.value })} />}</label>
      <div className="modal-actions"><button className="primary-button" disabled={busy} onClick={() => void run(async signal => { await testLocalModel(endpoint, settings.ollamaModel, signal); storage.setItem(LOCAL_AI_KEY, JSON.stringify({ endpoint: localOllamaEndpoint(endpoint), model: settings.ollamaModel, origin: window.location.origin, testedAt: new Date().toISOString() })); setNotice("Local model tested and saved for this browser. Keep Ollama running while using Chef."); })}>Test and save local model</button><button className="text-button" disabled={busy} onClick={() => { storage.removeItem(LOCAL_AI_KEY); setNotice("Local connection forgotten in this browser."); }}>Forget connection</button></div>
    </> : <>
      <p>{configured ? `Your encrypted key is saved${lastFour ? ` (ending ${lastFour})` : ""}.` : "Add your own OpenAI API key."} Your selected kitchen context is sent to OpenAI when you ask Chef.</p>
      <label>{configured ? "Replace API key" : "OpenAI API key"}<input type="password" autoComplete="off" value={key} spellCheck={false} onChange={event => setKey(event.target.value)} placeholder="Your personal API key" /></label>
      <label>OpenAI model<input value={settings.openaiModel} onChange={event => setSettings({ ...settings, openaiModel: event.target.value })} /></label>
      <div className="modal-actions"><button className="primary-button" disabled={busy || !key.trim()} onClick={() => void run(async () => { await openai("PUT", { apiKey: key.trim(), model: settings.openaiModel }); setConfigured(true); setLastFour(key.slice(-4)); setKey(""); setNotice("Your encrypted API key is saved. Test it before asking Chef."); })}>Save API key</button><button className="secondary-button" disabled={busy || !configured} onClick={() => void run(async () => { await openai("POST", { model: settings.openaiModel }, "/test"); setNotice("OpenAI passed the structured-output test. No local Ollama connection is needed."); })}>Test OpenAI</button><button className="text-button" disabled={busy || !configured} onClick={() => void run(async () => { await openai("DELETE"); setConfigured(false); setLastFour(""); setKey(""); setNotice("Your saved API key has been deleted."); })}>Delete saved key</button></div><p className="quantity-note">Testing makes a small API request billed to your OpenAI account.</p>
    </>}
    {busy && <p role="status">Checking your connection…</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
