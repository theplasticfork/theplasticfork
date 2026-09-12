// Shared Groq streaming helper. Both the meal-plan and roast endpoints use
// this so the SSE parsing, timeout, and retry logic live in one place.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_MODEL = "openai/gpt-oss-120b";
const TIMEOUT_MS = 30000;

/**
 * Sends a single-prompt chat request to Groq and returns a plain-text
 * ReadableStream of the model's output. Retries once on a failed/timed-out
 * connection. Throws if Groq returns a non-OK response after the retry.
 */
export async function streamGroq(prompt: string): Promise<ReadableStream<Uint8Array>> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("API key not configured");
  }

  const callGroq = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          stream: true,
          // Reasoning model; "low" skips streaming its internal thinking.
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
    upstream = await callGroq();
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    throw new Error(errText || "Failed to fetch from Groq");
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

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
}

/** Standard headers for a streamed plain-text response. */
export const STREAM_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
};
