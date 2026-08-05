"use client";

import { Suspense, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function IconUpload() {
  return (
    <svg className="w-10 h-10 mx-auto mb-3 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

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

      sessionStorage.setItem(
        "archInput",
        JSON.stringify({
          mode,
          description: description.trim(),
          fileName: file?.name || null,
        })
      );

      // Always go through review first
      router.push("/review");
    },
    [mode, description, file, router]
  );

  return (
    <div className="flex flex-col flex-1 bg-[#f4f5f7]">
      {/* Header */}
      <header className="px-6 py-4 border-b border-zinc-200/60 flex items-center gap-4 bg-white">
        <Link href="/" className="text-zinc-500 hover:text-zinc-900 transition-colors text-sm font-medium">
          ← Back
        </Link>
        <h1 className="text-lg font-semibold text-zinc-900">
          {mode === "text" ? "Describe Your Building" : "Upload Your Sketch"}
        </h1>
        {/* Mode tabs */}
        <div className="ml-auto flex rounded-lg border border-zinc-200 overflow-hidden">
          <Link
            href="/input?mode=text"
            className={`px-4 py-1.5 text-sm font-medium transition-colors ${
              mode === "text"
                ? "bg-blue-600 text-white"
                : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            Text
          </Link>
          <Link
            href="/input?mode=sketch"
            className={`px-4 py-1.5 text-sm font-medium transition-colors ${
              mode === "sketch"
                ? "bg-blue-600 text-white"
                : "text-zinc-600 hover:bg-zinc-100"
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
                className="block text-sm font-semibold text-zinc-800 mb-2"
              >
                Describe your building idea
              </label>
              <textarea
                id="description"
                rows={6}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Example: A 3-bedroom bungalow with an open-plan kitchen, a large porch facing east, and a master bedroom with an ensuite bathroom. Total area around 150 sq meters."
                className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              />
            </div>
          ) : (
            <div>
              <label className="block text-sm font-semibold text-zinc-800 mb-2">
                Upload a sketch
              </label>
              <div className="relative border-2 border-dashed border-zinc-300 rounded-xl p-12 text-center hover:border-blue-400 transition-colors cursor-pointer bg-white">
                <input
                  type="file"
                  accept="image/png,image/jpeg,application/pdf"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
                <IconUpload />
                <p className="text-zinc-700 font-medium">
                  {file ? file.name : "Drag & drop a sketch (PNG / JPG / PDF)"}
                </p>
                <p className="text-sm text-zinc-500 mt-1">
                  {file
                    ? `${(file.size / 1024).toFixed(1)} KB`
                    : "or click to browse"}
                </p>
              </div>
            </div>
          )}

          {error && (
            <p className="text-red-600 text-sm font-medium">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-blue-600 px-6 py-4 text-base font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            {loading ? "Processing…" : "Generate Layout"}
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
        <div className="flex items-center justify-center min-h-[60vh] bg-[#f4f5f7]">
          <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
        </div>
      }
    >
      <InputForm />
    </Suspense>
  );
}
