const PASS_THROUGH_ACTIONS = new Set([
  "generateContent", "streamGenerateContent", "countTokens", "embedContent",
  "batchEmbedContents", "asyncBatchEmbedContent", "predict", "predictLongRunning",
]);

function requestPath(request) {
  try { return new URL(request.url, "http://localhost").pathname; } catch { return request.url.split("?")[0]; }
}

function parseApiRoute(pathname) {
  const match = pathname.match(/^\/(?:v1alpha|v1beta|v1)(\/.*)$/);
  if (!match) return null;
  let rest;
  try { rest = decodeURIComponent(match[1]); } catch { return null; }
  const modelAction = rest.match(/^\/models\/([^/:]+):([A-Za-z]+)$/);
  if (modelAction) return { model: modelAction[1], action: modelAction[2] };
  return { model: null, action: null, subpath: rest };
}

function isOpenAiCompatibilityRoute(pathname) {
  return /^\/(?:v1alpha|v1beta|v1)\/openai(?:\/|$)/.test(pathname);
}

function parseUploadRoute(pathname) {
  const match = pathname.match(/^\/upload\/(v1alpha|v1beta|v1)(\/.*)$/);
  if (!match) return null;
  return { version: match[1], subpath: match[2] };
}

function routeFamily(pathname) {
  if (pathname === "/health") return "both";
  if (pathname === "/" || pathname === "/api/setup" || pathname === "/login" || pathname === "/logout" ||
      pathname === "/reset-password" || pathname === "/api/password-reset-code" || pathname === "/api/reset-password" ||
      pathname === "/dashboard.css" || pathname === "/dashboard.js" || pathname.startsWith("/panels/") ||
      pathname.startsWith("/api/admin")) return "admin";
  if (parseApiRoute(pathname) || parseUploadRoute(pathname)) return "api";
  return null;
}

function statsModelName(model, action, fallbackPath) {
  if (!model) return fallbackPath || "api";
  return PASS_THROUGH_ACTIONS.has(action || "") ? model : `${model}:${action}`;
}

module.exports = { requestPath, parseApiRoute, parseUploadRoute, routeFamily, statsModelName, isOpenAiCompatibilityRoute };
