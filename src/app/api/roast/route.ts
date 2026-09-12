import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { streamGroq, STREAM_HEADERS } from "@/lib/groqStream";

// Admin client to bypass RLS for IP rate limiting (same bouncer as generate-plan)
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  try {
    const { foodLog, isPro } = await request.json();

    // --- RATE LIMITING (THE BOUNCER) — Pro users skip it ---
    if (!isPro) {
      const ip = request.headers.get("x-forwarded-for") || "unknown";

      const { data: limitData } = await supabaseAdmin
        .from("rate_limits")
        .select("*")
        .eq("ip_address", ip)
        .single();

      if (limitData) {
        const hoursSinceLast =
          (Date.now() - new Date(limitData.last_request).getTime()) / 3600000;

        if (hoursSinceLast > 24) {
          await supabaseAdmin
            .from("rate_limits")
            .update({ request_count: 1, last_request: new Date().toISOString() })
            .eq("ip_address", ip);
        } else if (limitData.request_count >= 10) {
          return NextResponse.json(
            { error: "Too many requests from this network. Try again later." },
            { status: 429 }
          );
        } else {
          await supabaseAdmin
            .from("rate_limits")
            .update({ request_count: limitData.request_count + 1 })
            .eq("ip_address", ip);
        }
      } else {
        await supabaseAdmin
          .from("rate_limits")
          .insert([{ ip_address: ip, request_count: 1 }]);
      }
    }
    // --- END RATE LIMITING ---

    if (!foodLog || typeof foodLog !== "string" || foodLog.trim() === "") {
      return NextResponse.json(
        { error: "Tell me what you ate first." },
        { status: 400 }
      );
    }

    // Trim overly long logs so a single request can't blow the token budget.
    const log = foodLog.trim().slice(0, 2000);

    const prompt = `You are 'The Plastic Fork'—a blunt, clinical nutrition auditor with dry humor. A user has logged what they actually ate today. Audit it.

WHAT THEY ATE:
${log}

RULES:
- Be blunt and honest. Clinical, not cruel. Dry humor is welcome, one sharp line lands harder than five.
- Point the criticism at the FOOD and the CHOICES, never at the person as a failure.
- Estimate the damage: rough calories, protein, and where it went wrong.
- Call out the worst offender specifically.
- End with one concrete, no-nonsense fix for tomorrow.

REQUIRED OUTPUT (use these section headers):
- Section: 'THE VERDICT' (2-3 blunt sentences on the day overall)
- Section: 'THE DAMAGE' (rough calorie/protein estimate + the biggest offender)
- Section: 'TOMORROW' (one specific fix)

TONE: Clinical, blunt, dry. No wellness-speak. No "journey." No emojis.`;

    const stream = await streamGroq(prompt);
    return new Response(stream, { headers: STREAM_HEADERS });
  } catch (error: any) {
    console.error("Error roasting day:", error);
    return NextResponse.json(
      { error: "Failed to roast", details: error?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
