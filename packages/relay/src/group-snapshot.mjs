import { looksLikeLocalPath } from "./delivery-v1.mjs";

/** Project explicitly at the storage boundary as well as on the publisher. */
export function projectGroupSnapshot(snapshot, deviceId) {
  const bad = () => {
    throw Object.assign(new Error("账号组同步资料格式不正确，请在发布机核对设备名和账号组。"), {
      code: "invalid_group_snapshot", status: 400,
    });
  };
  const label = (value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 255 || looksLikeLocalPath(value)) bad();
    return value;
  };
  if (!Number.isSafeInteger(snapshot?.reportedAt) || snapshot.reportedAt <= 0 || !Array.isArray(snapshot.groups)) bad();
  return {
    device: { id: label(deviceId ?? snapshot.device?.id), name: label(snapshot.device?.name) },
    reportedAt: snapshot.reportedAt,
    groups: snapshot.groups.map((group) => {
      if (!Array.isArray(group?.accounts)) bad();
      return {
        name: label(group.name),
        ...(typeof group.default === "boolean" ? { default: group.default } : {}),
        accounts: group.accounts.map((account) => ({ platform: label(account?.platform), name: label(account?.name) })),
      };
    }),
  };
}
