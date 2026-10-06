export interface ToastMessage {
  text: string;
  error: boolean;
}

export function Toast({ message }: { message: ToastMessage | null }) {
  if (!message) return null;
  return (
    <div
      id="notice"
      role="status"
      aria-live="polite"
      className={message.error ? "error" : ""}
    >
      {message.text}
    </div>
  );
}
