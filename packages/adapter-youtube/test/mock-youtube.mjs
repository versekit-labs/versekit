// 本地 mock 的 Google 授权服务器 + YouTube Data API 服务端：开发机测试只连它，不连 googleapis.com，
// 也不用真实 OAuth 客户端。只实现适配器用到的端点；可按需注入错误（配额、429、5xx、断线、被拒、锁私享），
// 并记录每次请求与每次上传的字节范围。

import { createServer } from "node:http";
import { createHash } from "node:crypto";

const SCOPE_BASE = "https://www.googleapis.com/auth/";
export const ALL_SCOPES = ["youtube.upload", "youtube.force-ssl", "yt-analytics.readonly"].map((s) => SCOPE_BASE + s);

export async function startMock(opts = {}) {
  const state = {
    requests: [],
    puts: [], // 每次上传 PUT：{ range, length }
    clientId: "mock_client_id",
    clientSecret: "mock_client_secret",
    scope: ALL_SCOPES.join(" "), // 授权时用户实际勾选的权限
    channel: { id: "UC_mock_1", title: "Mock Channel", avatar: "https://mock.test/a.jpg" },
    codes: new Map(), // code → { challenge }
    refreshToken: null,
    accessToken: null,
    tokens: new Set(), // 发出去的 access_token 都有效（多个账号各持一个）
    expiresIn: 3600,
    tokenRefreshFails: false,
    unauthorized: false, // API 一律 401
    forcePrivate: false, // 项目没过审：回读时 privacyStatus 被锁成 private，publishAt 被丢
    quotaExceeded: false, // videos.insert 起会话就回 403 quotaExceeded
    uploadLimit: false,
    insertStatuses: [], // 前几次起会话回这些 HTTP 状态（429 / 503）
    listStatuses: [], // 前几次 videos.list 回这些状态
    dropAfterChunk: null, // 第 N 块（从 1 数）服务端收下后掐断连接，不回响应
    sessionExpired: false,
    uploadStatus: "uploaded", // 回读里的 status.uploadStatus
    rejectionReason: null,
    failureReason: null,
    missingAfterUpload: 0, // 上传完前 N 次 videos.list 读不到
    failThumbnail: false,
    failCaptions: false,
    playlists: [{ id: "PL_mock_1", title: "Existing List" }],
    failPlaylistItem: false,
    stats: { viewCount: "1234", likeCount: "56", commentCount: "7", favoriteCount: "0" },
    analytics: { rows: [[42, 61]] }, // estimatedMinutesWatched, averageViewDuration
    analyticsFails: false,
    videos: new Map(),
    sessions: new Map(),
    ...opts,
  };
  let seq = 0;
  let videoSeq = 0;

  const json = (res, status, body, headers = {}) => res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
  const gerr = (res, status, reason, message = "mock") =>
    json(res, status, { error: { code: status, message, errors: [{ message, domain: "youtube", reason }], status: "ERR" } });
  const b64sha = (s) => createHash("sha256").update(s).digest("base64url");

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const isSession = url.pathname.startsWith("/upload/session/");
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: isSession ? `(${raw.length} bytes)` : raw.toString("utf8").slice(0, 4000) });
    const auth = req.headers.authorization?.replace("Bearer ", "");

    // ---------------------------------------------------------------- OAuth
    if (url.pathname === "/token") {
      const form = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
      if (form.client_id !== state.clientId || form.client_secret !== state.clientSecret) return json(res, 401, { error: "invalid_client", error_description: "bad client" });
      if (form.grant_type === "authorization_code") {
        const issued = state.codes.get(form.code);
        if (!issued || issued.challenge !== b64sha(form.code_verifier ?? "")) return json(res, 400, { error: "invalid_grant", error_description: "code_verifier mismatch" });
        state.codes.delete(form.code);
        state.lastRedirectUri = form.redirect_uri;
        seq++;
        state.refreshToken = `rt_${seq}`;
      } else if (form.grant_type === "refresh_token") {
        if (state.tokenRefreshFails || form.refresh_token !== state.refreshToken) return json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        seq++;
      }
      state.accessToken = `at_${seq}`;
      state.tokens.add(state.accessToken);
      const body = { access_token: state.accessToken, expires_in: state.expiresIn, scope: state.scope, token_type: "Bearer" };
      if (form.grant_type === "authorization_code" && !state.noRefreshToken) body.refresh_token = state.refreshToken;
      return json(res, 200, body);
    }

    // ---------------------------------------------------------------- 上传会话（可续传）
    if (isSession) {
      const id = url.pathname.split("/").pop();
      const s = state.sessions.get(id);
      if (!s || state.sessionExpired) return json(res, 404, { error: { code: 404, message: "session gone" } });
      const cr = req.headers["content-range"] ?? "";
      const query = /^bytes \*\/(\d+)$/.exec(cr);
      if (query) {
        state.puts.push({ range: cr, length: 0, kind: "query" });
        if (s.received >= s.size) return json(res, 200, finish(s));
        return res.writeHead(308, s.received ? { Range: `bytes=0-${s.received - 1}` } : {}).end();
      }
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
      if (!m) return json(res, 400, { error: { code: 400, message: "bad range" } });
      const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
      state.puts.push({ range: cr, length: raw.length, kind: "chunk" });
      if (start !== s.received) return res.writeHead(308, s.received ? { Range: `bytes=0-${s.received - 1}` } : {}).end(); // 偏移不对：告诉客户端我收到哪了
      if (raw.length !== end - start + 1) return json(res, 400, { error: { code: 400, message: "length mismatch" } });
      const last = end + 1 === total;
      if (!last && raw.length % (256 * 1024) !== 0) return json(res, 400, { error: { code: 400, message: "chunk must be a multiple of 256 KB" } });
      s.received = end + 1;
      s.hash.update(raw);
      if (state.dropAfterChunk != null && --state.dropAfterChunk === 0) {
        state.dropAfterChunk = null;
        return req.socket.destroy(); // 收下了，但连接断了：客户端不知道（dropAfterChunk = 从现在起第 N 块）
      }
      if (last) return json(res, 200, finish(s));
      return res.writeHead(308, { Range: `bytes=0-${end}` }).end();
    }

    // ---------------------------------------------------------------- 需要授权的接口
    if (!auth || state.unauthorized || !state.tokens.has(auth)) return gerr(res, 401, "authError", "Invalid Credentials");

    if (url.pathname === "/upload/youtube/v3/videos") {
      if (state.insertStatuses.length) {
        const status = state.insertStatuses.shift();
        return res.writeHead(status).end();
      }
      if (state.quotaExceeded) return gerr(res, 403, "quotaExceeded", "The request cannot be completed because you have exceeded your quota.");
      if (state.uploadLimit) return gerr(res, 400, "uploadLimitExceeded", "The user has exceeded the number of videos they may upload.");
      const resource = JSON.parse(raw.toString("utf8"));
      const sid = `s${++videoSeq}`;
      state.sessions.set(sid, { id: sid, resource, size: Number(req.headers["x-upload-content-length"]), type: req.headers["x-upload-content-type"], received: 0, hash: createHash("sha256") });
      state.lastInsert = { query: Object.fromEntries(url.searchParams), resource, headers: req.headers };
      return res.writeHead(200, { Location: `http://127.0.0.1:${server.address().port}/upload/session/${sid}` }).end();
    }
    if (url.pathname === "/upload/youtube/v3/thumbnails/set") {
      if (state.failThumbnail) return gerr(res, 403, "forbidden", "thumbnail denied");
      state.thumbnail = { videoId: url.searchParams.get("videoId"), type: req.headers["content-type"], bytes: raw.length };
      return json(res, 200, { items: [{}] });
    }
    if (url.pathname === "/upload/youtube/v3/captions") {
      if (state.failCaptions) return gerr(res, 403, "forbidden", "captions denied");
      state.captions = { body: raw.toString("utf8") };
      return json(res, 200, { id: "cap_1" });
    }
    if (url.pathname === "/youtube/v3/channels") {
      return json(res, 200, { items: state.channel ? [{ id: state.channel.id, snippet: { title: state.channel.title, thumbnails: { default: { url: state.channel.avatar } } } }] : [] });
    }
    if (url.pathname === "/youtube/v3/videos" && req.method === "GET") {
      if (state.listStatuses.length) return res.writeHead(state.listStatuses.shift()).end();
      const id = url.searchParams.get("id");
      const v = state.videos.get(id);
      if (!v) return json(res, 200, { items: [] });
      if (state.missingAfterUpload > 0) {
        state.missingAfterUpload--;
        return json(res, 200, { items: [] });
      }
      const part = url.searchParams.get("part") ?? "";
      const item = { id };
      if (part.includes("status")) item.status = v.status;
      if (part.includes("snippet")) item.snippet = v.snippet;
      if (part.includes("statistics")) item.statistics = state.stats;
      return json(res, 200, { items: [item] });
    }
    if (url.pathname === "/youtube/v3/playlists" && req.method === "GET") {
      return json(res, 200, { items: state.playlists.map((p) => ({ id: p.id, snippet: { title: p.title } })) });
    }
    if (url.pathname === "/youtube/v3/playlistItems" && req.method === "POST") {
      if (state.failPlaylistItem) return gerr(res, 404, "playlistNotFound", "nope");
      state.playlistItem = JSON.parse(raw.toString("utf8"));
      return json(res, 200, { id: "pli_1" });
    }
    if (url.pathname === "/v2/reports") {
      if (state.analyticsFails) return gerr(res, 403, "forbidden", "analytics off");
      return json(res, 200, state.analytics);
    }
    return gerr(res, 404, "notFound");
  });

  /** 上传收齐了：登记视频。forcePrivate 模拟「项目没过审」：privacyStatus 被锁成 private，publishAt 被丢。 */
  function finish(s) {
    if (s.video) return s.video;
    const id = `vid_${s.id}`;
    const req = s.resource;
    const status = { ...req.status, uploadStatus: state.uploadStatus };
    if (state.forcePrivate) {
      status.privacyStatus = "private";
      delete status.publishAt;
    }
    if (state.rejectionReason) status.rejectionReason = state.rejectionReason;
    if (state.failureReason) status.failureReason = state.failureReason;
    state.videos.set(id, { id, snippet: req.snippet, status, sha: s.hash.digest("hex"), size: s.size });
    s.video = { id, snippet: req.snippet, status };
    return s.video;
  }

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    base,
    /** 扮演用户：对授权链接点「同意」。返回回调的响应。 */
    async approve(authorizeUrl, { state: overrideState, code = "code_ok", omitCode = false, error = null } = {}) {
      const u = new URL(authorizeUrl);
      state.lastAuthorize = Object.fromEntries(u.searchParams);
      state.codes.set(code, { challenge: u.searchParams.get("code_challenge") });
      const cb = new URL(u.searchParams.get("redirect_uri"));
      if (!omitCode && !error) cb.searchParams.set("code", code);
      if (error) cb.searchParams.set("error", error);
      cb.searchParams.set("state", overrideState ?? u.searchParams.get("state"));
      return fetch(cb);
    },
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }),
  };
}
