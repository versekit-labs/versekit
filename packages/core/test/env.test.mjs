import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const core = new URL("../src/index.mjs", import.meta.url);
const service = new URL("../../cli/src/service.mjs", import.meta.url);
const envReader = new URL("../src/env.mjs", import.meta.url);

function inspect(overrides) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:HIFABU|VERSEKIT|VK)_/.test(name)) delete env[name];
  }
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `
    import { paths } from ${JSON.stringify(core.href)};
    import { labelOf, renderPlist, renderUnit } from ${JSON.stringify(service.href)};
    import { readEnv } from ${JSON.stringify(envReader.href)};
    const options = { label: labelOf(), port: 18787, offline: true };
    console.log(JSON.stringify({ paths: paths(), label: labelOf(), prefix: readEnv("HIFABU_PREFIX"),
      unit: renderUnit(options), plist: renderPlist(options) }));
  `], { encoding: "utf8", env: { ...env, ...overrides } });
  assert.equal(result.status, 0, result.stderr);
  return { data: JSON.parse(result.stdout), stderr: result.stderr };
}

test("ACC-brand-05 legacy values reach runtime and service templates with one stderr warning each", () => {
  const { data, stderr } = inspect({
    VK_HOME: "/example/home",
    VERSEKIT_PREFIX: "/example/install",
    VERSEKIT_SERVICE_LABEL: "com.example.test",
  });
  assert.equal(data.paths.root, "/example/home");
  assert.equal(data.label, "com.example.test");
  assert.equal(data.prefix, "/example/install");
  assert.match(data.unit, /^Environment="HIFABU_HOME=\/example\/home"$/m);
  assert.match(data.unit, /^Environment="HIFABU_PREFIX=\/example\/install"$/m);
  assert.match(data.plist, /<key>HIFABU_HOME<\/key><string>\/example\/home<\/string>/);
  assert.match(data.plist, /<key>HIFABU_PREFIX<\/key><string>\/example\/install<\/string>/);
  assert.doesNotMatch(data.unit + data.plist, /VK_HOME|VERSEKIT_PREFIX/);
  for (const [old, current] of Object.entries({
    VK_HOME: "HIFABU_HOME",
    VERSEKIT_PREFIX: "HIFABU_PREFIX",
    VERSEKIT_SERVICE_LABEL: "HIFABU_SERVICE_LABEL",
  })) {
    assert.equal(stderr.split("\n").filter((line) => line.includes(`${old} 已改名为 ${current}`)).length, 1, stderr);
  }
  assert.doesNotMatch(stderr, /\/example\//);
});

test("ACC-brand-05 new values, including empty values, take precedence without warnings", () => {
  const { data, stderr } = inspect({
    VK_HOME: "/example/old",
    HIFABU_HOME: "/example/new",
    VERSEKIT_PREFIX: "/example/old-install",
    HIFABU_PREFIX: "",
    VERSEKIT_SERVICE_LABEL: "com.example.old",
    HIFABU_SERVICE_LABEL: "com.example.new",
  });
  assert.equal(data.paths.root, "/example/new");
  assert.equal(data.label, "com.example.new");
  assert.equal(data.prefix, "");
  assert.doesNotMatch(data.unit, /Environment="HIFABU_PREFIX=/);
  assert.equal(stderr, "");
});

test("ACC-brand-05 defaults retain the existing configuration and state directories", () => {
  const { data, stderr } = inspect({});
  assert.equal(data.paths.config, join(homedir(), ".config", "versekit"));
  assert.equal(data.paths.state, join(homedir(), ".local", "state", "versekit"));
  assert.equal(data.label, "com.versekit.daemon");
  assert.equal(stderr, "");
});
