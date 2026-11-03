import assert from "node:assert/strict";
import { test } from "node:test";
import { localOllamaBaseUrl } from "../tools/testing/local-ollama.mjs";

test("local evaluation accepts alternate loopback Ollama ports and keeps the default", () => {
  assert.equal(localOllamaBaseUrl(""), "http://127.0.0.1:11434");
  assert.equal(localOllamaBaseUrl(" http://127.0.0.1:11435/ "), "http://127.0.0.1:11435");
  assert.equal(localOllamaBaseUrl("https://localhost:11435/"), "https://localhost:11435");
  assert.equal(localOllamaBaseUrl("http://[::1]:11435/"), "http://[::1]:11435");
});

test("local evaluation rejects remote, credentialed and non-HTTP model URLs", () => {
  for (const url of ["https://example.com", "http://localhost.example.com", "file:///tmp/ollama", "http://user:secret@localhost:11435", "http://localhost:11435?key=secret", "http://localhost:11435#key=secret", "invalid"]) {
    assert.throws(() => localOllamaBaseUrl(url));
  }
});
