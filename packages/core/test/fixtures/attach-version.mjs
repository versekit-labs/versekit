// 测试夹具：给直接 INSERT 出来的平台稿补上成片与语言版本（ACC-v2-confirm-07）。
//
// 平台稿的素材由 core 按 version_id 解析，不再兜底读作品表。老测试直接插 work + publish，
// 这里补一支成片、一个版本（素材 = 传入路径，默认沿用作品的素材），并把 publish 指过去。

export function attachVersion(db, publishId, asset = null) {
  const p = db.prepare("SELECT work_id FROM publish WHERE id = ?").get(publishId);
  if (!p) throw new Error(`fixture: 没有平台稿 ${publishId}`);
  const path = asset ?? db.prepare("SELECT asset_path FROM work WHERE id = ?").get(p.work_id).asset_path;
  const cutId = `cut_${publishId}`;
  const versionId = `ver_${publishId}`;
  const now = Date.now();
  db.prepare("INSERT INTO cut (id, work_id, title, position, created_at) VALUES (?,?,?,0,?)").run(cutId, p.work_id, `成片 ${publishId}`, now);
  db.prepare("INSERT INTO cut_version (id, cut_id, language, asset_path, created_at) VALUES (?,?, 'default', ?, ?)").run(versionId, cutId, path, now);
  db.prepare("UPDATE publish SET cut_id = ?, version_id = ? WHERE id = ?").run(cutId, versionId, publishId);
  return { cutId, versionId };
}
