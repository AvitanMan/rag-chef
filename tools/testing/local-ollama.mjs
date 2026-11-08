/** Evaluation may use a separate local daemon, never a remote model service. */
export function localOllamaBaseUrl(value = process.env.OLLAMA_BASE_URL) {
  const url = new URL(value?.trim() || "http://127.0.0.1:11434");
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("OLLAMA_BASE_URL must be a loopback HTTP(S) URL without credentials, query or fragment.");
  }
  return url.href.replace(/\/+$/, "");
}
