/** Next may use an internal request URL hostname; the browser targets the Host header. */
export function hasAllowedPlayOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Non-browser Agent clients may omit Origin.
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  // Forwarded-Host is intentionally ignored: this local service has no trusted proxy config.
  if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.test(host)) return false;
  try {
    return new URL(origin).origin === origin && origin === new URL(`${url.protocol}//${host}`).origin;
  } catch { return false; }
}
