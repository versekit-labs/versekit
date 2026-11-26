import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deliverySchema, validateDeliveryV1 } from "../src/delivery-v1.mjs";

const docs = readFileSync(new URL("../../../docs/delivery-interface.md", import.meta.url), "utf8");
const publicSchema = JSON.parse(readFileSync(new URL("../../../schemas/delivery-v1.json", import.meta.url), "utf8"));
const examples = [...docs.matchAll(/```json\n([\s\S]+?)\n```/g)].map((match) => JSON.parse(match[1])).filter((example) => Object.hasOwn(example, "schema"));

test("ACC-iface-01 JSON Schema 接受文档里的全部清单示例，拒绝缺目标组、坏哈希和未知主版本", () => {
  assert.deepEqual(deliverySchema, publicSchema, "发布机和中转部署使用与公开文件相同的规则");
  assert.equal(examples.length, 2);
  for (const example of examples) {
    assert.doesNotThrow(() => validateDeliveryV1(example));
    const noGroup = structuredClone(example);
    delete noGroup.target.group;
    assert.throws(() => validateDeliveryV1(noGroup), { code: "invalid_manifest", message: /target\.group/ });
    const badSha = structuredClone(example);
    badSha.cuts[0].video.sha256 = "g".repeat(64);
    assert.throws(() => validateDeliveryV1(badSha), { code: "invalid_manifest", message: /sha256/ });
    assert.throws(() => validateDeliveryV1({ ...example, schema: "hifabu.delivery/2" }), { code: "schema_unsupported" });
  }
});
