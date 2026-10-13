// x402 payment integration (v1 payload shape, as used by the npm `x402` package
// and declared by https://x402.org/facilitator).
//
// Two modes:
//   live — forward verify/settle to the real facilitator (Base Sepolia, no API key)
//   mock — simulate a successful verify/settle so the public demo always completes

import type { Env } from "./lib";

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
}

export function buildRequirements(env: Env, resource: string, description: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: env.X402_NETWORK,
    maxAmountRequired: env.X402_PRICE_ATOMIC,
    resource,
    description,
    mimeType: "application/json",
    payTo: env.X402_PAY_TO,
    maxTimeoutSeconds: 60,
    asset: env.X402_ASSET,
    // The EIP-712 domain of the USDC contract. Without it the facilitator
    // rejects the payload with invalid_exact_evm_missing_eip712_domain.
    extra: { name: env.X402_ASSET_NAME, version: env.X402_ASSET_VERSION },
  };
}

export interface X402Payload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string; to: string; value: string;
      validAfter: string; validBefore: string; nonce: string;
    };
  };
}

/** Local checks that mirror what the facilitator validates, so failures are explainable. */
export function precheckPayload(req: PaymentRequirements, payload: X402Payload): string | null {
  const a = payload?.payload?.authorization;
  if (!a) return "paymentPayload.payload.authorization is missing";
  if (payload.network !== req.network) return `network mismatch: payload=${payload.network} expected=${req.network}`;
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return "authorization.to does not match payTo";
  if (BigInt(a.value) < BigInt(req.maxAmountRequired)) {
    return `authorization.value ${a.value} is below the required ${req.maxAmountRequired}`;
  }
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(a.validAfter) > BigInt(now)) return "authorization is not valid yet (validAfter in the future)";
  if (BigInt(a.validBefore) < BigInt(now)) return "authorization has expired (validBefore in the past)";
  if (!payload.payload.signature) return "payload.signature is missing";
  return null;
}

export interface VerifyOutcome {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
  source: "live" | "mock";
}

export async function verifyWithFacilitator(
  env: Env, req: PaymentRequirements, payload: X402Payload,
): Promise<VerifyOutcome> {
  const local = precheckPayload(req, payload);
  if (local) return { isValid: false, invalidReason: local, source: env.FACILITATOR_MODE };

  if (env.FACILITATOR_MODE === "mock") {
    return { isValid: true, payer: payload.payload.authorization.from, source: "mock" };
  }
  try {
    const res = await fetch(`${env.X402_FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 1, paymentPayload: payload, paymentRequirements: req }),
    });
    const body = (await res.json()) as any;
    return {
      isValid: Boolean(body.isValid),
      payer: body.payer,
      invalidReason: body.invalidReason ?? body.invalidMessage ?? (res.ok ? undefined : `facilitator HTTP ${res.status}`),
      source: "live",
    };
  } catch (e) {
    return { isValid: false, invalidReason: `facilitator unreachable: ${(e as Error).message}`, source: "live" };
  }
}

export interface SettleOutcome {
  success: boolean;
  txHash?: string;
  error?: string;
  source: "live" | "mock";
}

export async function settleWithFacilitator(
  env: Env, req: PaymentRequirements, payload: X402Payload,
): Promise<SettleOutcome> {
  if (env.FACILITATOR_MODE === "mock") {
    const seed = payload.payload.authorization.nonce.slice(0, 62);
    return { success: true, txHash: `0x${seed.padEnd(64, "0")}`, source: "mock" };
  }
  try {
    const res = await fetch(`${env.X402_FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 1, paymentPayload: payload, paymentRequirements: req }),
    });
    const body = (await res.json()) as any;
    return {
      success: Boolean(body.success),
      txHash: body.transaction,
      error: body.errorReason ?? body.errorMessage ?? (res.ok ? undefined : `facilitator HTTP ${res.status}`),
      source: "live",
    };
  } catch (e) {
    return { success: false, error: `facilitator unreachable: ${(e as Error).message}`, source: "live" };
  }
}
