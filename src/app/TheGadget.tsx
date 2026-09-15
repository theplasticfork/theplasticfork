"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

type Audit = {
  created_at: string;
  weight: string | number;
  goal_weight: string | number;
  ingredients?: string;
};

type WeighIn = { weight: number | string; logged_on: string };

const isRoast = (a: Audit) =>
  typeof a.ingredients === "string" && a.ingredients.startsWith("ROAST:");

// ---------- metric helpers ----------

// Chronological weight series. Daily weigh-ins are the primary signal; plan
// audits fill in any days without a weigh-in. One point per day, newest wins.
function weightSeries(audits: Audit[], weighIns: WeighIn[]) {
  const byDay = new Map<string, { date: Date; weight: number; goal: number }>();

  // Plan audits first (lower priority).
  audits
    .filter((a) => !isRoast(a) && Number(a.weight) > 0)
    .forEach((a) => {
      const d = new Date(a.created_at);
      const key = d.toISOString().slice(0, 10);
      byDay.set(key, { date: d, weight: Number(a.weight), goal: Number(a.goal_weight) });
    });

  // Weigh-ins override the audit weight for that day (they're the daily truth).
  weighIns
    .filter((w) => Number(w.weight) > 0)
    .forEach((w) => {
      const key = w.logged_on;
      const existing = byDay.get(key);
      byDay.set(key, {
        date: new Date(key + "T12:00:00"),
        weight: Number(w.weight),
        goal: existing?.goal ?? 0,
      });
    });

  return Array.from(byDay.values())
    .sort((x, y) => x.date.getTime() - y.date.getTime())
    .map((p) => ({
      label: p.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      weight: p.weight,
      goal: p.goal || null,
    }));
}

