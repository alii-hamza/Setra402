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
    ["overview", "◉", "Overview"],
    ["onboarding", "◎", "Services"],
    ["lifecycle", "◌", "Tasks"],
    ["audit", "⟳", "Activity"],
    ["developers", "</>", "Developers"],
  ];
  return (
    <nav aria-label="Screens" className="nav-rail-items">
      {items.map(([id, icon, title]) => (
        <button
          key={id}
          type="button"
          className="nav-item"
          data-screen={id}
          aria-current={active === id ? "page" : undefined}
          onClick={() => onChange(id)}
        >
          <span className="nav-item-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="nav-item-label">{title}</span>
        </button>
      ))}
    </nav>
  );
}
