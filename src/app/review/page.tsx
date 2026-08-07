"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { analyzePrompt, PromptAnalysis } from "@/lib/promptAnalysis";

function buildDefaultDescription(userDesc: string): string {
  // If the user gave a decent prompt, use it as-is
  if (userDesc.trim().length > 50) return userDesc.trim();

  // Build a full default prompt from the sparse input
  return `${userDesc.trim() || "A comfortable family home"}. Modern architectural style. Approximately 100 square meters total.`;
}

export default function ReviewPage() {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<PromptAnalysis | null>(null);
  const [description, setDescription] = useState("");
  const [editing, setEditing] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState("");
  const [isSketch, setIsSketch] = useState(false);
  const [emergencyExit, setEmergencyExit] = useState(false);

  useEffect(() => {
    const raw = sessionStorage.getItem("archInput");
    if (!raw) {
      router.push("/input");
      return;
    }
    const input = JSON.parse(raw);

    if (input.mode === "sketch") {
      setIsSketch(true);
      // For sketches, build a full default description
      const defaultDesc = buildDefaultDescription(input.description || "");
      const result = analyzePrompt(defaultDesc);
      setAnalysis(result);
      setDescription(defaultDesc);
      setEditedPrompt(defaultDesc);
    } else {
      const result = analyzePrompt(input.description || "");
      setAnalysis(result);
      setDescription(input.description);
      setEditedPrompt(input.description);
    }
  }, [router]);

  const handleProceed = () => {
    sessionStorage.setItem(
      "archInput",
      JSON.stringify({
        mode: "text",
        description: editedPrompt.trim(),
        fileName: null,
        areaM2: analysis?.areaM2,
        isGroundFloor: analysis?.isGroundFloor ?? true,
        emergencyExit: emergencyExit,
      })
    );
    router.push("/processing");
  };

  if (!analysis) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] bg-[#f4f5f7]">
        <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 bg-[#f4f5f7]">
      {/* Header */}
      <header className="px-6 py-4 border-b border-zinc-200/60 flex items-center gap-4 bg-white">
        <Link
          href="/input"
          className="text-zinc-500 hover:text-zinc-900 transition-colors text-sm font-medium"
        >
          ← Back to Input
        </Link>
        <h1 className="text-lg font-semibold text-zinc-900">
          {isSketch ? "Review Sketch + Defaults" : "Review Your Prompt"}
        </h1>
        {isSketch && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2.5 py-1 rounded-full font-medium">
            Sketch uploaded — using defaults below
          </span>
        )}
      </header>

      <main className="flex-1 flex items-start justify-center px-4 py-10">
        <div className="w-full max-w-2xl space-y-6">
          {/* Info banner for sketch uploads */}
          {isSketch && (
            <div className="bg-blue-50 rounded-xl border border-blue-200 p-4">
              <p className="text-sm text-blue-800">
                Your sketch has been uploaded. The AI will analyze it alongside
                the description below, which has been pre-filled with defaults.
                You can edit the description to better match your sketch before
                generating.
              </p>
            </div>
          )}
          {/* Summary card */}
          <div className="bg-white rounded-xl border border-zinc-200/60 p-6">
            <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-3">
              We understood
            </h2>
            <p className="text-xl font-semibold text-zinc-900 capitalize">
              {analysis.summary}
            </p>

            {/* Found details */}
            {analysis.found.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {analysis.found.map((f, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-50 border border-green-200 text-sm text-green-700"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    {f}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Missing details */}
          {analysis.missing.length > 0 && (
            <div className="bg-amber-50 rounded-xl border border-amber-200 p-6">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <div>
                  <h3 className="font-semibold text-amber-800 mb-2">
                    Missing details — these will use defaults
                  </h3>
                  <ul className="space-y-1.5">
                    {analysis.missing.map((m, i) => (
                      <li key={i} className="text-sm text-amber-700 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                        {m}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Area conversion notice */}
          {analysis.areaM2 && analysis.areaOriginal && (
            <div className="bg-blue-50 rounded-xl border border-blue-200 p-4">
              <div className="flex items-center gap-2 text-blue-800">
                <span className="text-lg">📐</span>
                <span>
                  <strong>Area converted:</strong> {analysis.areaOriginal} →{" "}
                  <strong>{analysis.areaM2} m²</strong>
                  {analysis.areaOriginal.toLowerCase().includes("ft") && (
                    <span className="text-blue-600 text-sm ml-1">
                      (÷ 10.764)
                    </span>
                  )}
                </span>
              </div>
            </div>
          )}

          {/* Defaults being applied */}
          {analysis.defaults.length > 0 && (
            <div className="bg-zinc-50 rounded-xl border border-zinc-200/60 p-6">
              <h3 className="text-sm font-semibold text-zinc-600 mb-3">
                Defaults we will apply
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {analysis.defaults.map((d, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-zinc-500">{d.label}</span>
                    <span className="text-zinc-700 font-medium">{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Edit prompt */}
          {editing ? (
            <div className="bg-white rounded-xl border border-zinc-200/60 p-6">
              <label className="text-sm font-semibold text-zinc-800 block mb-2">
                Edit your description
              </label>
              <textarea
                rows={5}
                value={editedPrompt}
                onChange={(e) => setEditedPrompt(e.target.value)}
                className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              />
              <div className="flex gap-3 mt-3">
                <button
                  onClick={() => {
                    setEditing(false);
                    const updated = analyzePrompt(editedPrompt);
                    setAnalysis(updated);
                    setDescription(editedPrompt);
                  }}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
                >
                  Re-analyze
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setEditedPrompt(description);
                  }}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="w-full rounded-xl border-2 border-dashed border-zinc-300 px-6 py-4 text-base font-medium text-zinc-600 hover:border-blue-400 hover:text-blue-600 transition-colors bg-white"
            >
              ✎ Edit prompt to add more details
            </button>
          )}

          {/* Emergency exit option — only for apartments/upper-floor units */}
          {analysis.isGroundFloor === false && (
            <div className="bg-white rounded-xl border border-zinc-200/60 p-6">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={emergencyExit}
                  onChange={(e) => setEmergencyExit(e.target.checked)}
                  className="w-5 h-5 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <span className="text-sm font-semibold text-zinc-800">
                    Include mandatory emergency exit
                  </span>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Required by building code in many countries for apartments and upper-floor units
                  </p>
                </div>
              </label>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-4">
            <Link
              href="/input?mode=text"
              className="flex-1 rounded-xl border border-zinc-300 px-6 py-4 text-base font-semibold text-zinc-600 hover:bg-zinc-50 transition-colors text-center"
            >
              ← Start Over
            </Link>
            <button
              onClick={handleProceed}
              className="flex-1 rounded-xl bg-blue-600 px-6 py-4 text-base font-semibold text-white hover:bg-blue-700 transition-colors shadow-sm"
            >
              Generate Floor Plan →
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
