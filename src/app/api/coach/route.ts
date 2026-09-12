import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { streamGroqMessages, STREAM_HEADERS, type ChatMessage } from "@/lib/groqStream";

// Admin client: verifies the bearer token and reads profile/audits server-side
// so Pro status can't be spoofed by the client.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MAX_HISTORY = 12; // cap conversation turns sent upstream
const MAX_MSG_LEN = 1500; // cap each message length

export async function POST(request: NextRequest) {
  try {
    // --- AUTH: verify the user from their bearer token ---
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.split(" ")[1];
    if (!token) {
      return NextResponse.json({ error: "Sign in to talk to Coach Forker." }, { status: 401 });
    }

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: "Session expired. Sign in again." }, { status: 401 });
    }

    // --- PRO GATE (server-side, not client-trusted) ---
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("is_pro")
      .eq("id", user.id)
      .single();

    if (!profile?.is_pro) {
      return NextResponse.json(
        { error: "Coach Forker is a Badass Forker perk. Upgrade to unlock." },
        { status: 403 }
      );
    }

    // --- INPUT ---
    const body = await request.json();
    const incoming: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];

    // Sanitize: keep only user/assistant turns, clamp count + length.
    const history: ChatMessage[] = incoming
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_LEN) }));

    if (history.length === 0 || history[history.length - 1].role !== "user") {
      return NextResponse.json({ error: "Ask Coach Forker something." }, { status: 400 });
    }

    // --- CONTEXT: pull the user's recent audits so Coach can be specific ---
    const { data: audits } = await supabaseAdmin
      .from("audits")
      .select("created_at, weight, goal_weight, body_fat, ingredients")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(5);

    let contextBlock = "The user has no saved audits yet.";
    if (audits && audits.length > 0) {
      const lines = audits.map((a) => {
        const date = new Date(a.created_at).toLocaleDateString();
        return `- ${date}: ${a.weight} lbs (goal ${a.goal_weight} lbs), ${a.body_fat}% BF, excluded: ${a.ingredients}`;
      });
      contextBlock = `The user's recent audits (most recent first):\n${lines.join("\n")}`;
    }

    const systemPrompt: ChatMessage = {
      role: "system",
      content: `You are "Coach Forker", the personal coach inside The Plastic Fork — a blunt, clinical nutrition and training coach with dry humor.

PERSONALITY:
- Blunt and direct. Say the plain thing first. No wellness-speak, no "journey", no fluff.
- Dry humor, used sparingly. One deadpan line lands harder than five.
- Strict but never cruel. Point criticism at habits, food, and choices — NEVER attack the person as a failure.
- You are a coach: give concrete, actionable answers. Real numbers, real steps.

USING THEIR DATA:
- You have access to the user's recent audits below. Reference their actual numbers when relevant.
- If they ask something their data can answer (e.g. "why am I not dropping weight?"), use their stats to give a specific answer, not a generic one.
- If you don't have enough data, say so plainly and tell them what to log.

RULES:
- Keep answers tight. A few sentences to a short paragraph. Bullet points for steps.
- No medical claims or diagnoses. If asked something clinical/medical, tell them to see a doctor, bluntly.
- Stay in character. You're a coach, not a chatbot.

${contextBlock}`,
    };

    const stream = await streamGroqMessages([systemPrompt, ...history]);
    return new Response(stream, { headers: STREAM_HEADERS });
  } catch (error: any) {
    console.error("Coach Forker error:", error);
    return NextResponse.json(
      { error: "Coach Forker is offline. Try again.", details: error?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
