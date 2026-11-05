# Rust candidate Worker deployment - 2026-11-05

Owner-authorized candidate deployment of the Rust gateway to Cloudflare Workers, worker `uos-ai-rust-candidate`, account `5c0228bee348f4cf48829ffe21b61fe9`, route `https://uos-ai-rust-candidate.ubq.workers.dev`. No DNS, route, production data or production service change was made. The production TypeScript gateway on the VPS stayed active throughout.

## Builds and deployments

Both builds ran on the VPS (Linux ARM64) with `ops/rust-worker-build.sh` under the task-local toolchain recorded in the promotion runbook addendum, with all three pinned tool overrides honoured and no downloads. Deployments used `ops/rust-worker-deploy.sh`, which validates the receipt against the committed tree and runs `cf deploy --prebuilt`.

| Source SHA                                 | Receipt SHA-256  | `index_bg.wasm` SHA-256 | Upload (gzip)          | Version ID  |
| ------------------------------------------ | ---------------- | ----------------------- | ---------------------- | ----------- |
| `f847badb8867338881e5d9db86c61d8f9a1de4f2` | `606b061a…c833e` | `286af7a0…f531`         | 12507.75 KiB (4088.64) | `5a7fc560…` |
| `70289ae3433aa64d954d7e5a0b2b87144b8ba7c3` | `7e1303c7…59dc`  | `3ce7d342…3251`         | 12508.41 KiB (4089.17) | `8132705b…` |

The 4.09 MB gzipped artifact uploaded and deployed, so the account's Workers plan accepts it. Worker startup time reported by Cloudflare: 7 ms.

## Secrets

The Worker holds the twelve secrets declared in `cloudflare.config.ts`: `UOS_AI_TOKEN`, the seven provider keys, `DENO_DEPLOY_TOKEN`, and the three `UOS_AI_PASSPORT_*` values. The eight original ones predate this session; the four new ones were set by the owner's local Codex session with `cf workers secrets update`, because the cloud agent's harness refuses secret writes. No Codex or OAuth credential is bound; the Worker has no native owner.

## Probes against the live candidate (unauthenticated, from the cloud container through its proxy)

| Probe                                    | Result                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                            | 200 in 0.85 s; body `release.git_sha` and `deployment_id` equal `cloudflare-<sha>`; `x-uos-git-sha` and `x-uos-deployment-id` headers match (verified for both deployed SHAs) |
| `GET /v1/models` without a bearer        | 401                                                                                                                                                                           |
| `OPTIONS /v1/chat/completions` preflight | 204, `access-control-allow-origin: *`, allow-headers list present, expose-headers list present                                                                                |
| `POST /v1/decisions` without a bearer    | 401                                                                                                                                                                           |
| `GET /auth/login?return_to=%2Fadmin`     | 302 to `https://passport.ubq.fi/authorize?client_id=ai&audience=ai&origin=<candidate origin>…`                                                                                |

## Pending

Authenticated acceptance probes (DeepSeek and OpenRouter inference, early SSE headers, client abort under real `request.signal`, concurrency, admin ledger and usage views) wait for the candidate bearer and admin token values to be made available to the cloud agent. Until then the candidate's inference path on real Cloudflare is unproven. Also unproven: Passport sign-in completion (the candidate redirect must be registered with Passport), Cerebras (production key returns 402), the Codex subscription tier (no native owner), data migration, and cutover.
