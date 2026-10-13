// A2A protocol demo on Cloudflare Workers:
//   · Agent Card signed with JWS ES256 + JWKS endpoint
//   · JSON-RPC transport with EIP-191 wallet-signature auth and nonce replay guard
//   · 8-state task state machine
//   · x402 two-phase payment (HTTP 402 challenge -> replay with X-PAYMENT)

import { Hono } from "hono";
import { A2AState } from "./a2a-state";
import { buildCard, signCard, verifyCardSignature, buildJwks } from "./card";
import { verifyRequest } from "./auth";
import {
  buildRequirements, verifyWithFacilitator, settleWithFacilitator,
  type X402Payload,
} from "./x402";
import {
  randomHex, ALLOWED_TRANSITIONS, A2A_STATES,
  type Env, type A2AState as TaskState,
} from "./lib";
import { buildSignedPayload } from "./payer";
import demoPageHtml from "./demo-page.html";

export { A2AState };

const FREE_SKILLS = new Set(["ping"]);
const PAID_SKILLS = new Set(["market_summary"]);
const RATE_LIMIT_QPS = 10;

const app = new Hono<{ Bindings: Env }>();

const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0" as const, id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0" as const, id: id ?? null, result });

const stub = (env: Env) => env.A2A_STATE.get(env.A2A_STATE.idFromName("global"));
const baseUrl = (url: string) => { const u = new URL(url); return `${u.protocol}//${u.host}`; };

function publicTask(t: any) {
  if (!t) return null;
  return {
    id: t.id, state: t.state, history: t.history,
    input: JSON.parse(t.payload), payment_id: t.payment_id,
    result: t.result ? JSON.parse(t.result) : null,
    created_at: t.created_at, updated_at: t.updated_at,
  };
}

/** Deterministic demo skill. Deliberately not an LLM call — the point is the protocol. */
function runSkill(skill: string, input: any) {
  if (skill === "ping") {
    return { echo: input?.echo ?? null, agent: "demo-market-research-agent", at: new Date().toISOString() };
  }
  if (skill === "market_summary") {
    const change = Number(input?.change24h ?? 0);
    const bias = change > 1 ? "long" : change < -1 ? "short" : "neutral";
    const confidence = Math.min(0.95, Math.round((0.5 + Math.min(Math.abs(change), 9) / 10) * 1000) / 1000);
    return {
      symbol: input?.symbol ?? "UNKNOWN", price: Number(input?.price ?? 0), change24h: change,
      bias, confidence,
      note: "Deterministic demo skill — no LLM call. Replace this function with a real model call.",
    };
  }
  return null;
}

// ------------------------------------------------------------------ meta endpoints

app.get("/health", (c) => c.json({ ok: true, service: "a2a-x402-demo", facilitator_mode: c.env.FACILITATOR_MODE }));

app.get("/.well-known/agent-card.json", async (c) => {
  const card = await signCard(c.env, buildCard(baseUrl(c.req.url)));
  return c.json(card);
});

app.get("/.well-known/jwks.json", (c) => c.json(buildJwks(c.env)));

app.get("/api/v1/a2a/verify-card", async (c) => {
  const card = await signCard(c.env, buildCard(baseUrl(c.req.url)));
  const valid = await verifyCardSignature(c.env, card);
  return c.json({ valid, kid: c.env.AGENT_CARD_KID, alg: "ES256" });
});

app.get("/api/v1/a2a/state-machine", (c) =>
  c.json({
    states: A2A_STATES,
    allowed_transitions: ALLOWED_TRANSITIONS,
    note: "Illegal transitions are logged and rejected; they never raise.",
  }));

