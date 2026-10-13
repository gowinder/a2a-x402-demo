# A2A + x402 Demo — Cloudflare Workers

A live, minimal implementation of the **Agent-to-Agent (A2A) protocol** with **EIP-191 wallet
authentication**, a **nonce replay guard**, an **8-state task state machine**, and **x402
per-task payment** on Base Sepolia.

**Live:** https://a2a-x402-demo.gowinder.workers.dev

> This is a self-contained demo, not a product. It exists so the protocol behaviour can be
> verified by anyone with a browser — no signup, no API key, no testnet funds required.

---

## What you can verify in 60 seconds

Open the live URL and click the scenarios. Each one hits the real Worker:

| # | Scenario | Expected |
|---|---|---|
| 1 | Free task — signed request, no payment | `200`, task walks `created → accepted → executing → succeeded` |
| 2 | Paid task — 402 challenge → pay → result | `402` with payment requirements, then `200` with a confirmed payment |
| 3 | Replay attack — reuse the same nonce | `409` `nonce already used (replay rejected)` |
| 4 | Tampered signature — flip one character | `401` signature does not match the caller |
| 5 | Underpaid authorization | `402` `authorization.value is below the required amount` |

The page generates a throwaway secp256k1 key in your browser, signs a real **EIP-3009
`TransferWithAuthorization`** with EIP-712 typed data, and sends it as the `X-PAYMENT` payload.

---

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/.well-known/agent-card.json` | Agent Card, signed with **JWS ES256 (P-256)** |
| `GET` | `/.well-known/jwks.json` | JWKS for the card signing key |
| `GET` | `/api/v1/a2a/verify-card` | Server-side card signature verification |
| `GET` | `/api/v1/a2a/state-machine` | The allowed-transition table |
| `GET` | `/api/v1/a2a/stats` | Counters from the Durable Object |
| `GET` | `/api/v1/a2a/tasks/:id` | Read-only task lookup |
| `POST` | `/api/v1/a2a/jsonrpc` | JSON-RPC transport: `tasks/create`, `tasks/get` |
| `GET` | `/` | The interactive demo page |

### Authentication

Four headers are required. The signed message is the canonical string

```
{method}:{requestId}:{timestamp}:{nonce}:{canonicalParams}
```

where `canonicalParams` is JSON with keys sorted recursively and no whitespace (equivalent to
Python `json.dumps(obj, sort_keys=True, separators=(",", ":"))`).

| Header | Meaning |
|---|---|
| `X-A2A-CALLER` | EVM address of the caller |
| `X-A2A-NONCE` | one-time random string, ≤128 chars |
| `X-A2A-TIMESTAMP` | ISO-8601 instant, `±300s` window enforced in **both** directions |
| `X-A2A-SIGNATURE` | EIP-191 signature over the string above |

The signature is verified **before** the nonce is consumed, so an attacker cannot burn another
caller's nonce with a junk signature.

### Replay guard

`UNIQUE(caller_wallet, nonce)` in Durable Object SQLite storage. A replayed request hits the
primary-key constraint and is rejected with `409`. Strong consistency matters here — an
eventually-consistent store would let a rapid double-submit through.

### x402 payment

Two-phase, mirroring the HTTP 402 flow:

1. **Phase A** — `tasks/create` without a payment field returns `HTTP 402` and a JSON-RPC error
   `code 42000` carrying `paymentRequirements`: `scheme=exact`, `network=base-sepolia`,
   `asset=USDC`, `maxAmountRequired`, `payTo`, `maxTimeoutSeconds`, and the EIP-712 domain
   (`extra.name` / `extra.version`).
2. **Phase B** — the caller replays with `params.payment` plus a signed EIP-3009 authorization.
   The Worker verifies it, settles it, and only then executes the task.

Before execution four guards run: caller ownership, double-spend (already-settled `payment_id`),
payload substitution (the input must match the call that issued the `payment_id`), and the
amount/recipient/time-window prechecks.

#### Facilitator modes

| `FACILITATOR_MODE` | Behaviour |
|---|---|
| `mock` | Simulates verify + settle so the flow always completes |
| `live` | Calls `https://x402.org/facilitator/verify` and `/settle` on Base Sepolia (no API key) — **this deployment runs live** |

