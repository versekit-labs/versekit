import schema from "../../../schemas/delivery-v1.json" with { type: "json" };

export const DELIVERY_V1 = schema.properties.schema.const;
export const ACCEPTED_DELIVERY_SCHEMAS = Object.freeze([DELIVERY_V1]);
export const DELIVERY_UPGRADE = "请先更新发布机上的 Hifabu，再从制作机重新交付。";

export const isVersionedDelivery = (manifest) => manifest != null && Object.hasOwn(manifest, "schema");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const problem = (code, message, hint) => Object.assign(new Error(message), { code, hint });

export function unsupportedDelivery() {
  return problem("schema_unsupported", "发布机上的 Hifabu 不支持这个交付清单版本。", DELIVERY_UPGRADE);
}

export function looksLikeLocalPath(value) {
  const text = value.trimStart();
  return /^(?:[/\\~]|[A-Za-z]:)/.test(text) || text.includes("..") || text.includes("\0");
}

// Check extension fields too. The relay stores v1 verbatim, even when an older reader ignores them.
export function assertNoLocalPaths(...values) {
  while (values.length) {
    const value = values.pop();
    if (typeof value === "string" && looksLikeLocalPath(value)) {
      throw problem("local_path_in_manifest", "交付清单含本机路径或上级目录写法，请改成期标识或文件名后重新交付。");
    }
    if (Array.isArray(value)) {
      for (const entry of value) values.push(entry);
    } else if (isObject(value)) {
      for (const [key, entry] of Object.entries(value)) values.push(key, entry);
    }
  }
}

// The published schema uses only these validation keywords. Unknown object properties are allowed.
function validate(value, rule, field) {
  if (rule.$ref) rule = schema.$defs[rule.$ref.slice("#/$defs/".length)];
  const invalid = () => { throw problem("invalid_manifest", "交付清单的 " + field + " 字段格式不正确。"); };
  switch (rule.type) {
    case "object":
      if (!isObject(value)) invalid();
      for (const key of rule.required ?? []) {
        if (!Object.hasOwn(value, key)) throw problem("invalid_manifest", "交付清单缺少 " + field + "." + key + "。");
      }
      for (const [key, property] of Object.entries(rule.properties ?? {})) {
        if (Object.hasOwn(value, key)) validate(value[key], property, field + "." + key);
      }
      break;
    case "array":
      if (!Array.isArray(value) || value.length < (rule.minItems ?? 0)) invalid();
      value.forEach((item, i) => validate(item, rule.items, field + "[" + i + "]"));
      break;
    case "string":
      if (typeof value !== "string" || (rule.maxLength != null && [...value].length > rule.maxLength) ||
          (rule.pattern && !new RegExp(rule.pattern, "u").test(value))) invalid();
      break;
    case "integer":
      if (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum) invalid();
      break;
  }
  if (Object.hasOwn(rule, "const") && value !== rule.const) invalid();
}

export function validateDeliveryV1(manifest) {
  if (manifest?.schema !== DELIVERY_V1) throw unsupportedDelivery();
  assertNoLocalPaths(manifest);
  validate(manifest, schema, "manifest");
}

export const deliveryFiles = (manifest) => manifest.cuts.flatMap(({ video, cover }) => cover ? [video, cover] : [video]);
export const deliveryFileKey = ({ sha256, name }) => sha256.toLowerCase() + ":" + name;
export const deliveryTitle = (manifest) => (isVersionedDelivery(manifest) ? manifest.work?.title : manifest?.title) ?? null;

/** Match the declarations to the existing transport envelope by content, independent of filenames. */
export function validateDeliveryEnvelope({ manifest, group, blobs }) {
  validateDeliveryV1(manifest);
  assertNoLocalPaths(group, blobs);
  const sizes = new Map(blobs.map(({ sha256, size }) => [sha256, size]));
  const files = deliveryFiles(manifest);
  if (typeof group !== "string" || manifest.target.group.trim() !== group.trim() || sizes.size !== blobs.length ||
      new Set(files.map((file) => file.sha256.toLowerCase())).size !== sizes.size ||
      files.some((file) => sizes.get(file.sha256.toLowerCase()) !== file.size)) {
    throw problem("invalid_manifest", "交付清单的目标组或文件哈希、大小与投递登记不一致。");
  }
}

/** Return only v1 copy fields understood by this reader, including at each platform level. */
export function deliveryCopy(copy) {
  if (!copy) return undefined;
  const platforms = Object.keys(schema.properties.cuts.items.properties.copy.properties);
  const fields = Object.keys(schema.$defs.copy.properties);
  return Object.fromEntries(platforms.filter((platform) => Object.hasOwn(copy, platform))
    .map((platform) => [platform, Object.fromEntries(fields.filter((key) => Object.hasOwn(copy[platform], key))
      .map((key) => [key, copy[platform][key]]))]));
}
