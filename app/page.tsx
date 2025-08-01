"use client";

import { useState, useMemo } from "react";

type Result = {
  endpoint: string;
  method: string;
  status: number | string;
  contentType: string;
  foundType: string;
  keysSample: string[];
  note?: string;
};

const DEFAULT_WORDLIST = [
  "/", "/status", "/health", "/ping", "/check", "/info", "/details",
  "/config", "/configuration", "/config.json", "/manifest.json", "/robots.txt",
  "/sitemap.xml", "/.well-known", "/.well-known/security.txt",
  "/api", "/api/", "/api/v1", "/api/v2", "/api/v3", "/v1", "/v2", "/v3",
  "/json", "/rest", "/graphql", "/gql", "/token", "/verify", "/refresh",
  "/auth", "/authenticate", "/login", "/logout", "/register", "/session",
  "/sessions", "/me", "/user", "/users", "/profile", "/account", "/accounts",
  "/account-details", "/settings", "/preferences", "/options", "/dashboard",
  "/admin", "/admin/login", "/admin/dashboard", "/current", "/whoami",
];

export default function Page() {
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [includeStreaming, setIncludeStreaming] = useState(true);
  const [includeVPN, setIncludeVPN] = useState(true);
  const [includeESIM, setIncludeESIM] = useState(true);
  const [customEndpoints, setCustomEndpoints] = useState<string>("");
  const [headersJson, setHeadersJson] = useState<string>("{}");
  const [timeoutMs, setTimeoutMs] = useState<number>(8000);
  const [concurrency, setConcurrency] = useState<number>(12);
  const [tryGraphQL, setTryGraphQL] = useState<boolean>(true);
  const [extractEmbedded, setExtractEmbedded] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(false);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string>("");

  const wordlistPreview = useMemo(() => {
    const extra = customEndpoints
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
    return DEFAULT_WORDLIST.length + (includeStreaming ? 18 : 0) + (includeVPN ? 10 : 0) + (includeESIM ? 14 : 0) + extra.length;
  }, [customEndpoints, includeStreaming, includeVPN, includeESIM]);

  const streaming = ["/titles","/catalog","/movies","/shows","/series","/episodes","/watch","/play","/player","/library","/media","/content","/subscription","/subscriptions","/plans","/billing","/payment","/payments"];
  const vpn = ["/vpn","/express","/expressvpn","/nord","/nordvpn","/servers","/locations","/config/openvpn","/config/wireguard","/devices"];
  const esim = ["/sim","/sims","/esim","/e-sim","/sim-card","/activation","/activate","/deactivate","/roaming","/coverage","/network","/networks","/plans","/topup"];

  function toCSV(rows: Result[]) {
    const head = ["endpoint","method","status","contentType","foundType","keysSample","note"];
    const esc = (s: any) => `"${String(s ?? "").replace(/"/g,'""')}"`;
    const lines = [head.join(",")];
    for (const r of rows) {
      lines.push([
        r.endpoint, r.method, r.status, r.contentType, r.foundType, (r.keysSample||[]).join("|"), r.note || ""
      ].map(esc).join(","));
    }
    return lines.join("\n");
  }

  async function onScan() {
    setError("");
    setLoading(true);
    setResults([]);
    try {
      const hdrs = JSON.parse(headersJson || "{}");
      const extra = customEndpoints.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          include: { streaming: includeStreaming, vpn: includeVPN, esim: includeESIM },
          extraEndpoints: extra,
          headers: hdrs,
          timeoutMs,
          concurrency,
          tryGraphQL,
          extractEmbedded
        })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text);
      }
      const data = await res.json();
      setResults(data.results || []);
    } catch (e: any) {
      setError(e?.message || "Scan failed");
    } finally {
      setLoading(false);
    }
  }

  function download(type: "csv" | "json") {
    const blob = type === "csv"
      ? new Blob([toCSV(results)], { type: "text/csv" })
      : new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = type === "csv" ? "finder-results.csv" : "finder-results.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: 20 }}>
      <div style={{ background: "#fff", padding: 20, borderRadius: 12, boxShadow: "0 2px 10px rgba(0,0,0,0.05)" }}>
        <h2 style={{ marginTop: 0 }}>Automatic API Response Finder (Vercel UI)</h2>
        <p>Server-side scanner that bypasses browser CORS, extracts embedded JSON, and optionally introspects GraphQL. Ideal for streaming/VPN/eSIM sites.</p>

        <label>Base URL</label>
        <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://www.netflix.com" style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd" }} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 12 }}>
          <label><input type="checkbox" checked={includeStreaming} onChange={e => setIncludeStreaming(e.target.checked)} /> Include Streaming paths</label>
          <label><input type="checkbox" checked={includeVPN} onChange={e => setIncludeVPN(e.target.checked)} /> Include VPN paths</label>
          <label><input type="checkbox" checked={includeESIM} onChange={e => setIncludeESIM(e.target.checked)} /> Include eSIM/Telecom</label>
        </div>

        <label style={{ marginTop: 12, display: "block" }}>Custom Endpoints (one per line)</label>
        <textarea value={customEndpoints} onChange={e => setCustomEndpoints(e.target.value)} rows={6} placeholder="/my-endpoint\n/api/internal\n/hidden"
          style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd", fontFamily: "monospace" }} />

        <label style={{ marginTop: 12, display: "block" }}>Custom Headers (JSON)</label>
        <textarea value={headersJson} onChange={e => setHeadersJson(e.target.value)} rows={4} placeholder='{"User-Agent":"Mozilla/5.0","Cookie":"auth=..."}'
          style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd", fontFamily: "monospace" }} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 12 }}>
          <div>
            <label>Timeout (ms)</label>
            <input type="number" value={timeoutMs} onChange={e => setTimeoutMs(parseInt(e.target.value||"0"))} style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd" }} />
          </div>
          <div>
            <label>Concurrency</label>
            <input type="number" value={concurrency} onChange={e => setConcurrency(parseInt(e.target.value||"1"))} style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ddd" }} />
          </div>
          <label style={{ alignSelf: "end" }}><input type="checkbox" checked={extractEmbedded} onChange={e => setExtractEmbedded(e.target.checked)} /> Extract embedded JSON</label>
          <label style={{ alignSelf: "end" }}><input type="checkbox" checked={tryGraphQL} onChange={e => setTryGraphQL(e.target.checked)} /> Try GraphQL introspection</label>
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button onClick={onScan} disabled={loading} style={{ background: "#28a745", color: "white", padding: "10px 16px", borderRadius: 8, border: "none", cursor: "pointer" }}>
            {loading ? "Scanning..." : `Scan (${wordlistPreview} endpoints)`}
          </button>
          <button onClick={() => download("csv")} disabled={!results.length} style={{ padding: "10px 16px", borderRadius: 8, border: "1px solid #bbb", background: "#fff" }}>Download CSV</button>
          <button onClick={() => download("json")} disabled={!results.length} style={{ padding: "10px 16px", borderRadius: 8, border: "1px solid #bbb", background: "#fff" }}>Download JSON</button>
        </div>

        {error && <div style={{ color: "red", marginTop: 12 }}>{error}</div>}

        <div style={{ marginTop: 20 }}>
          <h3>Results {results.length ? `(${results.length})` : ""}</h3>
          <div style={{ overflowX: "auto", background: "#fff", borderRadius: 8, border: "1px solid #eee" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#fafafa" }}>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee", textAlign: "left" }}>Endpoint</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee", textAlign: "left" }}>Status</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee", textAlign: "left" }}>Content-Type</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee", textAlign: "left" }}>Found</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee", textAlign: "left" }}>Keys sample</th>
                  <th style={{ padding: 8, borderBottom: "1px solid #eee", textAlign: "left" }}>Note</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i}>
                    <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.endpoint}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.status}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.contentType}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.foundType}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0", fontFamily: "monospace" }}>{(r.keysSample||[]).join(", ")}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}
