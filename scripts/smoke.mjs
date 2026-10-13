// End-to-end smoke test of the A2A + x402 flow against a running Worker.
//   BASE=http://127.0.0.1:8788 node scripts/smoke.mjs
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const BASE = process.env.BASE ?? "http://127.0.0.1:8788";
const acct = privateKeyToAccount(generatePrivateKey());
let pass = 0, fail = 0;

const ok = (c, m) => { c ? (pass++, console.log(`  ✅ ${m}`)) : (fail++, console.log(`  ❌ ${m}`)); };
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const short = (s, n = 20) => (s && s.length > n ? s.slice(0, n) + "…" : s);

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const randHex = (n) => "0x" + crypto.getRandomValues(new Uint8Array(n)).reduce((s,b)=>s+b.toString(16).padStart(2,"0"),"");

async function signedHeaders(method, id, params, nonceOverride) {
  const nonce = nonceOverride ?? randHex(16);
  const timestamp = new Date().toISOString();
  const canonical = params === undefined || params === null ? "{}" : stableStringify(params);
  const message = `${method}:${String(id)}:${timestamp}:${nonce}:${canonical}`;
  const signature = await acct.signMessage({ message });
  return { headers: { "content-type":"application/json","X-A2A-CALLER":acct.address,"X-A2A-NONCE":nonce,"X-A2A-TIMESTAMP":timestamp,"X-A2A-SIGNATURE":signature }, message, nonce, timestamp, signature };
}

async function rpc(method, params, opts = {}) {
  const id = opts.id ?? Math.floor(Math.random()*1e6);
  let s = opts.reuse ?? await signedHeaders(method, id, params, opts.nonce);
  if (opts.tamper) {
    const sig = s.headers["X-A2A-SIGNATURE"];
    const last = sig.slice(-1);
    s = { ...s, headers: { ...s.headers, "X-A2A-SIGNATURE": sig.slice(0,-1) + (last === "a" ? "b" : "a") } };
  }
  if (opts.omit) { for (const h of opts.omit) delete s.headers[h]; }
  const res = await fetch(`${BASE}/api/v1/a2a/jsonrpc`, { method: "POST", headers: s.headers, body: JSON.stringify({ jsonrpc:"2.0", id, method, params }) });
  return { status: res.status, body: await res.json().catch(()=>null), signed: s, id };
}

async function sign3009(req, valueOverride) {
  const chainId = req.network === "base" ? 8453 : 84532;
  const now = Math.floor(Date.now()/1000);
  const auth = { from: acct.address, to: req.payTo, value: BigInt(valueOverride ?? req.maxAmountRequired),
    validAfter: BigInt(now-600), validBefore: BigInt(now+3600), nonce: randHex(32) };
  const signature = await acct.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId, verifyingContract: req.asset },
    types: { TransferWithAuthorization: [
      {name:"from",type:"address"},{name:"to",type:"address"},{name:"value",type:"uint256"},
      {name:"validAfter",type:"uint256"},{name:"validBefore",type:"uint256"},{name:"nonce",type:"bytes32"}] },
    primaryType: "TransferWithAuthorization", message: auth,
  });
  return { x402Version:1, scheme:"exact", network:req.network,
    payload:{ signature, authorization:{ from:auth.from, to:auth.to, value:auth.value.toString(),
      validAfter:auth.validAfter.toString(), validBefore:auth.validBefore.toString(), nonce:auth.nonce } } };
}

console.log(`\nA2A + x402 smoke test · caller ${acct.address}\nBASE=${BASE}\n`);

console.log("1) Agent Card");
const card = await (await fetch(`${BASE}/.well-known/agent-card.json`)).json();
const v = await (await fetch(`${BASE}/api/v1/a2a/verify-card`)).json();
const jwks = await (await fetch(`${BASE}/.well-known/jwks.json`)).json();
ok(v.valid === true, `card JWS verified (alg ${v.alg}, kid ${v.kid})`);
ok(card.signatures?.length === 1, "card carries one signature");
ok(jwks.keys?.[0]?.crv === "P-256", "JWKS exposes a P-256 key");

console.log("\n2) Free skill with wallet signature");
const free = await rpc("tasks/create", { skill:"ping", input:{ echo:"hello" } });
ok(free.status === 200, `HTTP 200 (got ${free.status})`);
ok(free.body?.result?.task?.state === "succeeded", `task reached state=succeeded`);
ok(free.body?.result?.task?.history?.join("→") === "created→accepted→executing→succeeded",
   `history ${free.body?.result?.task?.history?.join("→")}`);

console.log("\n3) Missing signature header");
const noSig = await rpc("tasks/create", { skill:"ping", input:{ echo:"x" } }, { omit:["X-A2A-SIGNATURE"] });
ok(noSig.status === 401, `HTTP 401 (got ${noSig.status}) · ${noSig.body?.error?.data?.reason}`);

console.log("\n4) Tampered signature");
const tamper = await rpc("tasks/create", { skill:"ping", input:{ echo:"x" } }, { tamper:true });
ok(tamper.status === 401, `HTTP 401 (got ${tamper.status}) · ${tamper.body?.error?.data?.reason}`);

