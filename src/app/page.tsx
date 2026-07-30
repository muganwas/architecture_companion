import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col flex-1">
      {/* Header */}
      <header className="text-center py-20 px-4 bg-gradient-to-b from-blue-50 to-white">
        <h1 className="text-5xl font-bold text-zinc-900 tracking-tight">
          🏗️ AI Architecture Companion
        </h1>
        <p className="mt-4 text-lg text-zinc-600 max-w-xl mx-auto">
          Describe your dream building or upload a sketch — our AI generates
          professional floor plans in seconds.
        </p>

        {/* CTA Buttons */}
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="/input?mode=text"
            className="w-full sm:w-auto rounded-xl bg-blue-600 px-8 py-4 text-lg font-semibold text-white hover:bg-blue-700 transition-colors shadow-lg shadow-blue-200"
          >
            ✍️ Describe in Text
          </Link>
          <Link
            href="/input?mode=sketch"
            className="w-full sm:w-auto rounded-xl border-2 border-zinc-300 px-8 py-4 text-lg font-semibold text-zinc-700 hover:border-blue-400 hover:text-blue-600 transition-colors"
          >
            📸 Upload Sketch
          </Link>
        </div>
      </header>

      {/* Preview / Features */}
      <section className="py-16 px-4 max-w-5xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            {
              icon: "📐",
              title: "2D & 3D Views",
              desc: "Toggle between classic floor plans and immersive 3D walkthroughs.",
            },
            {
              icon: "♻️",
              title: "Sustainability Score",
              desc: "Get light, ventilation, and energy efficiency ratings automatically.",
            },
            {
              icon: "💰",
              title: "Cost Estimates",
              desc: "Ballpark construction costs based on layout, materials, and region.",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="text-center p-6 rounded-xl border border-zinc-200 hover:border-blue-200 hover:shadow-md transition-all"
            >
              <div className="text-4xl mb-4">{f.icon}</div>
              <h3 className="font-semibold text-zinc-800 mb-2">{f.title}</h3>
              <p className="text-sm text-zinc-500">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-auto py-8 px-4 text-center text-sm text-zinc-400 border-t border-zinc-100">
        <p>
          Built with Next.js · Tailwind CSS · OpenAI / DeepSeek · Docker
        </p>
        <p className="mt-1">© {new Date().getFullYear()} AI Architecture Companion</p>
      </footer>
    </div>
  );
}
