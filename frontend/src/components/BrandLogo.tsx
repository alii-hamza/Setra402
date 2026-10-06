const LOGO_SRC = "/logo.png";

export function BrandLogo({ className = "brand-logo" }: { className?: string }) {
  return (
    <img
      src={LOGO_SRC}
      alt="Setra402"
      className={className}
      width={125}
      height={32}
      decoding="async"
    />
  );
}
