import { createHash, randomBytes } from "node:crypto";

const id = process.argv[2];
if (!id || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
  console.error("Usage: npm run auth:key -- <lowercase-caller-id>");
  process.exit(1);
}

const secret = randomBytes(32).toString("base64url");
const keyHash = createHash("sha256").update(secret).digest("hex");
console.log(`Caller token (show once): brk_${id}.${secret}`);
console.log("Registry entry:");
console.log(JSON.stringify({ [id]: {
  keyHash,
  environment: "production",
  scopes: ["models:read", "chat:write", "jobs:write", "jobs:read"],
} }, null, 2));
