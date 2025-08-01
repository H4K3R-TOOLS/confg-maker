type Result = {
  endpoint: string;
  method: string;
  status: number | string;
  contentType: string;
  foundType: string;
  keysSample: string[];
  note?: string;
};

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RETRIES = 1;

const GENERIC = [
  "/", "/status", "/health", "/ping", "/check", "/info", "/details",
  "/config", "/configuration", "/config.json", "/manifest.json", "/robots.txt",
  "/sitemap.xml", "/.well-known", "/.well-known/security.txt",
  "/api", "/api/", "/api/v1", "/api/v2", "/api/v3", "/v1", "/v2", "/v3",
  "/json", "/rest", "/graphql", "/gql", "/token", "/verify", "/refresh",
  "/auth", "/authenticate", "/login", "/logout", "/register", "/session",
  "/sessions", "/me", "/user", "/users", "/profile", "/account", "/accounts",
  "/account-details", "/settings", "/preferences", "/options", "/dashboard",
  "/admin", "/admin/login", "/admin/dashboard", "/current", "/whoami"
];

const STREAMING = [
  "/titles","/catalog","/movies","/shows","/series","/episodes",
  "/watch","/play","/player","/library","/media","/content",
  "/subscription","/subscriptions","/plans","/billing","/payment","/payments"
];

const VPN = [
  "/vpn","/express","/expressvpn","/nord","/nordvpn","/servers",
  "/locations","/config/openvpn","/config/wireguard","/devices"
];

const ESIM_TELECOM = [
  "/sim","/sims","/esim","/e-sim","/sim-card","/activation","/activate",
  "/deactivate","/roaming","/coverage","/network","/networks","/plans","/topup"
];

const EXTRA = [
  "/search","/discover","/recommend","/recommendations","/suggestions",
  "/notifications","/messages","/inbox","/outbox","/uploads","/downloads",
  "/share","/clientinfo","/sessioninfo","/device","/devices","/geo","/ip"
];

function uniq(arr: string[]) {
  return Array.from(new Set(arr));
}

function buildWordlist(include: { streaming: boolean; vpn: boolean; esim: boolean; }, extra: string[]) {
  let all = [...GENERIC, ...EXTRA];
  if (include.streaming) all = all.concat(STREAMING);
  if (include.vpn) all = all.concat(VPN);
  if (include.esim) all = all.concat(ESIM_TELECOM);
  if (extra?.length) all = all.concat(extra);
  return uniq(all);
}

const ACCEPTS = [
  "application/json, text/plain, */*",
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
];

function timeoutPromise<T>(ms: number, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => controller.abort("timeout"), ms);
    work().then(v => { clearTimeout(t); resolve(v); }).catch(e => { clearTimeout(t); reject(e); });
  });
}

function tryParseJSON(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}

function extractJSONFromHTML(html: string) {
  const found: { kind: string; json: any }[] = [];
  const ldjsonRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = ldjsonRegex.exec(html)) !== null) {
    const j = tryParseJSON(m[1]);
    if (j) found.push({ kind: "ld+json", json: j });
  }
  const boots = [
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/i,
    /window\.__NUXT__\s*=\s*({[\s\S]*?});/i,
    /window\.__APOLLO_STATE__\s*=\s*({[\s\S]*?});/i,
    /window\.__DATA__\s*=\s*({[\s\S]*?});/i,
    /__NEXT_DATA__\s*=\s*({[\s\S]*?});/i
  ];
  for (const rx of boots) {
    const mm = rx.exec(html);
    if (mm) {
      const j = tryParseJSON(mm[1]);
      if (j) found.push({ kind: "boot", json: j });
    }
  }
  const genericScript = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = genericScript.exec(html)) !== null) {
    const text = m[1].trim();
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
      const j = tryParseJSON(text);
      if (j) found.push({ kind: "script-obj", json: j });
    }
  }
  return found;
}

function pickKeys(obj: any, limit = 40) {
  try {
    const keys = Object.keys(obj);
    return keys.slice(0, limit);
  } catch { return []; }
}

