# Hifabu 发版说明

协调器为每个 `app-v<版本>` tag 准备一份独立的 Markdown 发版说明。首行用 `# Hifabu <版本>`，随后按需列出「新增」「修复」「升级说明」。说明应覆盖用户能感知的变化和升级操作。

发版时通过 `--changelog <本版说明.md>` 传入该文件。发布脚本将同一份内容写入版本目录的 `CHANGELOG.md`，并填入 `manifest.json` 的 `notes` 字段。