// Server-side signing for the public demo: lets the page demonstrate a REAL
// x402 settlement without shipping a funded private key to the browser.
app.post("/api/v1/a2a/demo-pay", async (c) => {
  const body = await c.req.json().catch(() => null);
  const paymentId = String((body as any)?.payment_id ?? "");
  const pay = await stub(c.env).getPayment(paymentId);
  if (!pay) return c.json({ error: "unknown payment_id", payment_id: paymentId }, 404);
  if (!c.env.X402_PAYER_KEY) {
    return c.json({ error: "X402_PAYER_KEY is not configured on this deployment" }, 400);
  }
  try {
    const requirements = JSON.parse(pay.requirements);
    const { payload, payer } = await buildSignedPayload(c.env, requirements);
    // Record that this payload came from the demo's own funded wallet, so the
    // caller-ownership guard can be waived for exactly this case (and nothing else).
    await stub(c.env).markServerSigned(paymentId);
    return c.json({
      payment_id: paymentId, payer, network: requirements.network,
      amount_atomic: requirements.maxAmountRequired, pay_to: requirements.payTo,
      payload, note: "signed server-side by the funded demo wallet",
    });
  } catch (e) {
    return c.json({ error: `could not sign payment: ${(e as Error).message}` }, 500);
  }
});

app.get("/api/v1/a2a/stats", async (c) => {
  const s = await stub(c.env).stats();
  return c.json({ ...s, facilitator_mode: c.env.FACILITATOR_MODE });
});

// HTTP-compatibility read surface (read-only demo affordance)
app.get("/api/v1/a2a/tasks/:id", async (c) => {
  const t = await stub(c.env).getTask(c.req.param("id"));
  if (!t) return c.json({ error: "task not found" }, 404);
  return c.json({ task: publicTask(t) });
});

// ------------------------------------------------------------------ JSON-RPC transport