console.log("\n5) Replay the same nonce");
const id = 424242, params = { skill:"ping", input:{ echo:"replay" } };
const reuse = await signedHeaders("tasks/create", id, params);
const first = await rpc("tasks/create", params, { id, reuse });
const again = await rpc("tasks/create", params, { id, reuse });
ok(first.status === 200, `first send HTTP 200 (got ${first.status})`);
ok(again.status === 409, `replay HTTP 409 (got ${again.status}) · ${again.body?.error?.data?.reason}`);

await pause(1300);
console.log("\n6) Paid skill — phase A, no payment");
const input = { symbol:"BTC", price:68000, change24h:2.4 };
const pa = await rpc("tasks/create", { skill:"market_summary", input });
ok(pa.status === 402, `HTTP 402 (got ${pa.status})`);
ok(pa.body?.error?.code === 42000, `JSON-RPC error code 42000 (got ${pa.body?.error?.code})`);
const info = pa.body.error.data, req = info.requirements;
ok(req.extra?.name === "USDC" && req.extra?.version === "2", `EIP-712 domain present (${req.extra?.name} v${req.extra?.version})`);
ok(req.network === "base-sepolia", `network ${req.network}`);
ok(req.payTo.toLowerCase() === info.requirements.payTo.toLowerCase(), `payTo ${short(req.payTo)}`);

await pause(1300);
console.log("\n7) Paid skill — phase B, underpaid");
const under = await rpc("tasks/create", { skill:"market_summary", input,
  payment:{ payment_id: info.payment_id, task_id: info.task_id, payload: await sign3009(req, BigInt(req.maxAmountRequired)/2n) } });
ok(under.status === 402, `HTTP 402 (got ${under.status}) · ${under.body?.error?.data?.reason}`);

await pause(1300);
console.log("\n8) Paid skill — phase B, wrong recipient");
const reqBad = { ...req, payTo: "0x0000000000000000000000000000000000000001" };
const badTo = await rpc("tasks/create", { skill:"market_summary", input,
  payment:{ payment_id: info.payment_id, task_id: info.task_id, payload: await sign3009(reqBad) } });
ok(badTo.status === 402, `HTTP 402 (got ${badTo.status}) · ${badTo.body?.error?.data?.reason}`);

await pause(1300);
console.log("\n9) Paid skill — phase B, correct payment");
const paid = await rpc("tasks/create", { skill:"market_summary", input,
  payment:{ payment_id: info.payment_id, task_id: info.task_id, payload: await sign3009(req) } });
ok(paid.status === 200, `HTTP 200 (got ${paid.status})`);
ok(paid.body?.result?.payment?.status === "confirmed", `payment status confirmed (source ${paid.body?.result?.payment?.source})`);
ok(paid.body?.result?.task?.state === "succeeded", `task state ${paid.body?.result?.task?.state}`);
ok(typeof paid.body?.result?.task?.result?.bias === "string",
   `skill result bias=${paid.body?.result?.task?.result?.bias} confidence=${paid.body?.result?.task?.result?.confidence}`);

await pause(1300);
console.log("\n10) Double-spend the same payment_id");
const dbl = await rpc("tasks/create", { skill:"market_summary", input,
  payment:{ payment_id: info.payment_id, task_id: info.task_id, payload: await sign3009(req) } });
ok(dbl.status === 409, `HTTP 409 (got ${dbl.status}) · ${dbl.body?.error?.message}`);

await pause(1300);
console.log("\n11) Payload substitution (pay for A, execute B)");
const pa2 = await rpc("tasks/create", { skill:"market_summary", input:{ symbol:"ETH", price:3200, change24h:-5 } });
ok(pa2.status === 402, `second payment_id issued (HTTP ${pa2.status})`);
const info2 = pa2.body.error.data;
const subst = await rpc("tasks/create", { skill:"market_summary", input,
  payment:{ payment_id: info2.payment_id, task_id: info2.task_id, payload: await sign3009(info2.requirements) } });
ok(subst.status === 409, `HTTP 409 (got ${subst.status}) · ${subst.body?.error?.message}`);

await pause(1300);
console.log("\n12) Unknown skill / unknown method");
const unk = await rpc("tasks/create", { skill:"nope" });
ok(unk.status === 200 && unk.body?.error?.code === -32602, `unknown skill → -32602`);
const meth = await rpc("nonsense/method", {});
ok(meth.body?.error?.code === -32601, `unknown method → -32601`);

await pause(1300);
console.log("\n13) Rate limiter (14 concurrent requests in one window)");
const signedBatch = await Promise.all(
  Array.from({ length: 14 }, (_, i) => signedHeaders("tasks/create", 9000 + i, { skill: "ping", input: { echo: i } })),
);
const batch = await Promise.all(
  signedBatch.map((s, i) => rpc("tasks/create", { skill: "ping", input: { echo: i } }, { id: 9000 + i, reuse: s })),
);
const limited = batch.filter((r) => r.status === 429).length;
ok(limited > 0, `rate limiter fired on ${limited}/14 concurrent requests (limit 10 QPS per caller per method)`);

console.log(`\n──────── ${pass} passed, ${fail} failed ────────\n`);
process.exit(fail ? 1 : 0);
