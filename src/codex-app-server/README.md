// Copied from t3code packages/effect-codex-app-server/src (upstream protocol ref in \_generated/schema.gen.ts).
// Local edits (re-apply when re-copying):
// 1. client.ts: CodexAppServerClient service key renamed for the Effect deterministicKeys diagnostic.
// 2. protocol.ts: stdout line framing no longer re-splits the whole buffer per chunk (was quadratic:
// a 26 MB thread/read response took 4 s instead of ~0.1 s). The same bug exists in t3code.
