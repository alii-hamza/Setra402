import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export function Button({
  className,
  variant,
  size,
  icon,
  children,
  ...props
}: ButtonProps) {
  const variantClass = variant
    ? variant === "primary"
      ? "primary-button"
      : variant === "secondary"
      ? "secondary"
      : variant === "ghost"
      ? "text-button"
      : "button-danger"
    : "";

  const sizeClass = size === "sm" ? "small" : size === "lg" ? "large" : "";
  const classes = [className ?? (!variant ? "button" : ""), variantClass, sizeClass]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={classes} {...props}>
      {icon && (
        <span className="button-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </button>
  );
}
