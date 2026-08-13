import Link from "next/link";

function IconPencil() {
  return (
    <svg className="w-5 h-5 inline-block mr-2 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg className="w-5 h-5 inline-block mr-2 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function FeatureIcon({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-14 h-14 mx-auto mb-4 rounded-xl bg-blue-100 flex items-center justify-center">
      {children}
    </div>
  );
}

export default function Home() {
  return (
    <div className="flex flex-col flex-1 bg-[#f4f5f7]">
      {/* Header */}
      <header className="text-center py-24 px-4 bg-linear-to-b from-blue-600 to-blue-700">
        <svg className="w-16 h-16 mx-auto mb-6 text-white/90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
          <line x1="15" y1="3" x2="15" y2="21" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="3" y1="15" x2="21" y2="15" />
        </svg>
        <h1 className="text-5xl font-bold text-white tracking-tight">
          Architecture Companion
        </h1>
        <p className="mt-4 text-lg text-white/80 max-w-xl mx-auto">
          Describe your dream building or upload a sketch — our AI generates
          professional floor plans in seconds.
        </p>

        {/* CTA Buttons */}
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="/input?mode=text"
            className="w-full sm:w-auto rounded-xl bg-white px-8 py-4 text-base font-semibold text-blue-700 hover:bg-blue-50 transition-colors shadow-lg"
          >
            <IconPencil />
            Describe in Text
          </Link>
          <Link
            href="/input?mode=sketch"
            className="w-full sm:w-auto rounded-xl border-2 border-white/40 px-8 py-4 text-base font-semibold text-white hover:bg-white/10 transition-colors"
          >
            <IconUpload />
            Upload Sketch
          </Link>
        </div>
      </header>

      {/* Preview / Features */}
      <section className="py-16 px-4 max-w-5xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            {
              svg: <svg className="w-7 h-7 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>,
              title: "2D & 3D Views",
              desc: "Toggle between classic floor plans and immersive 3D walkthroughs.",
            },
            {
              svg: <svg className="w-7 h-7 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4" /><path d="M12 18v4" /><path d="M4.93 4.93l2.83 2.83" /><path d="M16.24 16.24l2.83 2.83" /><path d="M2 12h4" /><path d="M18 12h4" /><path d="M4.93 19.07l2.83-2.83" /><path d="M16.24 7.76l2.83-2.83" /></svg>,
              title: "Sustainability Score",
              desc: "Get light, ventilation, and energy efficiency ratings automatically.",
            },
            {
              svg: <svg className="w-7 h-7 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>,
              title: "Cost Estimates",
              desc: "Ballpark construction costs based on layout, materials, and region.",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="text-center p-6 rounded-xl bg-white border border-zinc-200/60 hover:border-blue-300 hover:shadow-md transition-all"
            >
              <FeatureIcon>{f.svg}</FeatureIcon>
              <h3 className="font-semibold text-zinc-900 mb-2">{f.title}</h3>
              <p className="text-sm text-zinc-600 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-auto py-8 px-4 text-center text-sm text-zinc-500 border-t border-zinc-200/60">
        <p>
          Built with Next.js · Tailwind CSS · DeepSeek · Docker
        </p>
        <p className="mt-1">© {new Date().getFullYear()} Architecture Companion</p>
      </footer>
    </div>
  );
}
