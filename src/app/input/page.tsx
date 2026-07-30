"use client";

import { Suspense, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function InputForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode") || "text";

  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError("");

      if (mode === "text" && !description.trim()) {
        setError("Please enter a description of your building idea.");
        return;
      }

      setLoading(true);

      // Store input in sessionStorage for the processing/results pages
      sessionStorage.setItem(
        "archInput",
        JSON.stringify({
          mode,
          description: description.trim(),
          fileName: file?.name || null,
        })
      );

      router.push("/processing");
    },
    [mode, description, file, router]
  );

  return (
    <div className="flex flex-col flex-1">
      {/* Header */}
      <header className="px-6 py-4 border-b border-zinc-200 flex items-center gap-4">
        <Link href="/" className="text-zinc-500 hover:text-zinc-800 transition-colors">
          ← Back
        </Link>
        <h1 className="text-lg font-semibold text-zinc-800">
          {mode === "text" ? "Describe Your Building" : "Upload Your Sketch"}
        </h1>
        {/* Mode tabs */}
        <div className="ml-auto flex rounded-lg border border-zinc-200 overflow-hidden">
          <Link
            href="/input?mode=text"
            className={`px-4 py-1.5 text-sm ${
              mode === "text"
                ? "bg-blue-600 text-white"
                : "text-zinc-600 hover:bg-zinc-50"
            }`}
          >
            Text
          </Link>
          <Link
            href="/input?mode=sketch"
            className={`px-4 py-1.5 text-sm ${
              mode === "sketch"
                ? "bg-blue-600 text-white"
                : "text-zinc-600 hover:bg-zinc-50"
            }`}
          >
            Sketch
          </Link>
        </div>
      </header>

      {/* Input Area */}
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <form onSubmit={handleSubmit} className="w-full max-w-2xl space-y-6">
          {mode === "text" ? (
            <div>
              <label
                htmlFor="description"
                className="block text-sm font-semibold text-zinc-700 mb-2"
              >
                Describe your building idea
              </label>
              <textarea
                id="description"
                rows={6}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Example: A 3-bedroom bungalow with an open-plan kitchen, a large porch facing east, and a master bedroom with an ensuite bathroom. Total area around 150 sq meters."
                className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-zinc-800 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              />
            </div>
          ) : (
            <div>
              <label className="block text-sm font-semibold text-zinc-700 mb-2">
                Upload a sketch
              </label>
              <div className="relative border-2 border-dashed border-zinc-300 rounded-xl p-12 text-center hover:border-blue-400 transition-colors cursor-pointer">
                <input
                  type="file"
                  accept="image/png,image/jpeg,application/pdf"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
                <div className="text-4xl mb-3">📸</div>
                <p className="text-zinc-600 font-medium">
                  {file ? file.name : "Drag & drop a sketch (PNG / JPG / PDF)"}
                </p>
                <p className="text-sm text-zinc-400 mt-1">
                  {file
                    ? `${(file.size / 1024).toFixed(1)} KB`
                    : "or click to browse"}
                </p>
              </div>
            </div>
          )}

          {error && (
            <p className="text-red-500 text-sm font-medium">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-blue-600 px-6 py-4 text-lg font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-lg shadow-blue-200"
          >
            {loading ? "Processing…" : "🚀 Generate Layout"}
          </button>
        </form>
      </main>
    </div>
  );
}

export default function InputPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
        </div>
      }
    >
      <InputForm />
    </Suspense>
  );
}
