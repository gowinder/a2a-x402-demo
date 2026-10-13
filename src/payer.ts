// Server-side x402 payer.
//
// The browser demo signs with a throwaway ephemeral key, which holds no USDC.
// For real settlement we therefore sign the EIP-3009 authorization here, with the
// funded demo wallet supplied as the X402_PAYER_KEY secret. The key never reaches
// the browser.

import { privateKeyToAccount } from "viem/accounts";
import type { Env } from "./lib";
import type { PaymentRequirements, X402Payload } from "./x402";

const CHAIN_IDS: Record<string, number> = { "base-sepolia": 84532, base: 8453 };

export interface SignedPayment {
  payload: X402Payload;
  payer: `0x${string}`;
}

export async function buildSignedPayload(env: Env, req: PaymentRequirements): Promise<SignedPayment> {
  if (!env.X402_PAYER_KEY) throw new Error("X402_PAYER_KEY is not configured");
  const account = privateKeyToAccount(env.X402_PAYER_KEY as `0x${string}`);
  const chainId = CHAIN_IDS[req.network] ?? 84532;

  const now = Math.floor(Date.now() / 1000);
  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonce = ("0x" + [...nonceBytes].map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;

  const authorization = {
    from: account.address,
    to: req.payTo as `0x${string}`,
    value: BigInt(req.maxAmountRequired),
    validAfter: BigInt(now - 600),
    validBefore: BigInt(now + 3600),
    nonce,
  };

  const signature = await account.signTypedData({
    domain: {
      name: req.extra.name,
      version: req.extra.version,
      chainId,
      verifyingContract: req.asset as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  return {
    payer: account.address,
    payload: {
      x402Version: 1,
      scheme: "exact",
      network: req.network,
      payload: {
        signature,
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
          nonce: authorization.nonce,
        },
      },
    },
  };
}
