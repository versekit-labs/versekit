import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

export const quietClaude = {
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
};

export function isolatedClaudeEnv(base, home, config, origin) {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    if (/^ANTHROPIC_|^CLAUDE_CODE_USE_|^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(name)) delete env[name];
  }
  return { ...env, ...quietClaude, HOME: home, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_API_KEY: "offline-fixture", NO_PROXY: "127.0.0.1,localhost" };
}

export async function scriptedModel() {
  const fixture = { calls: 0, steps: [], failure: null };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      const step = fixture.steps.shift();
      assert.ok(step, "Unexpected model call");
      const choice = typeof step === "function" ? step(input) : step;
      const count = ++fixture.calls;
      const block = typeof choice === "string" ? { type: "text", text: choice }
        : { type: "tool_use", id: "toolu_fixture" + count, name: choice.name, input: choice.input };
      const isTool = block.type === "tool_use";
      const stop_reason = isTool ? "tool_use" : "end_turn";
      const message = { id: "msg_fixture" + count, type: "message", role: "assistant", model: input.model,
        content: [block], stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      if (!input.stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
        return;
      }
      const send = (type, value) => res.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...value }) + "\n\n");
      res.writeHead(200, { "content-type": "text/event-stream" });
      send("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      send("content_block_start", { index: 0, content_block: isTool ? { ...block, input: {} } : { ...block, text: "" } });
      send("content_block_delta", { index: 0, delta: isTool
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: block.text } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
      send("message_stop", {});
      res.end();
    } catch (error) {
      fixture.failure = error;
      res.writeHead(400, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"invalid_request_error","message":"fixture assertion failed"}}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return Object.assign(fixture, {
    origin: "http://127.0.0.1:" + server.address().port,
    close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  });
}

export async function claudeConversation({ cwd, env, args, prompt, permission, answer = () => null, observe = () => {} }) {
  const child = spawn("claude", [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-prompt-tool", "stdio", "--permission-mode", "manual", "--no-session-persistence", ...args,
  ], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const turns = [];
  const calls = new Set();
  const tools = [];
  const prompts = [];
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const user = (content) => send({ type: "user", message: { role: "user", content } });
  send({ type: "control_request", request_id: "init", request: { subtype: "initialize" } });
  user(prompt);
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const item = JSON.parse(line);
      observe(item);
      if (item.type === "assistant") {
        calls.add(item.message.id);
        for (const block of item.message.content) {
          if (block.type === "tool_use") tools.push({ name: block.name, input: block.input });
        }
      }
      if (item.type === "control_request" && item.request.subtype === "can_use_tool") {
        prompts.push(item.request);
        const response = permission(item.request);
        send({ type: "control_response", response: { subtype: "success", request_id: item.request_id, response } });
      }
      if (item.type !== "result") continue;
      assert.equal(item.subtype, "success", item.result ?? JSON.stringify(item.errors));
      turns.push(item.result);
      const reply = answer(item, turns);
      if (reply) user(reply);
      else child.stdin.end();
    }
    const [code] = await exit;
    assert.equal(code, 0, stderr);
    assert.ok(turns.length, stderr || "No result from Claude");
    return { turns, tools, prompts, calls: calls.size };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
