import type { HTMLAttributes } from "react";

export function StatusBadge(props: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={`badge ${props.className ?? ""}`} />;
}
