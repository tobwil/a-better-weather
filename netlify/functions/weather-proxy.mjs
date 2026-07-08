const FUNCTION_PREFIX = "/.netlify/functions/weather-proxy";

export default async function handler(request) {
  const backendBase = normalizeBackendUrl(process.env.WEATHER_BACKEND_URL);
  if (!backendBase) {
    return jsonResponse(
      {
        error: "WEATHER_BACKEND_URL fehlt. Netlify hostet hier das Frontend; die Python-Wetter-API muss als Backend erreichbar sein.",
      },
      500,
    );
  }

  const requestUrl = new URL(request.url);
  const upstreamPath = normalizeProxyPath(requestUrl.pathname);
  const upstreamUrl = new URL(`${backendBase}${upstreamPath}`);
  upstreamUrl.search = requestUrl.search;

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: filteredHeaders(request.headers),
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });

  const headers = new Headers();
  const contentType = upstreamResponse.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store, max-age=0");

  return new Response(await upstreamResponse.arrayBuffer(), {
    status: upstreamResponse.status,
    headers,
  });
}

function normalizeBackendUrl(value) {
  if (!value) return "";
  return value.replace(/\/+$/, "");
}

function normalizeProxyPath(pathname) {
  let path = pathname.startsWith(FUNCTION_PREFIX)
    ? pathname.slice(FUNCTION_PREFIX.length)
    : pathname;
  if (!path.startsWith("/")) path = `/${path}`;
  if (path === "/") return "/api/learning/dashboard";
  return path;
}

function filteredHeaders(headers) {
  const result = new Headers(headers);
  result.delete("host");
  result.delete("x-nf-client-connection-ip");
  result.delete("x-nf-request-id");
  return result;
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
    },
  });
}
