import {
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { ThemeSwitcher } from './ThemeSwitcher';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover',
  secondary: 'border border-edge-strong bg-surface-raised text-ink hover:bg-surface-sunken',
  ghost: 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
  danger: 'border border-edge-strong bg-surface-raised text-down hover:bg-down-soft',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  busy?: boolean;
}

export function Button({
  variant = 'primary',
  busy = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={Boolean(disabled) || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_STYLES[variant]} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: string;
  /** Server-side validation messages for this field. */
  errors?: string[] | undefined;
}

/**
 * Label, input, hint and error wired together with ids, so screen readers
 * announce the hint and any error along with the field.
 */
export function Field({ label, hint, errors, type = 'text', ...rest }: FieldProps) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === 'password';
  const describedBy = [hint && `${id}-hint`, errors?.length && `${id}-error`]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <input
          {...rest}
          id={id}
          type={isPassword && revealed ? 'text' : type}
          aria-invalid={errors?.length ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={`w-full rounded-lg border bg-surface-raised px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted/70 ${
            errors?.length ? 'border-down' : 'border-edge-strong'
          } ${isPassword ? 'pr-16' : ''}`}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            aria-pressed={revealed}
            className="absolute inset-y-1 right-1 rounded-md px-2.5 text-xs font-medium text-ink-muted hover:bg-surface-sunken hover:text-ink"
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {hint && !errors?.length && (
        <p id={`${id}-hint`} className="text-xs text-ink-muted">
          {hint}
        </p>
      )}
      {errors?.length ? (
        <p id={`${id}-error`} className="text-xs text-down">
          {errors.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

type AlertTone = 'info' | 'success' | 'error' | 'warning';

const ALERT_STYLES: Record<AlertTone, string> = {
  info: 'border-accent/30 bg-accent-soft',
  success: 'border-up/30 bg-up-soft',
  error: 'border-down/30 bg-down-soft',
  warning: 'border-warn/40 bg-warn-soft',
};

export function Alert({ tone = 'info', children }: { tone?: AlertTone; children: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-lg border px-3.5 py-3 text-sm leading-relaxed ${ALERT_STYLES[tone]}`}
    >
      {children}
    </div>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight">
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-6">
        <circle cx="9" cy="12" r="6" fill="var(--accent)" opacity="0.9" />
        <circle cx="15" cy="12" r="6" fill="var(--up)" opacity="0.75" />
      </svg>
      Confluence
    </span>
  );
}

/** Centered single-card layout shared by every signed-out page. */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-between">
          <Logo />
          <ThemeSwitcher />
        </div>
        <div className="rounded-2xl border border-edge bg-surface-raised p-6 shadow-sm sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-ink-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
        {footer && <p className="mt-6 text-center text-sm text-ink-muted">{footer}</p>}
      </div>
    </main>
  );
}

export function FullPageSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center text-ink-muted">
      <Spinner label={label} />
    </main>
  );
}

/** A labelled, determinate progress bar. `value` is 0..1. */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-150"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