async function tryGraphQL(base: string, headers: Record<string,string>, signal: AbortSignal) {
  const candidates = ["/graphql", "/gql", "/api/graphql", "/api/gql"];
  const body = JSON.stringify({
    query: `query IntrospectionQuery { __schema { types { name kind } queryType { name } mutationType { name } } }`
  });
  for (const ep of candidates) {
    const url = base + ep;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json, */*", ...headers },
        body, signal, redirect: "follow" as RequestRedirect
      } as any);
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("json")) {
        const data = await res.json();
        if (data && data.data && data.data.__schema) {
          return { endpoint: ep, ok: true, schema: data.data.__schema };
        }
      }
    } catch (_) {}
  }
  return null;
}

export async function scanHost(opts: {
  baseUrl: string;
  include: { streaming: boolean; vpn: boolean; esim: boolean; };
  extraEndpoints: string[];
  headers: Record<string,string>;
  timeoutMs: number;
  concurrency: number;
  tryGraphQL: boolean;
  extractEmbedded: boolean;
}) {
  const base = opts.baseUrl.replace(/\/$/, "");
  const endpoints = buildWordlist(opts.include, opts.extraEndpoints);
  const results: Result[] = [];
  const queue = endpoints.slice();
  const headers = opts.headers || {};

  async function worker() {
    while (queue.length) {
      const endpoint = queue.shift()!;
      for (const accept of ACCEPTS) {
        let lastErr: any = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            const controller = new AbortController();
            const res = await timeoutPromise<Result | null>(opts.timeoutMs || DEFAULT_TIMEOUT_MS, controller.signal, async () => {
              const r = await fetch(base + endpoint, {
                method: "GET",
                headers: { "Accept": accept, "User-Agent": headers["User-Agent"] || "Mozilla/5.0 (FinderBot)", ...headers },
                redirect: "follow" as RequestRedirect,
                signal: controller.signal
              } as any);

              const status = r.status;
              const ct = r.headers.get("content-type") || "";
              let foundType = "none";
              let keysSample: string[] = [];
              let note = "";

              const bodyText = await r.text();

              if (ct.includes("application/json") || bodyText.trim().startsWith("{") || bodyText.trim().startsWith("[")) {
                const j = tryParseJSON(bodyText);
                if (j) {
                  foundType = "json";
                  if (Array.isArray(j) && j.length && typeof j[0] === "object") {
                    keysSample = pickKeys(j[0]);
                  } else if (j && typeof j === "object") {
                    keysSample = pickKeys(j);
                  }
                } else {
                  note = "json-like but parse failed";
                }
              } else if (ct.includes("text/html") && opts.extractEmbedded) {
                const embeds = extractJSONFromHTML(bodyText);
                if (embeds.length) {
                  foundType = embeds[0].kind;
                  const first = embeds[0].json;
                  keysSample = Array.isArray(first) && first.length && typeof first[0] === "object" ? pickKeys(first[0]) : pickKeys(first);
                  note = `embedded JSON objects: ${embeds.length}`;
                }
              }

              return { endpoint, method: "GET", status, contentType: ct, foundType, keysSample, note };
            });

            if (res) results.push(res);
            break; // success or parsed
          } catch (e: any) {
            lastErr = e?.message || String(e);
            if (attempt === MAX_RETRIES) {
              results.push({ endpoint, method: "GET", status: "ERR", contentType: "", foundType: "none", keysSample: [], note: lastErr });
            }
          }
        }
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(64, opts.concurrency || 8)) }, () => worker());
  await Promise.all(workers);

  if (opts.tryGraphQL) {
    try {
      const controller = new AbortController();
      const gql = await Promise.race([
        tryGraphQL(base, headers, controller.signal),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.timeoutMs || DEFAULT_TIMEOUT_MS))
      ]);
      if (gql && gql.ok) {
        results.push({ endpoint: gql.endpoint, method: "POST", status: 200, contentType: "application/json", foundType: "graphql-schema", keysSample: ["__schema"], note: `GraphQL present` });
      }
    } catch {}
  }

  return { results };
}
