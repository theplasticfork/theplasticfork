import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy | The Plastic Fork",
  description: "How The Plastic Fork handles your data.",
};

export default function Privacy() {
  return (
    <main className="min-h-screen bg-[#0f0f0f] text-[#ededed] px-6 py-16">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="text-zinc-300 leading-relaxed">
          The Plastic Fork does not sell your data. We only use your email to
          manage your meal plan audits and to sync your saved plans across
          devices.
        </p>
        <p className="text-zinc-300 leading-relaxed">
          When you sign in with Google, we access only your basic profile
          information (name and email) to provide a personalized experience.
        </p>
        <Link
          href="/"
          className="inline-block text-sm font-bold uppercase tracking-widest text-[#22c55e] hover:underline"
        >
          <span aria-hidden="true">←</span> Back to home
        </Link>
      </div>
    </main>
  );
}
