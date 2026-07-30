"use client";

import { useState, useEffect } from "react";

const STEPS = [
  "Parsing requirements…",
  "Analyzing sketch geometry…",
  "Generating floor plan…",
  "Calculating sustainability scores…",
  "Estimating costs…",
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

  const progress = ((step) / STEPS.length) * 100;

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-8 px-4">
      <div className="text-5xl animate-bounce">🏗️</div>

      <h2 className="text-2xl font-bold text-zinc-800">Generating Your Floor Plan</h2>

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
            <span className="w-5 text-center">
              {i < step ? "✅" : i === step ? "⏳" : "○"}
            </span>
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
