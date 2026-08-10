import { createHash, randomBytes } from "node:crypto";

const id = process.argv[2];
if (!id || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
  console.error("Usage: npm run auth:key -- <lowercase-caller-id> [--admin] [--paid]");
  process.exit(1);
}

const secret = randomBytes(32).toString("base64url");
const keyHash = createHash("sha256").update(secret).digest("hex");
const scopes = ["models:read", "chat:write", "jobs:write", "jobs:read", "workflows:write", "workflows:read"];
if (process.argv.includes("--admin")) scopes.push("stats:read", "policy:write");
if (process.argv.includes("--paid")) scopes.push("providers:paid");
console.log(`Caller token (show once): brk_${id}.${secret}`);
console.log("Registry entry:");
console.log(JSON.stringify({ [id]: {
  keyHash,
  environment: "production",
  scopes,
} }, null, 2));
