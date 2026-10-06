import { Button } from "./Button";

export type Screen =
  | "overview"
  | "onboarding"
  | "lifecycle"
  | "audit"
  | "developers";

export function TopNav({
  active,
  onChange,
}: {
  active: Screen;
  onChange: (screen: Screen) => void;
}) {
  const items: Array<[Screen, string, string]> = [
    ["overview", "", "Overview"],
    ["onboarding", "", "Services"],
    ["lifecycle", "", "Tasks"],
    ["audit", "", "Activity"],
    ["developers", "", "Developers"],
  ];
  return (
    <nav aria-label="Screens">
      {items.map(([id, number, title]) => (
        <Button
          key={id}
          type="button"
          data-screen={id}
          aria-current={active === id ? "page" : undefined}
          onClick={() => onChange(id)}
        >
          {number && <span>{number}</span>}
          {title}
        </Button>
      ))}
    </nav>
  );
}
