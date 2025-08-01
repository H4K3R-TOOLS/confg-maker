import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 15;

// Only allow these headers to be set via presets to avoid misuse
const ALLOW = new Set(["authorization", "cookie", "user-agent"]);
const PROFILE_LIMIT = 12;

export async function GET(_req: NextRequest) {
  try {
    const raw = process.env.PRESET_HEADERS_JSON || "{}";
    const parsed = JSON.parse(raw);
    const whitelisted: Record<string,string> = {};
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) {
        const key = String(k).toLowerCase();
        if (ALLOW.has(key) && typeof v === "string") {
          whitelisted[k] = v;
        }
      }
    }
    return NextResponse.json({ headers: whitelisted });
  } catch (e: any) {
    return NextResponse.json({ headers: {} });
  }
}
