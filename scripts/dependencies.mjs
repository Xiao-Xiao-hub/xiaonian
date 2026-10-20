import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(root, "server");
const lockBytes = fs.readFileSync(path.join(server, "package-lock.json"));
const lock = JSON.parse(lockBytes.toString("utf8"));

// The lockfile is the only input: installed packages and local time must not
// change a checked-in inventory produced from the same dependency revision.
const packages = Object.entries(lock.packages || {})
  .filter(([name]) => name)
  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  .map(([location, item]) => {
    return {
      path: location,
      name: item.name || location.split("node_modules/").pop(),
      version: item.version,
      license: item.license || "UNDECLARED",
      devOnly: !!item.dev,
      ...(item.resolved ? { registryUrl: item.resolved } : {}),
      ...(item.integrity ? { integrity: item.integrity } : {}),
    };
  });
const report = {
  schema: "dependency-inventory-v2",
  source: "server/package-lock.json",
  lockfileSha256: createHash("sha256").update(lockBytes).digest("hex"),
  note: "Package declarations only. Preserve the original license and notice files when distributing dependency packages or built images.",
  packages,
};
fs.writeFileSync(
  path.join(root, "docs", "dependencies.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    packages: packages.length,
    unrecordedLicenses: packages.filter((p) => p.license === "UNDECLARED")
      .length,
  }),
);
