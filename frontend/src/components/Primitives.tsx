import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "blue" | "good" | "warn" | "bad";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function HealthIndicator({
  state,
  label,
  showPulse = true,
}: {
  state: string | undefined;
  label: string;
  showPulse?: boolean;
}) {
  const tone =
    state === "HEALTHY" ? "good" : state === "DEGRADED" ? "warn" : "bad";
  const isHealthy = state === "HEALTHY" && showPulse;
  return (
    <span
      className={`health-indicator health-${tone} ${
        isHealthy ? "is-healthy" : ""
      }`}
    >
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <section className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </section>
  );
}

export function ServiceCard({
  name,
  description,
  provider,
  transport,
  price,
  level,
  health,
  activation,
  children,
}: {
  name: string;
  description: string;
  provider: string;
  transport: string;
  price: string;
  level: number;
  health: string;
  activation: string;
  children?: ReactNode;
}) {
  return (
    <article className="service-card">
      <div className="service-card-heading">
        <div>
          <h2>{name}</h2>
          <p>{description}</p>
        </div>
        <HealthIndicator state={health} label={`Registry ${health}`} />
      </div>
      <div className="service-facts">
        <span>
          <small>Provider</small>
          {provider}
        </span>
        <span>
          <small>Transport</small>
          {transport}
        </span>
        <span>
          <small>Price</small>
          {price} base units
        </span>
        <span>
          <small>Verification</small>Level {level}
        </span>
      </div>
      <div className="service-card-footer">
        <Badge tone={activation === "ACTIVE" ? "good" : "warn"}>
          {activation}
        </Badge>
        {children}
      </div>
    </article>
  );
}

export function DataTable({
  columns,
  children,
  label,
}: {
  columns: string[];
  children: ReactNode;
  label: string;
}) {
  return (
    <div
      className="data-table-wrap"
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="app-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Dialog(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return <Modal {...props} />;
}

export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal open={open} title={title} onClose={onClose}>
      <div className="drawer-content">{children}</div>
    </Modal>
  );
}

export function IconButton({
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className="icon-button" aria-label={label} {...props}>
      {children}
    </button>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: string[];
  active: string;
  onChange: (tab: string) => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.indexOf(active);
    const next =
      tabs[
        (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length
      ];
    onChange(next);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)
      ?.focus();
  }
  return (
    <div className="tabs" role="tablist" onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={active === tab}
          tabIndex={active === tab ? 0 : -1}
          data-tab={tab}
          onClick={() => onChange(tab)}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

export function Stepper({
  steps,
}: {
  steps: Array<{
    label: string;
    state: "done" | "current" | "future" | "failed";
  }>;
}) {
  return (
    <ol className="stepper">
      {steps.map((step, index) => (
        <li key={`${step.label}-${index}`} className={`step-${step.state}`}>
          <span className="step-marker" aria-hidden="true">
            {step.state === "done" ? "✓" : index + 1}
          </span>
          <span>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

export function Timeline({
  events,
}: {
  events: Array<{ title: string; detail?: string; time: string }>;
}) {
  return (
    <ol className="timeline">
      {events.map((event, index) => (
        <li key={`${event.title}-${index}`}>
          <span className="timeline-marker" aria-hidden="true" />
          <div>
            <strong>{event.title}</strong>
            {event.detail && <p>{event.detail}</p>}
            <time>{event.time}</time>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="code-block">
      <code>{code}</code>
    </pre>
  );
}

export function HashValue({ value }: { value: string }) {
  return (
    <code className="hash-value" title={value}>
      {value}
    </code>
  );
}

export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="tooltip" tabIndex={0} aria-label={label}>
      {children}
      <span role="tooltip">{label}</span>
    </span>
  );
}

export function Skeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-label="Loading">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

export function Disclosure({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="disclosure">
      <summary>{title}</summary>
      {children}
    </details>
  );
}

export function Checkbox(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="checkbox" {...props} />;
}

export function Textarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>
) {
  return <textarea {...props} />;
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} />;
}
