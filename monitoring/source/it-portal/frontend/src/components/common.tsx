import {
  Alert,
  Badge as SharedBadge,
  Empty as SharedEmpty,
} from "@pl/ui/primitives";
import { ru } from "../ru";
import type { ReactNode } from "react";
import { AlertCircle, ArrowUpRight, Search } from "lucide-react";
import { SystemIcon } from "./SystemIcon";
import { resolveResourceIcon, type IconIdentity } from "../resourceIcons";
import { safeURL, errorText } from "../api";
import { statusLabel, copy } from "../copy";
export { Panel, Field } from "@pl/ui/primitives";
export function Badge({
  value,
  children,
}: {
  value: string;
  children?: ReactNode;
}) {
  return (
    <SharedBadge tone={value}>
      {children || statusLabel[value] || value}
    </SharedBadge>
  );
}
export function ErrorBox({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <Alert
      retry={retry}
      retryLabel={copy.retry}
      icon={<AlertCircle size={18} />}
    >
      {errorText(error)}
    </Alert>
  );
}
export function Empty({
  title = copy.noData,
  detail,
  action,
}: {
  title?: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <SharedEmpty
      title={title}
      detail={detail}
      action={action}
      icon={<Search size={27} />}
    />
  );
}
export function ExternalLink({
  url,
  children,
  className = "",
  onUnavailable,
}: {
  onUnavailable?: () => void;
  url: string;
  children: ReactNode;
  className?: string;
}) {
  const href = safeURL(url);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
      <ArrowUpRight size={14} />
    </a>
  ) : onUnavailable ? (
    <button
      type="button"
      className={`resource-detail-link ${className}`}
      onClick={onUnavailable}
    >
      {children}
    </button>
  ) : (
    <span>{children}</span>
  );
}
export function ResourceIcon(identity: IconIdentity) {
  const { tone } = resolveResourceIcon(identity);
  return (
    <span className={`resource-icon ${tone}`}>
      <SystemIcon {...identity} />
    </span>
  );
}
export function MultiInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={(value || []).join(", ")}
      placeholder={placeholder || ru.cherez_zapyatuyu}
      onChange={(e) =>
        onChange(e.target.value.split(",").map((v) => v.trimStart()))
      }
      onBlur={() => onChange(value.map((v) => v.trim()).filter(Boolean))}
    />
  );
}
export function JSONView({ value }: { value: unknown }) {
  return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>;
}
