import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

function readProjectPath(root, filename) {
  try {
    const path = realpathSync(join(root, filename));
    const fromRoot = relative(root, path);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      throw new Error(`素材路径指向项目之外：${filename}`);
    }
    return path;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function readConvention(root) {
  const project = basename(root);
  if (/^[a-z0-9-]+$/.test(project)) {
    try {
      const file = new URL(`../../conventions/${project}.json`, import.meta.url);
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`项目「${project}」还没有交付约定。`);
}

const render = (template, fields) => template.replace(/\{(episode|topic|variant)\}/g, (_, name) => fields[name]);
const headingKey = (title) => title.replace(/\s/gu, "").replaceAll("（", "(").replaceAll("）", ")");

function findFile(root, paths) {
  for (const filename of paths) {
    const path = readProjectPath(root, filename);
    if (path && statSync(path).isFile()) return path;
  }
  return null;
}

function readCopy(path, headingPattern, episode, topic, coverNames) {
  if (!path) return null;
  const lines = readFileSync(path, "utf8").replace(/^\uFEFF/, "").normalize("NFC").split(/\r?\n/);
  const heading = new RegExp(headingPattern, "u");
  const key = headingKey(topic);
  const headings = lines.map((line, index) => ({ index, fields: heading.exec(line)?.groups }))
    .filter(({ fields }) => fields?.episode === episode && headingKey(fields.topic) === key);
  if (headings.length > 1) throw new Error(`发布文案.md 里有重复的「${episode} ${topic}」，请确认用哪一节。`);
  if (!headings.length) return null;

  const { index, fields } = headings[0];
  const next = lines.findIndex((line, i) => i > index && /^#{1,2}(?:[ \t]|$)/.test(line));
  const section = lines.slice(index + 1, next < 0 ? undefined : next).filter((line) => {
    const content = line.trim().replace(/^[-*] +/, "").replaceAll("**", "").replaceAll("`", "");
    const labelledCover = /^封面[：:]\s*.+\.(?:png|jpe?g|webp)$/iu.test(content);
    return !labelledCover && !coverNames.includes(basename(content));
  });
  const body = section.join("\n").trim().split("\n");
  const lastLine = body.at(-1).trim();
  const tags = /^#[^\s#]+(?:\s+#[^\s#]+)*$/u.test(lastLine)
    ? body.pop().trim().split(/\s+/u).map((tag) => tag.slice(1))
    : [];
  const text = body.join("\n").trim();
  return text ? { title: `${fields.episode} ${fields.topic}`, body: text, tags } : null;
}

export function inspectEpisode(projectRoot, selector = "", selectedVideo = "") {
  const root = realpathSync(projectRoot);
  const convention = readConvention(root);
  const videoDirectory = readProjectPath(root, convention.videoDirectory);
  if (!videoDirectory) throw new Error(`找不到成片目录：${convention.videoDirectory}`);
  const videoPattern = new RegExp(convention.videoPattern, "u");
  const videos = readdirSync(videoDirectory, { withFileTypes: true }).filter((file) => file.isFile()).flatMap(({ name }) => {
    const fields = videoPattern.exec(name.normalize("NFC"))?.groups;
    if (!fields) return [];
    return [{ name, ...fields, version: Number(fields.version ?? 0) }];
  });
  if (!videos.length) throw new Error(`在 ${convention.videoDirectory}/ 找不到符合约定的带水印成片。`);

  const query = selector.trim().normalize("NFC");
  const numbered = /^(?:第)?([0-9]{1,2})(?:期)?(?:[ _]+(.+))?$/u.exec(query);
  const episode = numbered?.[1].padStart(2, "0") ?? (query ? null : videos.map((video) => video.episode).sort().at(-1));
  const topic = numbered?.[2] ?? (numbered ? null : query);
  const candidates = videos.filter((video) => (!episode || video.episode === episode) && (!topic || video.topic === topic));
  if (!candidates.length) throw new Error(`找不到「${query}」的带水印成片。`);

  const newest = new Map();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.episode, candidate.topic, candidate.variant]);
    if (!newest.has(key) || newest.get(key).version < candidate.version) newest.set(key, candidate);
  }
  const choices = [...newest.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
  const video = selectedVideo ? choices.find(({ name }) => name.normalize("NFC") === selectedVideo.normalize("NFC")) : choices[0];
  if (!video) throw new Error(`所选成片不在本期候选里：${selectedVideo}`);
  if (!selectedVideo && (choices.length > 1 || video.variant)) {
    return { state: "choice_required", choices };
  }

  const title = `${video.episode} ${video.topic}`;
  const stem = `${video.episode}_${video.topic}`;
  const coverPaths = [video.variant && convention.variantCoverTemplate, convention.coverTemplate]
    .filter(Boolean).map((template) => render(template, video));
  const cover = findFile(root, coverPaths);
  const copyVariant = video.variant ?? convention.originalCopyVariants?.[stem];
  const copyTopic = copyVariant ? `${video.topic}（${copyVariant}）` : video.topic;
  const copyPath = readProjectPath(root, convention.copyFile);
  const copy = readCopy(copyPath, convention.copyHeadingPattern, video.episode, copyTopic, coverPaths.map((path) => basename(path)));
  const cut = {
    title,
    ...(cover ? { cover } : {}),
    ...(copy ? { copy: { default: copy } } : {}),
    versions: [{ language: convention.language, asset: join(videoDirectory, video.name) }],
  };
  return {
    state: copy ? "ready" : "missing_copy",
    video,
    coverMissing: !cut.cover,
    copyFile: copyPath ?? join(root, convention.copyFile),
    ...(!copy ? {
      copyHeading: `## ${video.episode} ${copyTopic}`,
      subtitle: readProjectPath(root, render(convention.subtitleTemplate, video)),
    } : {}),
    manifest: { title, source: join(videoDirectory, `${stem}.mp4`), cuts: [cut] },
  };
}

function isMain() {
  try {
    // Node resolves symlinks when loading the script, but argv keeps the path
    // used to invoke it. Claude's cache can be reached through a symlinked HOME.
    return process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const [root = process.cwd(), selector, selectedVideo] = process.argv.slice(2);
    console.log(JSON.stringify(inspectEpisode(root, selector, selectedVideo), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
