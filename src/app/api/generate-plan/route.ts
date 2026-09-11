import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Initialize the Admin client to bypass RLS for rate limiting
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  try {
    const { ingredients, userWeight, activityLevel, goalWeight, bodyFat, isPro } = await request.json();

    // --- START RATE LIMITING (THE BOUNCER) ---
    // If they are Pro, we skip IP rate limiting entirely
    if (!isPro) {
      const ip = request.headers.get("x-forwarded-for") || "unknown";
      
      const { data: limitData } = await supabaseAdmin
        .from('rate_limits')
        .select('*')
        .eq('ip_address', ip)
        .single();

      if (limitData) {
        const hoursSinceLast = (Date.now() - new Date(limitData.last_request).getTime()) / 3600000;
        
        if (hoursSinceLast > 24) {
          // It's been over 24 hours, reset their counter
          await supabaseAdmin.from('rate_limits').update({ 
            request_count: 1, 
            last_request: new Date().toISOString() 
          }).eq('ip_address', ip);
        } else if (limitData.request_count >= 10) {
          // Abuse guard only. Normal users are gated by the 2-free-then-pay
          // flow on the client; this just stops runaway automated abuse.
          return NextResponse.json({ 
            error: "Too many requests from this network. Try again later." 
          }, { status: 429 });
        } else {
          // Increment their usage
          await supabaseAdmin.from('rate_limits').update({ 
            request_count: limitData.request_count + 1 
          }).eq('ip_address', ip);
        }
      } else {
        // First time this IP has visited, create their record
        await supabaseAdmin.from('rate_limits').insert([{ 
          ip_address: ip, 
          request_count: 1 
        }]);
      }
    }
    // --- END RATE LIMITING ---

    if (!ingredients || typeof ingredients !== "string" || ingredients.trim() === "") {
      return NextResponse.json({ error: "Ingredients are required" }, { status: 400 });
    }

    const weightNum = userWeight ? parseInt(userWeight) : 180;
    const goalNum = goalWeight ? parseInt(goalWeight) : weightNum - 10;
    const fatPercent = bodyFat ? parseFloat(bodyFat) / 100 : 0.20;
    
    const leanMass = weightNum * (1 - fatPercent);
    const multiplier = parseFloat(activityLevel) || 1.55;
    const maintenance = Math.round(weightNum * (multiplier * 10)); 
    const targetCalories = maintenance - 500;

    const weightToLose = weightNum - goalNum;
    const weeksToGoal = weightToLose > 0 ? Math.ceil(weightToLose / 1) : 0;

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "API key not configured" }, { status: 500 });
    }

    // Model + timeout config
    const MODEL = "openai/gpt-oss-120b";
    const TIMEOUT_MS = 30000;

    const prompt = `You are 'The Plastic Fork'—a blunt nutrition auditor. 

CRITICAL CONSTRAINT: 
Do NOT include any of these foods in the plan: ${ingredients}. 

AUDIT PARAMETERS:
- Stats: ${weightNum} lbs, ${bodyFat}% Body Fat.
- Target: Exactly ${targetCalories} calories and ${Math.round(leanMass)}g protein.
- Goal: Reach ${goalNum} lbs in ${weeksToGoal} weeks.

REQUIRED OUTPUT:
- 3 Bullet Points (Morning, Mid-day, Evening). Provide specific oz/gram weights.
- Section: 'PRO MACRO AUDIT'
- Section: 'BODY ARCHITECT FORECAST' (Mention the ${weeksToGoal}-week timeline).

TONE: Clinical, aggressive, no-nonsense.`;

    // Calls Groq's streaming chat endpoint (OpenAI-compatible). Retries once on
    // a failed/timed-out connection so a single slow moment doesn't kill it.
    const callGroq = async (): Promise<Response> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        return await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: MODEL,
            stream: true,
            // This is a reasoning model; "low" keeps it from streaming its
            // internal thinking and gets us straight to the answer.
            reasoning_effort: "low",
            messages: [{ role: "user", content: prompt }],
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    };

    let upstream: Response;
    try {
      upstream = await callGroq();
      if (!upstream.ok) throw new Error(`Upstream status ${upstream.status}`);
    } catch {
      // One retry
      upstream = await callGroq();
    }

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      throw new Error(errText || "Failed to fetch from Groq");
    }

    // Transform Groq's SSE stream into a plain text stream of the model output.
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.body!.getReader();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // SSE events are separated by newlines; each data line is JSON.
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const json = trimmed.slice(5).trim();
              if (!json || json === "[DONE]") continue;
              try {
                const parsed = JSON.parse(json);
                const text = parsed?.choices?.[0]?.delta?.content ?? "";
                if (text) controller.enqueue(encoder.encode(text));
              } catch {
                // Ignore partial/non-JSON keep-alive lines
              }
            }
          }
        } catch (err) {
          controller.error(err);
          return;
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });

  } catch (error: any) {
    console.error("Error generating plan:", error);
    return NextResponse.json(
      { error: "Failed to generate plan", details: error?.message || "Unknown error" },
      { status: 500 }
    );
  }
}