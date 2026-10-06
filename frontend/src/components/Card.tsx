import type { HTMLAttributes } from "react";

export type CardVariant = "default" | "emphasized" | "subtle" | "data";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
}

export function Card({ variant = "default", className, ...props }: CardProps) {
  const variantClass =
    variant === "emphasized"
      ? "panel-emphasized"
      : variant === "subtle"
      ? "panel-subtle"
      : variant === "data"
      ? "panel-data"
      : "";

  return (
    <div
      {...props}
      className={`panel ${variantClass} ${className ?? ""}`.trim()}
    />
  );
}
