import type { HTMLAttributes } from "react";

export type StatusType = "success" | "warning" | "error" | "neutral" | "info";

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  status?: StatusType;
  size?: "sm" | "md";
}

export function StatusBadge({
  status,
  size,
  className = "",
  children,
  ...props
}: StatusBadgeProps) {
  const statusClass = status
    ? status === "success"
      ? "pass"
      : status === "error"
      ? "fail"
      : status === "warning"
      ? "badge-warn"
      : status === "info"
      ? "badge-blue"
      : "badge-neutral"
    : "";

  const sizeClass = size === "sm" ? "badge-sm" : "";

  return (
    <span
      {...props}
      className={`badge ${statusClass} ${sizeClass} ${className}`.trim()}
    >
      {children}
    </span>
  );
}
