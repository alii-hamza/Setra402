import type { ReactNode } from "react";

export function ActivityPage({
  children,
  hidden,
}: {
  children: ReactNode;
  hidden: boolean;
}) {
  return (
    <section id="audit" className="screen" hidden={hidden}>
      {children}
    </section>
  );
}
