"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type WeighIn = { weight: number | string; logged_on: string };

function todayStr() {
  // Local date in YYYY-MM-DD to match the DB `date` column.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function DailyWeighIn({
  userId,
  weighIns,
  onSaved,
}: {
  userId: string;
  weighIns: WeighIn[];
  onSaved: () => void;
}) {
  const today = todayStr();
  const loggedToday = weighIns.find((w) => w.logged_on === today);

  const [value, setValue] = useState(loggedToday ? String(loggedToday.weight) : "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    setStatus(null);
    const num = parseFloat(value);
    if (!num || num <= 0) {
      setError("Enter a real number.");
      return;
    }

    setSaving(true);
    try {
      // Upsert on (user_id, logged_on) so re-logging today updates the value.
      const { error: dbError } = await supabase
        .from("weigh_ins")
        .upsert(
          { user_id: userId, weight: num, logged_on: today },
          { onConflict: "user_id,logged_on" }
        );

      if (dbError) {
        setError("Couldn't save. Try again.");
        return;
      }
      setStatus(loggedToday ? "Updated." : "Logged. See you tomorrow.");
      onSaved();
    } catch {
      setError("Couldn't save. Check your connection.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-carbon-raised border border-carbon-line p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="font-mono-data text-[10px] uppercase tracking-widest text-steel-dim">Daily Weigh-In</p>
        {loggedToday && (
          <span className="font-mono-data text-[10px] uppercase tracking-wider text-fork-green">
            <span aria-hidden="true">✓</span> Today logged
          </span>
        )}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); save(); }}
        className="flex gap-2 items-stretch"
      >
        <div className="relative flex-1">
          <label htmlFor="weigh-in" className="sr-only">Today&apos;s weight in pounds</label>
          <input
            id="weigh-in"
            type="number"
            inputMode="decimal"
            step="0.1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={loggedToday ? String(loggedToday.weight) : "Today's weight"}
            className="w-full px-4 py-3 bg-carbon border border-carbon-line text-chalk font-mono-data outline-none focus:border-fork-green transition-colors"
          />
          <span className="absolute right-4 top-3.5 text-steel font-mono-data font-bold text-[10px]">LBS</span>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="px-5 bg-fork-green text-carbon font-black uppercase text-xs tracking-widest disabled:opacity-40 transition-all active:scale-95"
        >
          {saving ? "…" : loggedToday ? "Update" : "Log"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-2 text-xs text-blacklist-red">{error}</p>
      )}
      {status && !error && (
        <p aria-live="polite" className="mt-2 text-xs text-steel">{status}</p>
      )}
    </div>
  );
}
