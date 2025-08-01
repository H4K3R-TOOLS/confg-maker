import { NextRequest, NextResponse } from "next/server";
import { scanHost } from "../../lib/scanner";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      baseUrl,
      include,
      extraEndpoints,
      headers,
      timeoutMs,
      concurrency,
      tryGraphQL,
      extractEmbedded,
      profile
    } = body || {};

    // Server-side defaults
    let preset: Record<string, string> = {};
    try {
      const presetRaw = process.env.PRESET_HEADERS_JSON || "{}";
      preset = JSON.parse(presetRaw);
    } catch {
      preset = {};
    }

    // Named profiles
    let chosen: Record<string, string> | undefined = undefined;
    try {
      const rawProfiles = process.env.PRESET_PROFILES_JSON || "{}";
      const profiles: Record<string, Record<string, string>> = JSON.parse(rawProfiles);
      if (profile && typeof profile === "string") {
        chosen = profiles[profile] || profiles[profile.toLowerCase()];
      }
    } catch {
      chosen = undefined;
    }

    if (!baseUrl || typeof baseUrl !== "string") {
      return NextResponse.json({ error: "baseUrl is required" }, { status: 400 });
    }

    const result = await scanHost({
      baseUrl,
      include: {
        streaming: !!(include?.streaming),
        vpn: !!(include?.vpn),
        esim: !!(include?.esim)
      },
      extraEndpoints: Array.isArray(extraEndpoints) ? extraEndpoints : [],
      headers: {
        ...(typeof preset === "object" && preset ? preset : {}),
        ...(chosen || {}),
        ...(typeof headers === "object" && headers ? headers : {})
      },
      timeoutMs: Number(timeoutMs) || 8000,
      concurrency: Number(concurrency) || 12,
      tryGraphQL: !!tryGraphQL,
      extractEmbedded: !!extractEmbedded
    });

    return NextResponse.json({ results: result.results });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "scan failed" }, { status: 500 });
  }
}
