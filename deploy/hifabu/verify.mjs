import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const hifabu = "https://hifabu.com";
const callback = hifabu + "/login/google/callback";
const keyPath = "/.well-known/hifabu-machine-key.pem";

export async function verifyDeployment(expectedPem, request = fetch) {
  const check = async (url, status, options) => {
    const response = await request(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(10_000) })
      .catch(() => { throw new Error(`无法请求 ${url}。`); });
    if (response.status !== status) throw new Error(`${url} 返回 ${response.status}，预期 ${status}。`);
    return response;
  };
  await check("https://assurelane.ai/", 200);
  await check(hifabu + "/", 200);
  const key = await check(hifabu + keyPath, 200);
  if ((await key.text()).trim() !== expectedPem.trim()) {
    throw new Error("hifabu.com 返回的机器公钥与服务器签名私钥不匹配。");
  }
  const login = await check(hifabu + "/login", 200);
  if (!(await login.text()).includes('action="/login/google"')) {
    throw new Error("/login 缺少 Google 登录表单。");
  }
  const google = await check(hifabu + "/login/google", 303, {
    method: "POST",
    headers: { Origin: hifabu },
    body: new URLSearchParams(),
  });
  const location = new URL(google.headers.get("Location") ?? "", hifabu);
  if (location.origin !== "https://accounts.google.com" ||
      location.searchParams.getAll("redirect_uri").length !== 1 ||
      location.searchParams.get("redirect_uri") !== callback) {
    throw new Error("Google 登录跳转的来源或回调地址不符。");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const key = createPrivateKey(readFileSync(process.argv[2]));
    const expected = createPublicKey(key).export({ type: "spki", format: "pem" });
    await verifyDeployment(expected);
    console.log("自检通过：两个首页、公钥、Google 登录跳转与回调地址。");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
