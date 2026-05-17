const crypto = require("node:crypto");


const parseCookies = (header) => {
  const raw = typeof header === "string" ? header : "";
  if (!raw.trim()) return {};
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
};

/** Constant-time string comparison to prevent timing attacks. */
const safeCompare = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare against self to burn constant time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
};

/** Simple in-memory rate limiter for auth attempts. */
const createRateLimiter = (maxAttempts = 10, windowMs = 60_000) => {
  const attempts = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of attempts) {
      if (now - entry.start > windowMs) attempts.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return {
    isLimited(ip) {
      const entry = attempts.get(ip);
      if (!entry) return false;
      return entry.count >= maxAttempts;
    },
    recordFailure(ip) {
      const now = Date.now();
      const entry = attempts.get(ip);
      if (!entry || now - entry.start > windowMs) {
        attempts.set(ip, { count: 1, start: now });
        return;
      }
      entry.count++;
    },
    reset(ip) {
      attempts.delete(ip);
    },
  };
};

/**
 * Resolve client IP for rate limiting.
 * When TRUSTED_PROXY=1 is set, the first value of X-Forwarded-For is used.
 * Only set TRUSTED_PROXY=1 when this server sits behind a reverse proxy that
 * you control (nginx, Caddy, Vercel edge). Without it, X-Forwarded-For is
 * ignored to prevent spoofing by direct clients.
 */
const resolveClientIp = (req) => {
  if (process.env.TRUSTED_PROXY === "1") {
    const forwarded = req.headers?.["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress || "unknown";
};

function createAccessGate(options) {
  const token = String(options?.token ?? "").trim();
  const cookieName = String(options?.cookieName ?? "studio_access").trim() || "studio_access";

  const enabled = Boolean(token);
  const rateLimiter = createRateLimiter(10, 60_000);

  const getAuthState = (req) => {
    if (!enabled) return { authorized: true, limited: false };
    const ip = resolveClientIp(req);
    const cookieHeader = req.headers?.cookie;
    const cookies = parseCookies(cookieHeader);
    const authorized = safeCompare(cookies[cookieName] || "", token);
    if (authorized) {
      rateLimiter.reset(ip);
      return { authorized: true, limited: false };
    }
    if (rateLimiter.isLimited(ip)) {
      return { authorized: false, limited: true };
    }
    rateLimiter.recordFailure(ip);
    return { authorized: false, limited: rateLimiter.isLimited(ip) };
  };

  const handleHttp = (req, res) => {
    if (!enabled) return false;

    // Handle login form POST - must be checked before auth
    if (req.method === "POST" && String(req.url || "/") === "/_studio_login") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const submitted = params.get("token") || "";
        const redirect = params.get("redirect") || "/";
        if (safeCompare(submitted, token)) {
          res.statusCode = 302;
          res.setHeader("Location", redirect);
          res.setHeader("Set-Cookie", `${cookieName}=${token}; Path=/; Max-Age=86400; SameSite=Lax`);
          res.end();
        } else {
          res.statusCode = 302;
          res.setHeader("Location", `/_studio_login?error=1&redirect=${encodeURIComponent(redirect)}`);
          res.end();
        }
      });
      return true;
    }

    const auth = getAuthState(req);
    if (!auth.authorized) {
      const statusCode = auth.limited ? 429 : 401;
      if (String(req.url || "/").startsWith("/api/")) {
        res.statusCode = statusCode;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: auth.limited
              ? "Too many failed studio access attempts. Wait a minute and retry."
              : "Studio access token required. Send the configured Studio access cookie and retry.",
          })
        );
      } else {
        const currentUrl = encodeURIComponent(req.url || "/");
        const errorMsg = auth.limited ? "too-many" : (String(req.url || "/").includes("error=1") ? "invalid" : "");
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claw3D - Acesso</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #1e293b;
      padding: 2rem;
      border-radius: 12px;
      width: 100%;
      max-width: 400px;
      margin: 1rem;
      box-shadow: 0 4px 24px rgba(0,0,0,0.3);
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
      color: #facc15;
    }
    p {
      color: #94a3b8;
      margin-bottom: 1.5rem;
      font-size: 0.875rem;
    }
    input {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid #334155;
      border-radius: 8px;
      background: #0f172a;
      color: #e2e8f0;
      font-size: 1rem;
      margin-bottom: 1rem;
    }
    input:focus {
      outline: 2px solid #facc15;
      border-color: transparent;
    }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #facc15;
      color: #0f172a;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #eab308; }
    .error {
      background: #7f1d1d;
      color: #fca5a5;
      padding: 0.75rem;
      border-radius: 8px;
      margin-bottom: 1rem;
      font-size: 0.875rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔐 Claw3D</h1>
    <p>Digite o token de acesso para entrar no estúdio.</p>
    ${errorMsg === "invalid" ? '<div class="error">❌ Token inválido. Tente novamente.</div>' : ""}
    ${errorMsg === "too-many" ? '<div class="error">⚠️ Muitas tentativas. Aguarde 1 minuto.</div>' : ""}
    <form method="POST" action="/_studio_login">
      <input type="hidden" name="redirect" value="${currentUrl}">
      <input type="password" name="token" placeholder="Token de acesso" autofocus>
      <button type="submit">Entrar</button>
    </form>
  </div>
</body>
</html>`);
      }
      return true;
    }
    return false;
  };

  const allowUpgrade = (req) => {
    if (!enabled) return true;
    return getAuthState(req).authorized;
  };

  return { enabled, handleHttp, allowUpgrade };
}

module.exports = { createAccessGate };
