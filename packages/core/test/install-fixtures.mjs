// Simulate the P1 download layout with the real P2 template and local artifacts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const template = readFileSync(new URL("../../../deploy/hifabu/install-template.sh", import.meta.url), "utf8");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const NODE_VERSION = "v26.99.0";

export function fakeRelease(base, { version, commit, platform, app, node, components = {} }) {
  const payload = (name, bytes) => ({ url: `${base}/${name}`, size: bytes.length, sha256: sha(bytes) });
  const manifest = {
    schema: "hifabu.release/1",
    version,
    commit,
    releasedAt: "2026-11-26",
    app: payload(`${version}/app.tar.gz`, app),
    node: { version: NODE_VERSION, files: { [platform]: payload("deps/node.tar.gz", node) } },
    components: Object.fromEntries(Object.entries(components).map(([name, bytes]) => [
      name,
      { version: "1.0.0", files: { [platform]: payload(`deps/${name}.tar.gz`, bytes) } },
    ])),
    notes: "离线测试版本（含 '引号'）。",
  };
  const encoded = JSON.stringify(manifest, null, 2);
  const script = template.replace("@HIFABU_RELEASE_MANIFEST@", () => `'${encoded.replaceAll("'", "'\\''")}'`);
  return {
    "/latest.json": JSON.stringify({ version, manifest: `${version}/manifest.json`, sha256: sha(encoded + "\n") }),
    [`/${version}/manifest.json`]: encoded + "\n",
    [`/${version}/SHA256SUMS`]: `${sha(script)}  install.sh\n${sha(encoded + "\n")}  manifest.json\n`,
    [`/${version}/install.sh`]: script,
    [`/${version}/app.tar.gz`]: app,
    "/deps/node.tar.gz": node,
    ...Object.fromEntries(Object.entries(components).map(([name, bytes]) => [`/deps/${name}.tar.gz`, bytes])),
  };
}
