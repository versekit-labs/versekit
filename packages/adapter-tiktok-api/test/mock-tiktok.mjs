// 本地 mock 的 TikTok 服务端：开发机测试只连它，不连 open.tiktokapis.com，也不用真实 client_key。
// 只实现适配器用到的端点；可以按需注入错误（429、spam_risk_*、封禁），并记录每次请求。

import { createServer } from "node:http";
import { createHash } from "node:crypto";

export async function startMock(opts = {}) {
  const state = {
    requests: [],
    uploads: [],
    clientKey: "mock_key",
    clientSecret: "mock_secret",
    privacyOptions: ["SELF_ONLY"],
    commentDisabled: false,
    duetDisabled: true,
    stitchDisabled: false,
    maxDuration: 600,
    initError: null, // { status, code }
    creatorError: null,
    tooManyRequests: 0, // 前 N 次 init 回 429
    statusSequence: ["PROCESSING_UPLOAD", "PUBLISH_COMPLETE"],
    failReason: null,
    pollCount: 0,
    codes: new Map(), // code → { challenge }
    tokenRefreshFails: false,
    accessTokenInvalid: false,
    postId: "7300000000000000001",
    ...opts,
  };
  let seq = 0;

  const json = (res, status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const ok = (res, data) => json(res, 200, { data, error: { code: "ok", message: "", log_id: "mock" } });
  const fail = (res, status, code, message = "") => json(res, status, { data: {}, error: { code, message, log_id: "mock" } });

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body: raw.toString("utf8").slice(0, 2000) });
    const auth = req.headers.authorization?.replace("Bearer ", "");

    if (url.pathname === "/v2/oauth/token/") {
      const form = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
      if (form.client_key !== state.clientKey || form.client_secret !== state.clientSecret) {
        return json(res, 401, { error: "invalid_client", error_description: "bad client" });
      }
      if (form.grant_type === "authorization_code") {
        const issued = state.codes.get(form.code);
        // TikTok 校验：code_challenge 是 verifier 的 SHA256 hex
        const expected = createHash("sha256").update(form.code_verifier ?? "").digest("hex");
        if (!issued || issued.challenge !== expected) return json(res, 400, { error: "invalid_grant", error_description: "code_verifier mismatch" });
        state.codes.delete(form.code);
        state.lastRedirectUri = form.redirect_uri;
      } else if (form.grant_type === "refresh_token") {
        if (state.tokenRefreshFails || form.refresh_token !== state.refreshToken) {
          return json(res, 400, { error: "invalid_grant", error_description: "refresh token revoked" });
        }
      }
      seq++;
      state.accessToken = `at_${seq}`;
      state.refreshToken = `rt_${seq}`;
      return json(res, 200, {
        access_token: state.accessToken,
        expires_in: state.expiresIn ?? 86400,
        open_id: "open_1",
        refresh_expires_in: state.refreshExpiresIn ?? 31536000,
        refresh_token: state.refreshToken,
        scope: "user.info.basic,video.publish,video.upload",
        token_type: "Bearer",
      });
    }

    if (url.pathname.startsWith("/upload/")) {
      state.uploads.push({ range: req.headers["content-range"], length: raw.length, type: req.headers["content-type"] });
      const last = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers["content-range"] ?? "");
      return res.writeHead(last && Number(last[2]) + 1 === Number(last[3]) ? 201 : 206).end();
    }

    if (!auth || state.accessTokenInvalid) return fail(res, 401, "access_token_invalid", "token invalid");

    if (url.pathname === "/v2/user/info/") {
      return ok(res, { user: { open_id: "open_1", display_name: "Mock Creator", avatar_url: "https://mock.test/a.jpg" } });
    }
    if (url.pathname === "/v2/post/publish/creator_info/query/") {
      if (state.creatorError) return fail(res, state.creatorError.status ?? 403, state.creatorError.code);
      return ok(res, {
        creator_avatar_url: "https://mock.test/a.jpg",
        creator_username: "mock",
        creator_nickname: "Mock Creator",
        privacy_level_options: state.privacyOptions,
        comment_disabled: state.commentDisabled,
        duet_disabled: state.duetDisabled,
        stitch_disabled: state.stitchDisabled,
        max_video_post_duration_sec: state.maxDuration,
      });
    }
    if (url.pathname === "/v2/post/publish/video/init/" || url.pathname === "/v2/post/publish/inbox/video/init/") {
      if (state.tooManyRequests > 0) {
        state.tooManyRequests--;
        return res.writeHead(429).end();
      }
      if (state.initError) return fail(res, state.initError.status ?? 403, state.initError.code, "mock");
      state.lastInit = { path: url.pathname, body: JSON.parse(raw.toString("utf8")) };
      return ok(res, { publish_id: "v_pub_1", upload_url: `http://127.0.0.1:${server.address().port}/upload/v_pub_1` });
    }
    if (url.pathname === "/v2/post/publish/status/fetch/") {
      const status = state.statusSequence[Math.min(state.pollCount++, state.statusSequence.length - 1)];
      if (status === "FAILED") return ok(res, { status, fail_reason: state.failReason ?? "internal" });
      const done = status === "PUBLISH_COMPLETE";
      return ok(res, { status, ...(done ? { publicaly_available_post_id: [state.postId] } : {}) });
    }
    return fail(res, 404, "not_found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    base,
    /** 扮演用户：对授权链接点「同意」。返回回调的响应。 */
    async approve(authorizeUrl, { state: overrideState, code = "code_ok", omitCode = false, error = null } = {}) {
      const u = new URL(authorizeUrl);
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
