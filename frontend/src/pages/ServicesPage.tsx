import type { ReactNode } from "react";

export function ServicesPage({
  children,
  hidden,
}: {
  children: ReactNode;
  hidden: boolean;
}) {
  return (
    <section id="onboarding" className="screen" hidden={hidden}>
      {children}
    </section>
  );
}
