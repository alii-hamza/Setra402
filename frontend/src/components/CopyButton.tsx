import { useState } from "react";

export function CopyButton({
  value,
  onError,
}: {
  value: string;
  onError?: (error: unknown) => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      onError?.(error);
    }
  }
  return (
    <button type="button" className="secondary small" onClick={copy}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
