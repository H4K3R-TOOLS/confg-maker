import { NextRequest, NextResponse } from "next/server";
import { scanHost } from "../../../lib/scanner";

export const runtime = "nodejs"; // ensure Node runtime on Vercel

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { baseUrl, include, extraEndpoints, headers, timeoutMs, concurrency, tryGraphQL, extractEmbedded } = body || {};
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
      headers: typeof headers === "object" && headers ? headers : {},
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
