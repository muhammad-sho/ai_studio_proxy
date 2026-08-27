function createHttpHelpers({ corsOrigin, maxBodyBytes }) {
  function json(response, status, value) {
    if (response.writableEnded || response.destroyed) return;
    const body = JSON.stringify(value);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  function securityHeaders(response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Access-Control-Allow-Origin", corsOrigin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, x-goog-api-key, x-goog-upload-offset, x-goog-upload-command, x-goog-upload-protocol, x-goog-upload-header-content-length, x-goog-upload-header-content-type, x-goog-upload-status");
    response.setHeader("Access-Control-Max-Age", "86400");
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let bytes = 0;
      let failed = false;
      request.on("data", (chunk) => {
        if (failed) return;
        bytes += chunk.length;
        if (bytes > maxBodyBytes) {
          failed = true;
          chunks.length = 0;
          request.resume();
          reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
      request.on("error", (error) => { if (!failed) { failed = true; reject(error); } });
    });
  }

  return { json, securityHeaders, readBody };
}

module.exports = { createHttpHelpers };