#### Real settlement, verified on chain

The public demo settles **real USDC on Base Sepolia**. Because a browser cannot hold a funded
key safely, the payment authorization is signed **server-side** by
`POST /api/v1/a2a/demo-pay`, using the funded wallet in the `X402_PAYER_KEY` secret. The
private key never reaches the browser; the browser still signs its own EIP-191 caller
authentication with a throwaway key.

A verified settlement from this deployment:

| | |
|---|---|
| Transaction | [`0x9bdc671e…ead502`](https://sepolia.basescan.org/tx/0x9bdc671e735c89ca257fe1b535cf69428aadcbe5bbc99af8235a4b3bc3ead502) |
| Status | success, block 48053391, gas 102868 |
| Token | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Amount | 0.001 USDC (1000 atomic) |
| Payer | `0xc7314519873997A7A105Cbd9f4c1A17d3CeD6e8c` → 19.999 USDC |
| Payee | `0x2f0EeFEBC2417C669caCc4AC264cB4e7eC0E1a61` → 0.001 USDC |

**One deliberate, documented exception:** the caller-ownership guard compares the payer with
the authenticated caller. On the public demo those legitimately differ (server wallet vs.
browser key), so `/demo-pay` marks the payment `server_signed = 1` and *only that* case skips
the comparison. A payload signed by any other wallet is still rejected with `42002` — the
guard was in fact what caught this during development.

The live path is implemented and was validated against the real facilitator: with correct
requirements but a dummy signature it returns `invalid_exact_evm_signature`, which is exactly the
expected rejection. Completing a real settlement additionally requires testnet USDC in the payer
wallet.

---

## Verification

```bash
# against the live deployment
BASE=https://a2a-x402-demo.gowinder.workers.dev node scripts/smoke.mjs

# or locally
npx wrangler dev --port 8788
BASE=http://127.0.0.1:8788 node scripts/smoke.mjs
```

27 assertions covering the card signature, JWKS, the happy path, missing and tampered
signatures, nonce replay, the 402 challenge, underpayment, wrong recipient, double-spend,
payload substitution, unknown skill/method, and the rate limiter.

---

## Architecture

```
Browser / agent caller
        │  POST /api/v1/a2a/jsonrpc   (4 X-A2A-* headers)
        ▼
Cloudflare Worker (Hono)
        ├─ fixed-window rate limiter  ──► Durable Object
        ├─ EIP-191 signature verify      (viem)
        ├─ nonce consume               ──► Durable Object  UNIQUE(caller, nonce)
        ├─ task state machine          ──► 8 states, explicit transition table
        └─ x402 verify + settle        ──► Coinbase/x402.org facilitator (or mock)
                                           │
                                           └─► Base Sepolia settlement
```

State lives in a **Durable Object with SQLite storage** — one strongly-consistent instance —
holding `nonces`, `tasks`, `payments` and the rate-limit buckets.

---

## Run it yourself

```bash
npm install
echo "AGENT_CARD_JWK=<your P-256 private JWK>" > .dev.vars   # signing key for the Agent Card
npx wrangler dev --port 8788
```

Deploy:

```bash
npx wrangler secret put AGENT_CARD_JWK   # paste the private JWK
npx wrangler deploy
```

Generate a P-256 keypair:

```bash
node -e 'const c=require("crypto");const{privateKey,publicKey}=c.generateKeyPairSync("ec",{namedCurve:"prime256v1"});console.log(privateKey.export({format:"jwk"}));console.log(publicKey.export({format:"jwk"}))'
```

Then put the public JWK into `AGENT_CARD_PUBLIC_JWK` in `wrangler.jsonc`.

---

## Notes and limits

- The bundled `market_summary` skill is **deterministic** — it makes no LLM call. The point of
  this demo is the protocol and the payment handshake, not the model.
- `FACILITATOR_MODE` defaults to `mock` so the public URL always completes the flow.
- No escrow: settlement happens before execution. A production system would want an escrow or
  refund path — this is a known trade-off, not an oversight.
- Secrets are never committed: `.dev.vars` is gitignored and the signing key is a Worker secret.
