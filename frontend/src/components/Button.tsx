import type { ButtonHTMLAttributes } from "react";

export function Button({
  className = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={className || "button"} {...props} />;
}
