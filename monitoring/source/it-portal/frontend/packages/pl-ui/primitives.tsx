import type { ReactNode } from "react";
import { Button } from "./react";

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field pl-ui-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Panel({
  title,
  icon,
  action,
  children,
  className = "",
}: {
  title: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel pl-ui-panel ${className}`}>
      <div className="panel-heading">
        <h2>
          {icon}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Badge({
  children,
  tone = "unknown",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge pl-ui-badge status-${tone}`}>{children}</span>;
}
export function Empty({
  title = "Нет данных",
  detail,
  action,
  icon,
}: {
  title?: string;
  detail?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty pl-ui-empty">
      {icon}
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}
export function Alert({
  children,
  retry,
  retryLabel = "Повторить",
  icon,
}: {
  children: ReactNode;
  retry?: () => void;
  retryLabel?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="error-box pl-ui-alert" role="alert">
      {icon}
      <span>{children}</span>
      {retry && (
        <Button size="sm" onClick={retry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
