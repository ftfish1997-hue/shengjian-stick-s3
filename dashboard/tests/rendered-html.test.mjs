import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the private voice inbox dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>声笺 · M5 StickS3 语音收件箱<\/title>/i);
  assert.match(html, /最近录音/);
  assert.match(html, /每日日报/);
  assert.match(html, /WEEKLY REVIEW/);
  assert.match(html, /查看入口尚未配置正式数据连接/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
  assert.doesNotMatch(html, /SUPABASE_SERVICE_ROLE_KEY|DASHBOARD_READ_TOKEN/i);
});

test("keeps the public HTML free of private backend details", async () => {
  const response = await render();
  const html = await response.text();
  assert.doesNotMatch(html, /audio_path|token_hash|service_role/i);
  assert.doesNotMatch(html, /SUPABASE_URL|DASHSCOPE_API_KEY/i);
  assert.match(html, /数据更新时间/);
});
