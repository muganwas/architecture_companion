"use client";

import { useState, useEffect } from "react";

const STEPS = [
  "Parsing requirements",
  "Analyzing sketch geometry",
  "Generating floor plan",
  "Calculating sustainability scores",
  "Estimating costs",
];

interface ProcessingScreenProps {
  onComplete: () => void;
}

export default function ProcessingScreen({ onComplete }: ProcessingScreenProps) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (step >= STEPS.length) {
      const timeout = setTimeout(onComplete, 500);
      return () => clearTimeout(timeout);
    }

    const delay = 1000 + Math.random() * 1500;
    const timeout = setTimeout(() => setStep((s) => s + 1), delay);
    return () => clearTimeout(timeout);
  }, [step, onComplete]);

  const progress = (step / STEPS.length) * 100;

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-8 px-4 bg-[#f4f5f7]">
      {/* Building icon */}
      <svg className="w-12 h-12 text-blue-600 animate-bounce" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="9" y1="3" x2="9" y2="21" />
        <line x1="15" y1="3" x2="15" y2="21" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="3" y1="15" x2="21" y2="15" />
      </svg>

      <h2 className="text-2xl font-bold text-zinc-900">Generating Your Floor Plan</h2>

      {/* Progress Bar */}
      <div className="w-full max-w-md">
        <div className="h-2 bg-zinc-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-600 rounded-full transition-all duration-700 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Steps */}
      <ul className="space-y-3 w-full max-w-sm">
        {STEPS.map((label, i) => (
          <li
            key={i}
            className={`flex items-center gap-3 text-sm transition-all duration-300 ${
              i < step
                ? "text-green-600"
                : i === step
                ? "text-blue-600 font-semibold"
                : "text-zinc-400"
            }`}
          >
            <span className="w-6 h-6 flex items-center justify-center rounded-full border text-xs font-bold">
              {i < step ? (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : i === step ? (
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 2v4" /><path d="m16.2 7.8 2.9-2.9" /><path d="M18 12h4" /><path d="m16.2 16.2 2.9 2.9" /><path d="M12 18v4" /><path d="m4.9 19.1 2.9-2.9" /><path d="M2 12h4" /><path d="m4.9 4.9 2.9 2.9" />
                </svg>
              ) : (
                <span className="text-zinc-300">○</span>
              )}
            </span>
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
