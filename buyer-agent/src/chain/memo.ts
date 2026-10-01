export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const PREFIX = "setra402:v1:";

export function encodeManifestMemo(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new TypeError("manifest hash must be 32-byte lowercase hex");
  return PREFIX + hash;
}

export function decodeManifestMemo(memo: string): string {
  if (!memo.startsWith(PREFIX))
    throw new TypeError("memo is not a Setra402 v1 commitment");
  const hash = memo.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new TypeError("memo contains an invalid manifest hash");
  return hash;
}
