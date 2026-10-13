// Agent Card + JWS (ES256 / P-256) signing, and the JWKS document.

import { stableStringify, b64url, type Env } from "./lib";

export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: string;
  version: string;
  capabilities: Record<string, boolean>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{ id: string; name: string; description: string; tags: string[]; examples: string[] }>;
  security: Array<Record<string, string[]>>;
  securitySchemes: Record<string, unknown>;
  additionalInterfaces: Array<{ transport: string; url: string }>;
  signatures?: Array<{ protected: string; signature: string }>;
}

export function buildCard(baseUrl: string): AgentCard {
  return {
    protocolVersion: "1.0.0",
    name: "Demo Market Research Agent",
    description:
      "A minimal A2A agent that authenticates callers by wallet signature and charges per task over x402 on Base Sepolia.",
    url: `${baseUrl}/api/v1/a2a/jsonrpc`,
    preferredTransport: "jsonrpc",
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "ping",
        name: "Ping",
        description: "Free skill — proves the wallet-signature handshake works without any payment.",
        tags: ["diagnostics"],
        examples: ['{"echo":"hello"}'],
      },
      {
        id: "market_summary",
        name: "Market summary",
        description: "Deterministic demo skill — returns a bias and confidence for one symbol. No LLM call.",
        tags: ["finance", "market-data"],
        examples: ['{"symbol":"BTC","price":68000,"change24h":2.4}'],
      },
    ],
    security: [{ wallet_signature: [] }],
    securitySchemes: {
      wallet_signature: {
        type: "http",
        scheme: "bearer",
        description:
          "EIP-191 personal_sign over \"{method}:{requestId}:{timestamp}:{nonce}:{canonicalParams}\". " +
          "Send X-A2A-CALLER, X-A2A-NONCE, X-A2A-TIMESTAMP and X-A2A-SIGNATURE.",
      },
    },
    additionalInterfaces: [
      { transport: "jsonrpc", url: `${baseUrl}/api/v1/a2a/jsonrpc` },
      { transport: "http+json", url: `${baseUrl}/api/v1/a2a/http` },
    ],
  };
}

const JWK_FIELDS = ["kty", "crv", "x", "y", "d"] as const;

function pickJwk(raw: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of JWK_FIELDS) if (raw[f]) out[f] = raw[f];
  return out;
}

/** Signs the card with JWS ES256 (detached-ish: signature carried inside the card). */
export async function signCard(env: Env, card: AgentCard): Promise<AgentCard> {
  if (!env.AGENT_CARD_JWK) return card; // no signing key configured -> unsigned card
  const jwk = pickJwk(JSON.parse(env.AGENT_CARD_JWK));
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...jwk, ext: true, key_ops: ["sign"] } as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const protectedHeader = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: env.AGENT_CARD_KID }));
  const payload = b64url(stableStringify(card));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${protectedHeader}.${payload}`),
  );
  return {
    ...card,
    signatures: [{ protected: protectedHeader, signature: b64url(new Uint8Array(sig)) }],
  };
}

/** Verifies a card signature — used by the demo page badge. */
export async function verifyCardSignature(env: Env, signedCard: any): Promise<boolean> {
  try {
    const pub = pickJwk(JSON.parse(env.AGENT_CARD_PUBLIC_JWK));
    const key = await crypto.subtle.importKey(
      "jwk",
      { ...pub, ext: true, key_ops: ["verify"] } as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const { protected: ph, signature } = signedCard.signatures[0];
    const { signatures, ...card } = signedCard;
    const payload = b64url(stableStringify(card));
    const sigBytes = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, sigBytes,
      new TextEncoder().encode(`${ph}.${payload}`),
    );
  } catch {
    return false;
  }
}

export function buildJwks(env: Env) {
  const pub = JSON.parse(env.AGENT_CARD_PUBLIC_JWK);
  return {
    keys: [
      {
        kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y,
        kid: env.AGENT_CARD_KID, alg: "ES256", use: "sig", key_ops: ["verify"],
      },
    ],
  };
}
