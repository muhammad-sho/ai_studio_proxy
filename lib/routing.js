const PASS_THROUGH_ACTIONS = new Set([
  "generateContent", "streamGenerateContent", "countTokens", "embedContent",
  "batchEmbedContents", "asyncBatchEmbedContent", "predict", "predictLongRunning",
]);
const INFERENCE_ACTIONS = new Set([...PASS_THROUGH_ACTIONS].filter((action) => action !== "countTokens"));

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

const OPENAI_ALIAS_PATH = /^\/v1\/(?:models(?:\/|$)|chat\/completions|embeddings|images\/generations|audio\/(?:transcriptions|translations|speech)|files(?:\/|$)|batches(?:\/|$)|fine_tuning\/jobs(?:\/|$)|moderations)$/;
const OPENAI_INFERENCE_PATH = /^(?:chat\/completions|embeddings|images\/generations|audio\/(?:transcriptions|translations|speech)|moderations)$/;

function isOpenAiCompatibilityRoute(pathname, headers = {}) {
  if (/^\/(?:v1alpha|v1beta|v1)\/openai(?:\/|$)/.test(pathname)) return true;
  if (!OPENAI_ALIAS_PATH.test(pathname)) return false;
  // /v1/models is shared by native Gemini discovery and OpenAI clients. Treat
  // it as OpenAI only when the caller proves that intent with Bearer auth.
  return /^Bearer\s+\S+$/i.test(String(headers.authorization || ""));
}

function isOpenAiInferenceRoute(pathname, headers = {}) {
  if (!isOpenAiCompatibilityRoute(pathname, headers)) return false;
  const explicit = pathname.match(/^\/(?:v1alpha|v1beta|v1)\/openai\/(.+)$/);
  const alias = pathname.match(/^\/v1\/(.+)$/);
  return OPENAI_INFERENCE_PATH.test(explicit?.[1] || alias?.[1] || "");
}

function isMetadataRoute(pathname, method = "GET", headers = {}) {
  if (/^\/(?:v1alpha|v1beta|v1)\/models\/[^/:]+:countTokens$/.test(pathname)) return true;
  if (method === "GET" && /^\/(?:v1alpha|v1beta|v1)\/models(?:\/[^/:]+)?$/.test(pathname)) return true;
  if (method === "GET" && /^\/(?:v1alpha|v1beta|v1)\/openai\/models(?:\/[^/]+)?$/.test(pathname)) return true;
  if (method === "GET" && /^\/v1\/models(?:\/[^/]+)?$/.test(pathname) && isOpenAiCompatibilityRoute(pathname, headers)) return true;
  if (/^\/upload\/(?:v1alpha|v1beta|v1)\//.test(pathname)) return true;
  if (/^\/(?:v1alpha|v1beta|v1)\/(?:cachedContents|files|batches|operations|tunedModels)(?:\/|$)/.test(pathname)) return true;
  if (/^\/(?:v1alpha|v1beta|v1)\/openai\/(?:batches|files)(?:\/|$)/.test(pathname)) return true;
  if (/^\/v1\/(?:files|batches)(?:\/|$)/.test(pathname) && isOpenAiCompatibilityRoute(pathname, headers)) return true;
  return false;
}

function requestModelFromBody(body) {
  if (!body || !body.length) return null;
  try {
    const payload = JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body));
    const model = typeof payload?.model === "string" ? payload.model.trim() : "";
    return model || null;
  } catch { return null; }
}

function classifyRoute(pathname, method, urlModel, action, body, headers) {
  if (isMetadataRoute(pathname, method, headers)) {
    return { kind: "metadata", model: null, statsModel: null, logModel: "[metadata]", trackUsage: false };
  }
  const model = urlModel || requestModelFromBody(body);
  const nativeInference = Boolean(model && method === "POST" && INFERENCE_ACTIONS.has(action || ""));
  const openAiInference = Boolean(model && method === "POST" && isOpenAiInferenceRoute(pathname, headers));
  if (nativeInference || openAiInference) {
    return {
      kind: "inference",
      model,
      statsModel: action ? statsModelName(model, action, pathname) : model,
      logModel: model,
      trackUsage: true,
    };
  }
  return {
    kind: "passthrough",
    model: null,
    statsModel: null,
    logModel: (isOpenAiInferenceRoute(pathname, headers) || (action && !INFERENCE_ACTIONS.has(action)))
      ? "[unidentified inference]" : "[untracked endpoint]",
    trackUsage: false,
  };
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

module.exports = {
  requestPath, parseApiRoute, parseUploadRoute, routeFamily, statsModelName,
  isOpenAiCompatibilityRoute, isOpenAiInferenceRoute, isMetadataRoute, requestModelFromBody, classifyRoute,
};
