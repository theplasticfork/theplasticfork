import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Keep-alive endpoint. Vercel Cron hits this daily so the Supabase free-tier
// project never idles into a pause (which would break Google login + history).
// A single cheap read against a small table is enough to count as activity.

export const dynamic = "force-dynamic";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    const { error } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .limit(1);

    if (error) {
      console.error("Keep-alive query failed:", error.message);
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, pingedAt: new Date().toISOString() });
  } catch (err: any) {
    console.error("Keep-alive error:", err?.message);
    return NextResponse.json(
      { ok: false, error: err?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
