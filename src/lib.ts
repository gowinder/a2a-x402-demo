// Canonical JSON, encodings, and the A2A task state machine.

export interface Env {
  A2A_STATE: DurableObjectNamespace<import("./a2a-state").A2AState>;
  X402_NETWORK: string;
  X402_ASSET: string;
  X402_PAY_TO: string;
  X402_PRICE_ATOMIC: string;
  X402_ASSET_NAME: string;
  X402_ASSET_VERSION: string;
  X402_FACILITATOR_URL: string;
  FACILITATOR_MODE: "mock" | "live";
  AGENT_CARD_KID: string;
  AGENT_CARD_PUBLIC_JWK: string;
  AGENT_CARD_JWK?: string;
}

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace.
 * This is the exact string that the caller signs, so both sides must agree.
 * Equivalent to Python json.dumps(obj, sort_keys=True, separators=(",", ":")).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? new TextEncoder().encode(v) : v;
}

export function b64url(input: string | Uint8Array): string {
  const bytes = toBytes(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64Std(input: string | Uint8Array): string {
  const bytes = toBytes(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64DecodeToString(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function randomHex(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return "0x" + [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- state machine

export const A2A_STATES = [
  "created", "accepted", "bridge_ready", "executing",
  "succeeded", "failed", "cancelled", "expired",
] as const;
export type A2AState = (typeof A2A_STATES)[number];

/** Explicit allowed-transition table. Anything not listed is illegal. */
export const ALLOWED_TRANSITIONS: Record<A2AState, A2AState[]> = {
  created: ["accepted", "cancelled"],
  accepted: ["executing", "bridge_ready", "cancelled"],
  bridge_ready: ["succeeded", "failed", "cancelled"],
  executing: ["succeeded", "failed", "cancelled", "expired"],
  succeeded: [], failed: [], cancelled: [], expired: [],
};

export function isTerminal(state: A2AState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

/** Illegal transitions return false and are logged; they never raise. */
export function canTransition(from: A2AState, to: A2AState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export const NONCE_WINDOW_SECONDS = 300;
export const NONCE_WINDOW_MS = NONCE_WINDOW_SECONDS * 1000;
