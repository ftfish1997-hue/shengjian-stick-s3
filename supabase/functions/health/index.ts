import { jsonResponse } from "../_shared/http.ts";

Deno.serve((request: Request) => {
  if (request.method !== "GET") {
    return jsonResponse({ success: false, error_code: "METHOD_NOT_ALLOWED" }, 405);
  }

  return jsonResponse({
    success: true,
    service: "m5sticks3-voice-inbox",
    stage: 0,
    time: new Date().toISOString(),
  });
});
