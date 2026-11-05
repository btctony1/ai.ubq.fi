import { bindings, defineConfig, exports } from "cf/config";

const workerName = "uos-ai-rust-candidate";

export default defineConfig({
  accountId: "5c0228bee348f4cf48829ffe21b61fe9",
  worker: {
    name: workerName,
    compatibilityDate: "2026-10-18",
    compatibilityFlags: ["enable_request_signal", "request_signal_passthrough"],
    entrypoint: "./rust/crates/gateway-worker/entrypoint.mjs",
    workersDev: true,
    previewUrls: false,
    exports: {
      GatewayAuthority: exports.durableObject({ storage: "sqlite" }),
      InitialControlInstaller: exports.worker(),
    },
    env: {
      AUTHORITY: bindings.durableObject({ worker: workerName, exportName: "GatewayAuthority" }),
      ASSETS: bindings.assets(),
      // Isolated rust-candidate direct-provider path. Production ai.ubq.fi keeps
      // its provider credentials on the VPS. This Worker never holds a Codex
      // refresh token: UOS_NATIVE_CARRIER (optional) pins the HTTPS origin, the
      // transport identity and the fixed renewal-owner registry of the one
      // native owner that keeps Codex credential custody and performs refresh.
      UOS_NATIVE_CARRIER: bindings.secret(),
      UOS_AI_TOKEN: bindings.secret(),
      DEEPSEEK_API_KEY: bindings.secret(),
      CEREBRAS_API_KEY: bindings.secret(),
      LITHOSAI_API_KEY: bindings.secret(),
      OPENROUTER_API_KEY: bindings.secret(),
      SURPLUS_API_KEY: bindings.secret(),
      METERED_API_KEY: bindings.secret(),
      CLAUDE_API_KEY: bindings.secret(),
      // Admin bearer tokens for /admin and /health/* (gateway-auth bootstrap). The
      // retained DENO_DEPLOY_TOKEN name identifies the admin credential only.
      DENO_DEPLOY_TOKEN: bindings.secret(),
      // Passport browser login. The Worker reads these through secret-then-var
      // lookup; all three must be set or /auth/login answers passport_not_configured.
      // UOS_AI_PASSPORT_AUDIENCE stays undeclared and defaults to the production "ai".
      UOS_AI_PASSPORT_CLIENT_ID: bindings.secret(),
      UOS_AI_PASSPORT_ORIGIN: bindings.secret(),
      UOS_AI_PASSPORT_REDIRECT_URI: bindings.secret(),
    },
    assets: { runWorkerFirst: true, notFoundHandling: "none" },
    observability: { enabled: true, traces: { enabled: true } },
  },
});
