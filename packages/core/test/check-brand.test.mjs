import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const checker = "scripts/ci/check-brand.mjs";
const allowlist = "scripts/ci/brand-allowlist.txt";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "brand-check-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  const git = (...args) => execFileSync("git", args, { cwd });
  git("init", "--quiet");
  mkdirSync(join(cwd, "scripts/ci"), { recursive: true });
  for (const path of [checker, allowlist]) {
    copyFileSync(new URL(`../../../${path}`, import.meta.url), join(cwd, path));
    git("add", "--", path);
  }
  return {
    write(path, contents, tracked = true) {
      const file = join(cwd, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
      if (tracked) git("add", "--", path);
    },
    run(...args) {
      const result = spawnSync(process.execPath, [checker, ...args], { cwd, encoding: "utf8" });
      if (result.error) throw result.error;
      return result;
    },
  };
}

test("品牌检查逐处统计已跟踪的文本，报告模式成功，严格模式拒绝残留", (t) => {
  const repo = fixture(t);
  repo.write("notes with spaces", [
    "VeRsEkIt is still here.",
    "vk --help",
    "Either `vk` or npm run vk -- --help",
    "Not a vk command: `vkey`, npm run vkey, `vk.db`, `vk-next`, `my_vk`, or `vk_profile`.",
    "Set VK_HOME and VERSEKIT_PREFIX.",
    "Use ~/.local/state/versekit.",
    "$ vk run",
  ].join("\r\n"));
  repo.write("packages/web/public/index.html", "<title>VerseKit + versekit</title>\n");
  repo.write("package.json", '{"name":"@versekit-app/core"}\n');
  repo.write("deploy/example.service", "User=versekit\nWorkingDirectory=/opt/versekit\n");
  repo.write("binary", Buffer.from("VerseKit\0VK_HOME"));
  repo.write("untracked.txt", "VerseKit\nvk --help\n", false);

  const report = repo.run();
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /报告模式/);
  assert.match(report.stdout, /用户看得见的字：2 处（packages\/web\/public\/index.html:1）/);
  assert.match(report.stdout, /命令：4 处（notes with spaces:2、notes with spaces:3、notes with spaces:7）/);
  assert.match(report.stdout, /环境变量：2 处（notes with spaces:5）/);
  assert.match(report.stdout, /本机路径：1 处（notes with spaces:6）/);
  assert.match(report.stdout, /内部名字：1 处（package.json:1）/);
  assert.match(report.stdout, /服务器：2 处（deploy\/example.service:1、deploy\/example.service:2）/);
  assert.match(report.stdout, /其他：1 处（notes with spaces:1）/);
  assert.match(report.stdout, /总计：13 处白名单外残留/);

  const strict = repo.run("--strict");
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stdout, /严格模式/);
  assert.match(strict.stdout, /总计：13 处白名单外残留/);
});

test("首批白名单只豁免指定路径或命中片段，严格模式接受零残留", (t) => {
  const repo = fixture(t);
  repo.write("bin/orca-flow.mjs", '// versekit\nconst prefix = "vk";');
  repo.write(".orca-kit/flow.json", '{"project":"versekit"}');
  repo.write("docs/design/ARCH-RETRO-2026-11-21.md", "The old `vk` command in VerseKit.");
  repo.write("packages/cloud/src/relay-control.mjs", 'Buffer.from(`versekit relay account control v1\\0${method}`);');
  repo.write("packages/cloud/src/machine-token.mjs", 'const audience = "versekit-relay";');
  repo.write("links.md", "https://github.com/versekit-labs/versekit.git");

  const clean = repo.run("--strict");
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /总计：0 处白名单外残留/);

  repo.write("links.md", "Use VerseKit from https://github.com/versekit-labs/versekit.git.\nhttps://github.com/versekit-labs/versekit-other");
  repo.write("packages/cloud/src/machine-token.mjs", 'const audience = "versekit-relay"; // VerseKit');
  repo.write("deploy/example.service", "WorkingDirectory=/var/lib/versekit-relay");
  const remaining = repo.run("--strict");
  assert.equal(remaining.status, 1, remaining.stderr);
  assert.match(remaining.stdout, /总计：5 处白名单外残留/);
  assert.match(remaining.stdout, /links.md:1/);
  assert.match(remaining.stdout, /packages\/cloud\/src\/machine-token.mjs:1/);
  assert.match(remaining.stdout, /deploy\/example.service:1/);
});

test("白名单缺少一句话理由时，两种模式都报错并定位行号", (t) => {
  const repo = fixture(t);
  repo.write(allowlist, "# 格式说明\nexempt.txt\t-\t历史文档\t   \n");
  for (const args of [[], ["--strict"]]) {
    const result = repo.run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scripts\/ci\/brand-allowlist.txt:2.*一句话理由/);
  }
});
