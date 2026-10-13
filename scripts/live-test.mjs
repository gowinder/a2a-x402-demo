// Real on-chain x402 settlement test against the deployed Worker.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const BASE = process.env.BASE ?? "https://a2a-x402-demo.gowinder.workers.dev";
const acct = privateKeyToAccount(generatePrivateKey());

function stableStringify(v){
  if(v===null||typeof v!=="object") return JSON.stringify(v)??"null";
  if(Array.isArray(v)) return "["+v.map(stableStringify).join(",")+"]";
  return "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+stableStringify(v[k])).join(",")+"}";
}
const randHex=n=>"0x"+crypto.getRandomValues(new Uint8Array(n)).reduce((s,b)=>s+b.toString(16).padStart(2,"0"),"");

async function rpc(method, params, id){
  const nonce=randHex(16), timestamp=new Date().toISOString();
  const canonical = params===undefined||params===null ? "{}" : stableStringify(params);
  const message=`${method}:${String(id)}:${timestamp}:${nonce}:${canonical}`;
  const signature=await acct.signMessage({ message });
  const res=await fetch(`${BASE}/api/v1/a2a/jsonrpc`,{method:"POST",
    headers:{"content-type":"application/json","X-A2A-CALLER":acct.address,"X-A2A-NONCE":nonce,
             "X-A2A-TIMESTAMP":timestamp,"X-A2A-SIGNATURE":signature},
    body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
  return { status:res.status, body:await res.json().catch(()=>null) };
}

console.log("MODE:", (await (await fetch(`${BASE}/health`)).json()));
console.log("caller:", acct.address, "\n");

const input={symbol:"BTC", price:68000, change24h:2.4};
console.log("1) 首次调用（无付款）→ 期待 402");
const g1 = await rpc("tasks/create",{skill:"market_summary",input}, Math.floor(Math.random()*1e6));
console.log("   HTTP", g1.status, "| code", g1.body?.error?.code);
if(g1.status!==402){ console.log("   ✗ 未拿到 402，中止:", JSON.stringify(g1.body).slice(0,300)); process.exit(1); }
const info=g1.body.error.data, req=info.requirements;
console.log("   requirements:", JSON.stringify({network:req.network, asset:req.asset, amount:req.maxAmountRequired, payTo:req.payTo, extra:req.extra}));

console.log("\n2) 服务端签名付款 payload");
const pr = await fetch(`${BASE}/api/v1/a2a/demo-pay`,{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({payment_id:info.payment_id})});
const pj = await pr.json();
console.log("   HTTP", pr.status, "| payer", pj.payer, "| pay_to", pj.pay_to);
if(!pr.ok){ console.log("   ✗", JSON.stringify(pj).slice(0,300)); process.exit(1); }

console.log("\n3) 带着付款重放 → 期待真实结算");
const g2 = await rpc("tasks/create",{skill:"market_summary",input,
  payment:{payment_id:info.payment_id, task_id:info.task_id, payload:pj.payload}}, Math.floor(Math.random()*1e6));
console.log("   HTTP", g2.status);
const pay = g2.body?.result?.payment;
if(pay){
  console.log("   付款状态:", pay.status, "| 来源:", pay.source);
  console.log("   链上交易:", pay.transaction);
  console.log("   网络:", pay.network, "| 金额:", pay.amount_atomic, "atomic | 收款:", pay.pay_to);
  console.log("   任务:", g2.body?.result?.task?.state, "| 结果:", JSON.stringify(g2.body?.result?.task?.result)?.slice(0,160));
} else {
  console.log("   ✗ 未结算:", JSON.stringify(g2.body).slice(0,500));
}
