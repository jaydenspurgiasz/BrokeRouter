import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const image = process.env.BROKEROUTER_DOCKER_IMAGE ?? "broke-router-oracle-test:local";
const envPath = resolve(process.env.BROKE_ROUTER_ENV_FILE ?? ".env");
const source = parseDotEnv(await readFile(envPath, "utf8"));
const routerKey = source.ROUTER_API_KEY;
assert.ok(routerKey?.length >= 32, "ROUTER_API_KEY must contain at least 32 characters");
// Account definitions are themselves secret values, but their nested API keys must also
// be redacted and checked independently in case a diagnostic ever contains only a key.
const secrets = [...new Set([
  ...Object.values(source).filter((value) => value.length >= 20),
  ...Object.entries(source)
    .filter(([name]) => name.startsWith("BROKEROUTER_PROVIDER_ACCOUNT_"))
    .flatMap(([, value]) => accountApiKey(value)),
])];
const suffix = randomBytes(5).toString("hex");
const network = `brokerouter-acceptance-${suffix}`;
const volume = `brokerouter-acceptance-data-${suffix}`;
const router = `brokerouter-acceptance-router-${suffix}`;
const client = `brokerouter-acceptance-hermes-${suffix}`;

try {
  await docker(["network", "create", network]);
  await docker(["volume", "create", volume]);
  await startRouter();
  await waitReady();
  await assertRuntimeHardening();
  await runHermesClient("initial");
  await docker(["kill", router]);
  await docker(["start", router]);
  await waitReady();
  await assertSqliteRecovery();
  await runHermesClient("post-recovery");
  console.log("PASS Docker Oracle acceptance: private client network, secret mount, Linux runtime, live providers, SSE, context, abrupt recovery, SQLite integrity");
} catch (error) {
  let logs = "";
  try { logs = (await docker(["logs", "--tail", "100", router])).output; } catch { /* router may not have started */ }
  throw new Error(`${error instanceof Error ? error.message : error}\nRouter diagnostics:\n${logs.slice(-4000)}`);
} finally {
  await quietly(["rm", "-f", router]);
  await quietly(["rm", "-f", client]);
  await quietly(["volume", "rm", "-f", volume]);
  await quietly(["network", "rm", network]);
}

async function startRouter() {
  await docker([
    "run", "-d", "--name", router, "--network", network,
    "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--init", "--mount", `type=volume,src=${volume},dst=/data`,
    "--mount", `type=bind,src=${envPath},dst=/run/secrets/brokerouter.env,readonly`,
    "-e", "BROKEROUTER_HOST=0.0.0.0", "-e", "BROKEROUTER_ENV_FILE=/run/secrets/brokerouter.env",
    image,
  ]);
}

async function waitReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const result = await docker(["exec", router, "node", "-e", "fetch('http://127.0.0.1:8787/ready').then(async r=>{if(!r.ok)throw new Error(await r.text())})"]);
      if (result.code === 0) return;
    } catch { /* startup */ }
    await delay(250);
  }
  const logs = await docker(["logs", "--tail", "100", router]);
  throw new Error(`router did not become ready: ${logs.output}`);
}

async function assertRuntimeHardening() {
  const inspect = JSON.parse((await docker(["inspect", router])).output)[0];
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true, "root filesystem is not read-only");
  assert.equal(inspect.HostConfig.CapDrop?.includes("ALL"), true, "Linux capabilities were not dropped");
  assert.equal(inspect.HostConfig.SecurityOpt?.includes("no-new-privileges"), true, "no-new-privileges missing");
  assert.equal(Object.keys(inspect.HostConfig.PortBindings ?? {}).length, 0, "router must not publish a host port");
  assert.equal(inspect.Config.User, "node", "router must run as non-root node user");
  const configured = JSON.stringify(inspect.Config.Env ?? []);
  for (const secret of secrets) assert.equal(configured.includes(secret), false, "a secret leaked into docker inspect");
  pass("container hardening + inspect-safe secret mount");
}