app.post("/api/v1/a2a/jsonrpc", async (c) => {
  const env = c.env;
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return c.json(rpcError(null, -32700, "Parse error"), 200);
  }
  const id = (raw as any).id;
  const method = String((raw as any).method ?? "");
  const params = (raw as any).params ?? null;
  const st = stub(env);

  // 1) rate limit — deliberately BEFORE authentication, like a real edge
  const callerHeader = (c.req.header("X-A2A-CALLER") ?? "anonymous").toLowerCase();
  const gate = await st.rateLimit(`${callerHeader}|${method}|${Math.floor(Date.now() / 1000)}`, RATE_LIMIT_QPS);
  if (!gate.allowed) {
    c.header("Retry-After", "1");
    return c.json(rpcError(id, 41001, "Rate limit exceeded", { limit_qps: RATE_LIMIT_QPS, observed: gate.count }), 429);
  }

  if (!method) return c.json(rpcError(id, -32600, "Invalid Request: method is required"), 200);

  // 2) authenticate: EIP-191 signature over the canonical message
  const auth = await verifyRequest({ headers: c.req.raw.headers, method, requestId: id, params });
  if (!auth.ok) {
    return c.json(rpcError(id, -32001, "Unauthorized", { reason: auth.reason }), 401);
  }

  // 3) consume the nonce — AFTER the signature is verified, so nobody can burn
  //    another caller's nonce with a junk signature.
  const nonce = await st.consumeNonce(auth.caller, auth.nonce);
  if (!nonce.ok) {
    return c.json(rpcError(id, -32002, "Replay rejected", { reason: nonce.reason, nonce: auth.nonce }), 409);
  }

  // 4) dispatch
  if (method === "tasks/get") {
    const taskId = String((params as any)?.taskId ?? "");
    const t = await st.getTask(taskId);
    if (!t) return c.json(rpcError(id, -32602, `unknown task ${taskId}`), 200);
    return c.json(rpcResult(id, { task: publicTask(t), caller: auth.caller }));
  }

  if (method !== "tasks/create") {
    return c.json(rpcError(id, -32601, `Method not found: ${method}`), 200);
  }

  const skill = String((params as any)?.skill ?? "");
  const input = (params as any)?.input ?? {};
  if (!FREE_SKILLS.has(skill) && !PAID_SKILLS.has(skill)) {
    return c.json(rpcError(id, -32602, `unknown skill "${skill}"`, { available: [...FREE_SKILLS, ...PAID_SKILLS] }), 200);
  }

  // ---- free skill: run immediately
  if (FREE_SKILLS.has(skill)) {
    const taskId = "task_" + randomHex(8).slice(2);
    await st.createTask(taskId, JSON.stringify({ skill, input }), null);
    await st.setTaskState(taskId, "accepted", null);
    await st.setTaskState(taskId, "executing", null);
    await st.setTaskState(taskId, "succeeded", JSON.stringify(runSkill(skill, input)));
    const t = await st.getTask(taskId);
    return c.json(rpcResult(id, { task: publicTask(t), caller: auth.caller, payment: { required: false } }));
  }

  // ---- paid skill, phase A: no payment attached
  const resource = `${baseUrl(c.req.url)}/api/v1/a2a/jsonrpc#${skill}`;
  const payment = (params as any)?.payment;
  if (!payment) {
    const requirements = buildRequirements(env, resource, `Execute skill: ${skill}`);
    const paymentId = "pay_" + randomHex(8).slice(2);
    const taskId = "task_" + randomHex(8).slice(2);
    await st.createPayment(paymentId, JSON.stringify(requirements));
    await st.createTask(taskId, JSON.stringify({ skill, input }), paymentId);
    return c.json(
      rpcError(id, 42000, "Payment required", {
        payment_id: paymentId, task_id: taskId,
        facilitator_mode: env.FACILITATOR_MODE, requirements,
      }), 402);
  }

  // ---- paid skill, phase B: verify + settle, then execute
  const paymentId = String(payment?.payment_id ?? "");
  const payload = payment?.payload as X402Payload;
  const pay = await st.getPayment(paymentId);
  if (!pay) return c.json(rpcError(id, 42001, "Unknown payment_id", { payment_id: paymentId }), 200);
  if (pay.status === "confirmed") {
    return c.json(rpcError(id, 42003, "Payment already settled for this payment_id (double-spend rejected)"), 409);
  }
  const requirements = JSON.parse(pay.requirements);
  const task = await st.getTask(String(payment?.task_id ?? ""));
  if (!task) return c.json(rpcError(id, 42001, "payment_id is not bound to a task"), 200);
  if (JSON.stringify(JSON.parse(task.payload).input) !== JSON.stringify(input)) {
    return c.json(rpcError(id, 42004, "Payload substitution rejected: input differs from the call that issued this payment_id"), 409);
  }

  const verdict = await verifyWithFacilitator(env, requirements, payload);
  if (!verdict.isValid) {
    await st.setPaymentStatus(paymentId, "failed", verdict.payer ?? null, null);
    return c.json(rpcError(id, 42001, "Payment verification failed", {
      reason: verdict.invalidReason, source: verdict.source,
    }), 402);
  }
  // Ownership guard: the payer must be the caller — except on the public demo path,
  // where the payload is signed server-side by the funded demo wallet and the caller
  // is a throwaway key generated in the visitor's browser.
  if (!pay.server_signed && verdict.payer && verdict.payer.toLowerCase() !== auth.caller.toLowerCase()) {
    return c.json(rpcError(id, 42002, "Payer does not match the authenticated caller (ownership rejected)", {
      payer: verdict.payer, caller: auth.caller,
    }), 403);
  }
  await st.setPaymentStatus(paymentId, "pending", verdict.payer ?? auth.caller, null);

  const settled = await settleWithFacilitator(env, requirements, payload);
  if (!settled.success) {
    await st.setPaymentStatus(paymentId, "failed", verdict.payer ?? auth.caller, null);
    return c.json(rpcError(id, 42001, "Settlement failed", { reason: settled.error, source: settled.source }), 402);
  }
  await st.setPaymentStatus(paymentId, "confirmed", verdict.payer ?? auth.caller, settled.txHash ?? null);

  await st.setTaskState(task.id, "accepted", null);
  await st.setTaskState(task.id, "executing", null);
  const result = runSkill(skill, input);
  await st.setTaskState(task.id, "succeeded", JSON.stringify(result));
  const updated = await st.getTask(task.id);

  return c.json(rpcResult(id, {
    task: publicTask(updated),
    caller: auth.caller,
    payment: {
      required: true, payment_id: paymentId, status: "confirmed",
      source: settled.source, transaction: settled.txHash, network: requirements.network,
      amount_atomic: requirements.maxAmountRequired, asset: requirements.asset, pay_to: requirements.payTo,
    },
  }));
});

// ------------------------------------------------------------------ pages

app.get("/", (c) => c.html(demoPageHtml.replace(/__BASE__/g, baseUrl(c.req.url))));
app.get("/demo", (c) => c.redirect("/"));

app.notFound((c) => c.json({ error: "not found", try: ["/", "/.well-known/agent-card.json", "POST /api/v1/a2a/jsonrpc"] }, 404));

export default app;
