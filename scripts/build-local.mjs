import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

await run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.local.json"]);
for (const path of await javascriptFiles("dist")) {
  const source = await readFile(path, "utf8");
  const normalized = source.replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (all, start, specifier, end) =>
    /\.[cm]?js$/.test(specifier) ? all : `${start}${specifier}.js${end}`);
  if (normalized !== source) await writeFile(path, normalized);
}
console.log("Built dist/adapters/node/server.js");

async function javascriptFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await javascriptFiles(path));
    else if (path.endsWith(".js")) paths.push(path);
  }
  return paths;
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`TypeScript exited ${code}`)));
  });
}
