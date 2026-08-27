const crypto = require("node:crypto");

function createDashboardAssets({ fs, zlib, json }) {
  const staticPageCache = new Map();
  const dashboardAssetCache = new Map();

  function staticPage(name) {
    if (!staticPageCache.has(name)) staticPageCache.set(name, fs.readFileSync(name, "utf8"));
    return staticPageCache.get(name);
  }

  function loadDashboardAsset(file) {
    let entry = dashboardAssetCache.get(file);
    if (!entry) {
      const buffer = fs.readFileSync(`dashboard/${file}`);
      entry = {
        buffer,
        gzip: zlib.gzipSync(buffer),
        etag: `W/"${crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16)}"`,
        mime: file.endsWith(".css") ? "text/css; charset=utf-8" : (file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8"),
      };
      dashboardAssetCache.set(file, entry);
    }
    return entry;
  }

  function writeAsset(response, entry, request) {
    const headers = {
      "Content-Type": entry.mime,
      "Cache-Control": "private, max-age=0, must-revalidate",
      ETag: entry.etag,
      Vary: "Accept-Encoding",
    };
    if ((request.headers["if-none-match"] || "").split(",").map((value) => value.trim()).includes(entry.etag)) {
      response.writeHead(304, headers);
      return response.end();
    }
    if ((request.headers["accept-encoding"] || "").includes("gzip")) {
      response.writeHead(200, { ...headers, "Content-Encoding": "gzip" });
      return response.end(entry.gzip);
    }
    response.writeHead(200, headers);
    return response.end(entry.buffer);
  }

  function sendDashboard(request, response) {
    return writeAsset(response, loadDashboardAsset("index.html"), request);
  }

  function serveDashboardAsset(request, response, assetPath) {
    let file;
    if (assetPath === "/dashboard.css" || assetPath === "/dashboard.js") {
      file = assetPath.slice(1);
    } else if (assetPath.startsWith("/panels/") && assetPath.endsWith(".html")) {
      const name = assetPath.slice("/panels/".length, -".html".length);
      if (!["overview", "gemini-keys", "client-keys", "request-logs", "statistics"].includes(name)) {
        return json(response, 404, { error: "Not found" });
      }
      file = `panels/${name}.html`;
    } else {
      return json(response, 404, { error: "Not found" });
    }
    return writeAsset(response, loadDashboardAsset(file), request);
  }

  return { staticPage, sendDashboard, serveDashboardAsset };
}

module.exports = { createDashboardAssets };
