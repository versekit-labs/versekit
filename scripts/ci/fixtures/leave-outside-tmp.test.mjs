// 给 packages/core/test/test-all-check.test.mjs 用：故意在 /tmp 下留一个 vk* 目录（不删）。
// 预加载的收尾工具只管 mkdtemp 出来的目录；这里用 mkdirSync，模拟「漏了收尾」的测试。
import { readEnv } from "../../../packages/core/src/env.mjs";
import { test } from "node:test";
import { mkdirSync } from "node:fs";

test("留一个 vk* 目录在 /tmp 下", () => {
  mkdirSync(readEnv("HIFABU_LEAVE_DIR"), { recursive: true });
});
