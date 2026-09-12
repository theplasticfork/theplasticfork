"use client";

import { useState, useRef, useEffect } from "react";
import { supabase } from "@/lib/supabaseClient";

type ChatMessage = { role: "user" | "assistant"; content: string };

const STARTERS = [
  "Why am I not dropping weight?",
  "Audit my last plan. Be honest.",
  "What's my biggest weakness?",
];

export default function CoachForker({ isPro, onUpgrade }: { isPro: boolean; onUpgrade: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the latest message in view as it streams.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isThinking]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || isThinking) return;
    setError(null);

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: question }];
    setMessages(nextMessages);
    setInput("");
    setIsThinking(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch("/api/coach", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ messages: nextMessages }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Coach Forker is offline. Try again.");
        setIsThinking(false);
        return;
      }

      // Add an empty assistant message and stream into it.
      setMessages((m) => [...m, { role: "assistant", content: "" }]);
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let full = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          full += decoder.decode(value, { stream: true });
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { role: "assistant", content: full };
            return copy;
          });
        }
      } else {
        full = await res.text();
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: full };
          return copy;
        });
      }

      if (!full.trim()) {
        setError("Coach Forker went quiet. Try again.");
        setMessages((m) => m.slice(0, -1));
      }
    } catch {
      setError("Coach Forker is offline. Check your connection.");
    } finally {
      setIsThinking(false);
    }
  };

  // --- NON-PRO: locked teaser / upsell ---
  if (!isPro) {
    return (
      <div className="bg-carbon-raised p-8 border border-carbon-line text-center space-y-4">
        <span className="font-mono-data text-[10px] uppercase tracking-[0.2em] text-fork-green">Badass Forker Perk</span>
        <h2 className="font-display text-2xl text-chalk uppercase">Coach Forker</h2>
        <p className="text-sm text-steel max-w-md mx-auto">
          A blunt coach that knows your numbers. Ask it why you&apos;re stalling,
          what to fix, or to audit your last plan. It doesn&apos;t sugarcoat.
        </p>
        <div className="border border-carbon-line bg-carbon p-4 max-w-md mx-auto text-left space-y-2 opacity-60">
          <p className="text-xs text-steel"><span className="text-fork-green">You:</span> Why am I not dropping weight?</p>
          <p className="text-xs text-chalk"><span className="text-fork-green">Coach:</span> Your intake says deficit, your scale says otherwise. Something&apos;s not being logged. Let&apos;s find it.</p>
        </div>
        <button
          onClick={onUpgrade}
          className="mt-2 px-6 py-3 bg-fork-green text-carbon font-black uppercase tracking-widest transition-all active:scale-95"
        >
          Unlock Coach Forker — $9
        </button>
      </div>
    );
  }

  // --- PRO: full chat ---
  return (
    <div className="bg-carbon-raised border border-carbon-line flex flex-col" style={{ height: "480px" }}>
      <div className="px-5 py-3 border-b border-carbon-line flex items-center gap-2">
        <span className="font-display text-sm uppercase tracking-wide text-chalk">Coach Forker</span>
        <span className="w-2 h-2 rounded-full bg-fork-green" aria-hidden="true" />
        <span className="font-mono-data text-[10px] text-steel uppercase tracking-widest">On the clock</span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {messages.length === 0 ? (
          <div className="space-y-4">
            <p className="text-sm text-steel">Ask me anything. I&apos;ve seen your numbers.</p>
            <div className="flex flex-col gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="text-left text-xs text-chalk border border-carbon-line hover:border-fork-green/60 px-3 py-2 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
              <span className="font-mono-data text-[10px] uppercase tracking-widest text-steel-dim block mb-1">
                {m.role === "user" ? "You" : "Coach Forker"}
              </span>
              <div
                className={
                  m.role === "user"
                    ? "inline-block bg-carbon border border-carbon-line px-3 py-2 text-sm text-chalk max-w-[85%] text-left"
                    : "inline-block px-1 text-sm text-chalk leading-relaxed whitespace-pre-wrap max-w-[95%] text-left"
                }
              >
                {m.content || (isThinking && i === messages.length - 1 ? "…" : "")}
              </div>
            </div>
          ))
        )}
        {isThinking && messages[messages.length - 1]?.role === "user" && (
          <p className="text-sm text-steel-dim" aria-live="polite">Coach Forker is thinking…</p>
        )}
      </div>

      {error && (
        <div role="alert" className="mx-5 mb-2 border border-blacklist-red/60 bg-blacklist-red/10 px-3 py-2 text-xs text-blacklist-red">
          {error}
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="border-t border-carbon-line p-3 flex gap-2"
      >
        <label htmlFor="coach-input" className="sr-only">Message Coach Forker</label>
        <input
          id="coach-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Coach Forker..."
          disabled={isThinking}
          className="flex-1 bg-carbon border border-carbon-line px-3 py-2 text-sm text-chalk outline-none focus:border-fork-green transition-colors disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={isThinking || !input.trim()}
          className="px-4 py-2 bg-fork-green text-carbon font-black uppercase text-xs tracking-widest disabled:opacity-30 transition-all active:scale-95"
        >
          Send
        </button>
      </form>
    </div>
  );
}
