// A2A request authentication: EIP-191 wallet signature over a canonical message.
// Order matters: the signature is verified FIRST, and only then is the nonce consumed.

import { verifyMessage } from "viem";
import { stableStringify, NONCE_WINDOW_MS } from "./lib";

export interface AuthInput {
  headers: Headers;
  method: string;
  requestId: unknown;
  params: unknown;
}

export interface AuthOk {
  ok: true;
  caller: `0x${string}`;
  nonce: string;
  timestamp: string;
  signedMessage: string;
  canonicalParams: string;
}
export interface AuthFail {
  ok: false;
  reason: string;
}

export async function verifyRequest(input: AuthInput): Promise<AuthOk | AuthFail> {
  const h = input.headers;
  const caller = (h.get("X-A2A-CALLER") ?? "").trim();
  const nonce = (h.get("X-A2A-NONCE") ?? "").trim();
  const timestamp = (h.get("X-A2A-TIMESTAMP") ?? "").trim();
  const signature = (h.get("X-A2A-SIGNATURE") ?? "").trim();

  const missing = [
    !caller && "X-A2A-CALLER",
    !nonce && "X-A2A-NONCE",
    !timestamp && "X-A2A-TIMESTAMP",
    !signature && "X-A2A-SIGNATURE",
  ].filter(Boolean);
  if (missing.length) return { ok: false, reason: `missing header(s): ${missing.join(", ")}` };

  if (nonce.length > 128) return { ok: false, reason: "X-A2A-NONCE exceeds 128 characters" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(caller)) return { ok: false, reason: "X-A2A-CALLER is not an EVM address" };

  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return { ok: false, reason: "X-A2A-TIMESTAMP is not a valid ISO-8601 instant" };
  const driftMs = Math.abs(Date.now() - t);
  if (driftMs > NONCE_WINDOW_MS) {
    return { ok: false, reason: `timestamp drift ${Math.round(driftMs / 1000)}s exceeds the ±300s window` };
  }

  const canonicalParams =
    input.params === undefined || input.params === null ? "{}" : stableStringify(input.params);
  const signedMessage = `${input.method}:${String(input.requestId)}:${timestamp}:${nonce}:${canonicalParams}`;

  let valid = false;
  try {
    valid = await verifyMessage({
      address: caller as `0x${string}`,
      message: signedMessage,
      signature: signature as `0x${string}`,
    });
  } catch (e) {
    return { ok: false, reason: `signature could not be checked: ${(e as Error).message}` };
  }
  if (!valid) return { ok: false, reason: "EIP-191 signature does not match X-A2A-CALLER" };

  return { ok: true, caller: caller as `0x${string}`, nonce, timestamp, signedMessage, canonicalParams };
}
