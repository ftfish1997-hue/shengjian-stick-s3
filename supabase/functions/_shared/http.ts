export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

export function notImplemented(functionName: string): Response {
  return jsonResponse(
    {
      success: false,
      error_code: "NOT_IMPLEMENTED",
      function: functionName,
      stage: 0,
    },
    501,
  );
}
