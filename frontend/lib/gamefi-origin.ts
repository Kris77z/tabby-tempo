/** No trusted reverse proxy is configured. Only a browser on the loopback origin may mutate paid runs. */
export function hasAllowedGameFiOrigin(request: Request): boolean {
  const url = new URL(request.url), host = request.headers.get("host") ?? url.host;
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host) || !["http:", "https:"].includes(url.protocol)) return false;
  try {
    const target = new URL(`${url.protocol}//${host}`), origin = request.headers.get("origin");
    if (!origin) return request.method === "GET" || request.method === "HEAD";
    return new URL(origin).origin === origin && target.origin === origin;
  } catch { return false; }
}