async function runHermesClient(label) {
  const script = `
    const auth={authorization:'Bearer '+process.env.ROUTER_TOKEN,'content-type':'application/json'};
    const base='http://${router}:8787';
    const models=await fetch(base+'/v1/models',{headers:auth}).then(async r=>{if(!r.ok)throw new Error(await r.text());return r.json()});
    const list=models.data;
    if(!list.some(x=>x.id==='free/hermes'))throw new Error('free/hermes missing');
    const nvidia=list.find(x=>x.provider==='nvidia'&&x.credentialScope==='primary');
    const gemini=list.find(x=>x.provider==='gemini'&&x.credentialScope==='primary');
    if(!nvidia||!gemini)throw new Error('real provider accounts missing');
    async function call(body){for(let i=0;;i++){const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers:auth,body:JSON.stringify(body)});const t=await r.text();if(r.ok)return {r,b:JSON.parse(t)};const retry=Number(r.headers.get('retry-after'));if(i>=1||!(r.status===429||r.status>=500)||retry>15000)throw new Error(r.status+': '+t.slice(0,300));await new Promise(ok=>setTimeout(ok,Math.max(5500,Number.isFinite(retry)&&retry>0?retry*1000:0)));}}
    console.log('CLIENT_STEP ${label}: nvidia');
    const n=await call({model:nvidia.id,messages:[{role:'user',content:'Reply with exactly ORACLE_NVIDIA_OK.'}],max_tokens:64});
    if(n.r.headers.get('x-broke-router-provider')!=='nvidia')throw new Error('NVIDIA route mismatch');
    console.log('CLIENT_STEP ${label}: gemini');
    const g=await call({model:gemini.id,messages:[{role:'user',content:'Reply with exactly ORACLE_GEMINI_OK.'}],max_tokens:256});
    if(g.r.headers.get('x-broke-router-provider')!=='gemini')throw new Error('Gemini route mismatch');
    console.log('CLIENT_STEP ${label}: context');
    const marker='ORACLECTX'+Date.now(); const affinity='hermes-'+marker;
    const first=await call({model:'free/hermes',route:{affinityKey:affinity},messages:[{role:'user',content:'Remember '+marker+' and acknowledge it.'}],max_tokens:256});
    const second=await call({model:'free/hermes',route:{affinityKey:affinity},messages:[{role:'user',content:'Remember '+marker+' and acknowledge it.'},first.b.choices[0].message,{role:'user',content:'What marker did I give you? Return only it.'}],max_tokens:256});
    if(!String(second.b.choices?.[0]?.message?.content||'').includes(marker))throw new Error('context was not preserved');
    console.log('CLIENT_STEP ${label}: gemini-sse');
    const s=await fetch(base+'/v1/chat/completions',{method:'POST',headers:auth,body:JSON.stringify({model:gemini.id,stream:true,messages:[{role:'user',content:'Reply with exactly ORACLE_STREAM_OK.'}],max_tokens:256})});
    const stream=await s.text(); if(!s.ok||!stream.includes('data:')||!stream.includes('[DONE]'))throw new Error('SSE failed');
    console.log('CLIENT_PASS ${label}');
  `;
  await docker(["run", "--name", client, "--network", network, "-e", `ROUTER_TOKEN=${routerKey}`, "node:22.14-bookworm-slim", "node", "-e", script]);
  const inspect = JSON.parse((await docker(["inspect", client])).output)[0];
  const clientEnvironment = JSON.stringify(inspect.Config.Env ?? []);
  for (const secret of secrets.filter((value) => value !== routerKey)) {
    assert.equal(clientEnvironment.includes(secret), false, "upstream secret leaked to Hermes client");
  }
  await docker(["rm", "-f", client]);
  pass(`Hermes-like client ${label}: models, NVIDIA, Gemini, context affinity, SSE`);
}

async function assertSqliteRecovery() {
  const output = await docker(["exec", router, "node", "--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync('/data/brokerouter.sqlite'); const r=d.prepare('PRAGMA integrity_check').get(); if(r.integrity_check!=='ok') throw new Error(r.integrity_check); const a=d.prepare('SELECT COUNT(*) AS n FROM affinity').get().n; if(a<1) throw new Error('affinity was not persisted'); console.log('SQLITE_OK')"]);
  assert.match(output.output, /SQLITE_OK/);
  pass("abrupt kill recovery + persistent SQLite integrity");
}

function parseDotEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error("Private .env contains an unsupported line (value hidden)");
    let value = match[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}
function accountApiKey(raw) {
  try {
    const account = JSON.parse(raw);
    return typeof account?.apiKey === "string" && account.apiKey.length >= 20 ? [account.apiKey] : [];
  } catch { return []; }
}
function docker(args) { return run("docker", args); }
async function quietly(args) { try { await docker(args); } catch { /* cleanup */ } }
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true }); let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject); child.once("exit", (code) => {
      const safe = redact(output); if (code === 0) resolve({ code, output: safe }); else reject(new Error(`${command} ${args[0]} failed (${code}): ${safe.slice(-2000)}`));
    });
  });
}
function redact(value) { return secrets.reduce((safe, secret) => safe.split(secret).join("[REDACTED]"), String(value)); }
function pass(name) { console.log(`PASS  ${name}`); }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
