import React from 'react';
import './components.css';
import { Check, Search, X } from 'lucide-react';
import { STATUS, type StatusKey } from './status';
import { avatarLook } from './avatar';

export const label = (s: string) => s.replaceAll('_', ' ').toLowerCase();
/**
 * The single empty-state contract: icon + page-specific title + one-line value statement +
 * a primary CTA. `secondary` adds a lower-emphasis affordance beside it, `hint` one muted
 * line of scope (e.g. what filters exclude) — both optional and purely additive.
 */
export function Empty({
  icon: Icon,
  title,
  description,
  action,
  secondary,
  hint,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
  description: string;
  action?: React.ReactNode;
  secondary?: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={29} strokeWidth={1.4} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {hint && <p className="empty-hint">{hint}</p>}
      {secondary !== undefined ? (
        <div className="empty-actions">
          {action}
          {secondary}
        </div>
      ) : (
        action
      )}
    </div>
  );
}
export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (s: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-field">
      <Search size={15} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </label>
  );
}

/** A real checkbox: the native input stays for keyboard and screen readers, the box is drawn beside it. */
export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`check${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="check-box" aria-hidden="true">
        <Check size={13} strokeWidth={3} />
      </span>
      <span className="check-label">{children}</span>
    </label>
  );
}

/** The shared status chip: icon + word + colour token, so status is never colour alone. */
export function StatusPill({ status, label: text, title }: { status: StatusKey; label?: string; title?: string }) {
  const { label: name, icon: Icon } = STATUS[status];
  return (
    <span className="status-pill" data-status={status} title={title}>
      <Icon size={12} strokeWidth={2.2} />
      {text ?? name}
    </span>
  );
}

/** A round person badge with the same look the agent has in the office. */
export function Avatar({
  id,
  name,
  size = 26,
  status,
}: {
  id: string;
  name: string;
  size?: number;
  status?: StatusKey;
}) {
  const look = avatarLook(id, name);
  return (
    <span
      className="avatar"
      data-status={status}
      style={{ '--av': look.shirt, '--av-skin': look.skin, '--av-size': `${size}px` } as React.CSSProperties}
      title={name}
    >
      <span className="avatar-face" aria-hidden="true">
        {look.initials}
      </span>
    </span>
  );
}

/** Technical detail one click away: hashes, ids and paths live here instead of in running text. */
export function Disclosure({
  summary = 'Technical details',
  children,
  open,
}: {
  summary?: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  return (
    <details className="disclosure" open={open}>
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/** A side panel that leaves the page usable behind it. Escape closes it; focus returns to the opener. */
export function Drawer({
  label: name,
  onClose,
  wide,
  head,
  children,
}: {
  label: string;
  onClose: () => void;
  wide?: boolean;
  head: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape' &&
        !document.querySelector('dialog[open]') &&
        [...document.querySelectorAll('.drawer')].at(-1) === ref.current
      )
        onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <aside ref={ref} tabIndex={-1} className={`drawer${wide ? ' wide' : ''}`} role="complementary" aria-label={name}>
      <div className="drawer-head">
        {head}
        <button className="icon-button" aria-label="Close details" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}