// Goal progress: how far from start->goal the user has moved (0-100).
// Uses the most recent known goal (weigh-in-only days carry no goal).
function goalProgress(series: ReturnType<typeof weightSeries>) {
  if (series.length < 1) return null;
  const start = series[0].weight;
  const current = series[series.length - 1].weight;
  const goal = [...series].reverse().find((p) => p.goal && p.goal > 0)?.goal;
  if (!goal || start === goal) return null;
  const pct = ((start - current) / (start - goal)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// Current streak: consecutive distinct days (up to today/yesterday) with any
// activity — a weigh-in or an audit.
function currentStreak(audits: Audit[], weighIns: WeighIn[]) {
  const days = new Set<string>();
  audits.forEach((a) => days.add(new Date(a.created_at).toDateString()));
  weighIns.forEach((w) => days.add(new Date(w.logged_on + "T12:00:00").toDateString()));
  if (days.size === 0) return 0;
  let streak = 0;
  const cursor = new Date();
  // Allow the streak to count if the most recent activity was today or yesterday.
  if (!days.has(cursor.toDateString())) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(cursor.toDateString())) return 0;
  }
  while (days.has(cursor.toDateString())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// ---------- Goal progress ring (SVG) ----------

function ProgressRing({ pct }: { pct: number }) {
  const size = 120;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  return (
    <svg
      width={size}
      height={size}
      role="img"
      aria-label={`Goal progress: ${pct} percent`}
      className="mx-auto"
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#26282B" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#46D17A"
        strokeWidth={stroke}
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="middle"
        textAnchor="middle"
        fill="#F4F4F1"
        fontSize="24"
        fontFamily="var(--font-jetbrains-mono), monospace"
        fontWeight="700"
      >
        {pct}%
      </text>
    </svg>
  );
}

// ---------- Badges (Task 3) ----------

function computeBadges(audits: Audit[], streak: number, progress: number | null) {
  const total = audits.length;
  const goalReached = progress !== null && progress >= 100;
  return [
    { key: "first", label: "First Blood", desc: "Completed your first audit", earned: total >= 1 },
    { key: "ten", label: "Repeat Offender", desc: "10 audits logged", earned: total >= 10 },
    { key: "streak3", label: "On a Roll", desc: "3-day streak", earned: streak >= 3 },
    { key: "streak7", label: "Locked In", desc: "7-day streak", earned: streak >= 7 },
    { key: "goal", label: "Goal Slayer", desc: "Reached your goal weight", earned: goalReached },
  ];
}

// ---------- Main component ----------

export default function TheGadget({ audits, weighIns = [] }: { audits: Audit[]; weighIns?: WeighIn[] }) {
  const series = weightSeries(audits, weighIns);
  const progress = goalProgress(series);
  const streak = currentStreak(audits, weighIns);
  const badges = computeBadges(audits, streak, progress);

  const hasData = audits.length > 0 || weighIns.length > 0;

  return (
    <section aria-label="Your stats" className="space-y-4 no-print">
      <h3 className="text-xs font-bold uppercase tracking-widest text-steel">The Gadget</h3>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Weight trend */}
        <div className="lg:col-span-2 bg-carbon-raised border border-carbon-line p-5">
          <p className="font-mono-data text-[10px] uppercase tracking-widest text-steel-dim mb-3">Weight Trend</p>
          {series.length >= 2 ? (
            <div style={{ width: "100%", height: 180 }}>
              <ResponsiveContainer>
                <LineChart data={series} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                  <XAxis dataKey="label" tick={{ fill: "#8D9199", fontSize: 10 }} tickLine={false} axisLine={{ stroke: "#26282B" }} />
                  <YAxis tick={{ fill: "#8D9199", fontSize: 10 }} tickLine={false} axisLine={{ stroke: "#26282B" }} domain={["dataMin - 5", "dataMax + 5"]} />
                  <Tooltip
                    contentStyle={{ background: "#0B0B0C", border: "1px solid #26282B", borderRadius: 0, fontSize: 12 }}
                    labelStyle={{ color: "#8D9199" }}
                    itemStyle={{ color: "#F4F4F1" }}
                  />
                  <Line type="monotone" dataKey="weight" stroke="#46D17A" strokeWidth={2} dot={{ r: 3, fill: "#46D17A" }} name="Weight" />
                  <Line type="monotone" dataKey="goal" stroke="#E8B84B" strokeWidth={1} strokeDasharray="4 4" dot={false} name="Goal" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-sm text-steel-dim py-12 text-center">
              {hasData ? "Log a couple more audits to see your trend." : "No data yet. Run an audit to start tracking."}
            </p>
          )}
        </div>

        {/* Goal ring */}
        <div className="bg-carbon-raised border border-carbon-line p-5 flex flex-col items-center justify-center">
          <p className="font-mono-data text-[10px] uppercase tracking-widest text-steel-dim mb-3 self-start">To Goal</p>
          {progress !== null ? (
            <>
              <ProgressRing pct={progress} />
              <p className="text-xs text-steel mt-3 text-center">
                {progress >= 100 ? "Goal reached. Respect." : "Keep grinding."}
              </p>
            </>
          ) : (
            <p className="text-sm text-steel-dim py-8 text-center">Set a goal in your next audit.</p>
          )}
        </div>
      </div>

      {/* Streak + badges */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-carbon-raised border border-carbon-line p-5">
          <p className="font-mono-data text-[10px] uppercase tracking-widest text-steel-dim">Current Streak</p>
          <p className={`font-mono-data text-4xl mt-1 ${streak > 0 ? "text-pr-gold" : "text-steel-dim"}`}>
            {streak}<span className="text-sm text-steel"> {streak === 1 ? "day" : "days"}</span>
          </p>
        </div>

        <div className="sm:col-span-2 bg-carbon-raised border border-carbon-line p-5">
          <p className="font-mono-data text-[10px] uppercase tracking-widest text-steel-dim mb-3">Badges</p>
          <ul className="flex flex-wrap gap-2">
            {badges.map((b) => (
              <li
                key={b.key}
                title={`${b.label} — ${b.desc}`}
                className={`font-mono-data text-[10px] uppercase tracking-wider px-2.5 py-1 border ${
                  b.earned
                    ? "border-pr-gold/50 bg-pr-gold/10 text-pr-gold"
                    : "border-carbon-line text-steel-dim"
                }`}
              >
                <span aria-hidden="true">{b.earned ? "★ " : "☆ "}</span>
                {b.label}
                <span className="sr-only">{b.earned ? " (earned)" : " (locked)"}: {b.desc}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
