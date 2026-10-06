import type { ReactNode } from "react";

export function TasksPage({
  children,
  hidden,
}: {
  children: ReactNode;
  hidden: boolean;
}) {
  return (
    <section id="lifecycle" className="screen" hidden={hidden}>
      {children}
    </section>
  );
}
