import {
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { ThemeSwitcher } from './ThemeSwitcher';

/*
 * The shared building blocks. Conventions, so screens stay consistent:
 * - Actions are pill-shaped; primary is filled, secondary outlined, tonal
 *   for the "second most important" action, ghost for low-emphasis ones.
 * - Two sizes: md (40px, forms and page actions) and sm (32px, inside cards).
 * - Large headings use the regular weight; titles use medium (500).
 */

type ButtonVariant = 'primary' | 'tonal' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover shadow-sm hover:shadow',
  tonal: 'bg-accent-soft text-accent-soft-ink hover:brightness-95',
  secondary: 'border border-edge-strong/60 bg-transparent text-accent hover:bg-accent/8',
  ghost: 'text-ink-muted hover:bg-ink/6 hover:text-ink',
  danger: 'border border-edge-strong/60 bg-transparent text-down hover:bg-down/8',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3.5 text-[13px]',
  md: 'h-10 px-6 text-sm',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
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
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium tracking-[0.01em] whitespace-nowrap transition-[background-color,box-shadow,color,filter] duration-150 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none ${BUTTON_SIZES[size]} ${BUTTON_STYLES[variant]} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

/** A round, icon-only button. Always give it a label: it is the accessible name. */
export function IconButton({
  label,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-ink/6 hover:text-ink disabled:opacity-40 ${className}`}
    >
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
  const invalid = Boolean(errors?.length);
  const describedBy = [hint && `${id}-hint`, invalid && `${id}-error`].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          {...rest}
          id={id}
          type={isPassword && revealed ? 'text' : type}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy || undefined}
          className={`h-12 w-full rounded-xl border bg-surface-raised px-4 text-[15px] text-ink transition-[border-color,box-shadow] placeholder:text-ink-muted/80 focus:outline-none focus-visible:outline-none ${
            invalid
              ? 'border-down focus:ring-1 focus:ring-down'
              : 'border-edge-strong/50 hover:border-edge-strong focus:border-accent focus:ring-1 focus:ring-accent'
          } ${isPassword ? 'pr-20' : ''}`}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            aria-pressed={revealed}
            className="absolute inset-y-2 right-2 rounded-lg px-3 text-[13px] font-medium text-accent hover:bg-accent/8"
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {hint && !invalid && (
        <p id={`${id}-hint`} className="text-xs text-ink-muted">
          {hint}
        </p>
      )}
      {invalid ? (
        <p id={`${id}-error`} className="text-xs text-down">
          {errors?.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

type AlertTone = 'info' | 'success' | 'error' | 'warning';

const ALERT_STYLES: Record<AlertTone, string> = {
  info: 'bg-accent-soft text-accent-soft-ink',
  success: 'bg-up-soft text-ink',
  error: 'bg-down-soft text-ink',
  warning: 'bg-warn-soft text-ink',
};

export function Alert({ tone = 'info', children }: { tone?: AlertTone; children: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-xl px-4 py-3 text-sm leading-relaxed ${ALERT_STYLES[tone]}`}
    >
      {children}
    </div>
  );
}

/**
 * Two streams meeting: two circles whose overlap is drawn a shade deeper,
 * the way two translucent inks would mix. Fixed brand colours, so the mark
 * looks the same in both themes.
 */
export function LogoMark({ className = 'size-7' }: { className?: string }) {
  const clip = useId();
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <defs>
        <clipPath id={clip}>
          <circle cx="12" cy="16" r="9" />
        </clipPath>
      </defs>
      <circle cx="12" cy="16" r="9" fill="#2f6fed" />
      <circle cx="20" cy="16" r="9" fill="#12a594" />
      <circle cx="20" cy="16" r="9" fill="#1a3f9c" clipPath={`url(#${clip})`} />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 text-[19px] font-normal tracking-[-0.01em] text-ink">
      <LogoMark />
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
    <div className="flex min-h-screen flex-col bg-surface-sunken">
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <Logo />
        <ThemeSwitcher />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-4 pb-16">
        <div className="w-full max-w-[440px] rounded-[28px] bg-surface-raised px-6 py-9 sm:px-10">
          <h1 className="text-[28px] leading-9 font-normal tracking-[-0.01em]">{title}</h1>
          {subtitle && <p className="mt-2 text-[15px] text-ink-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
        {footer && <p className="mt-6 text-center text-sm text-ink-muted">{footer}</p>}
      </main>
      <footer className="px-6 pb-6 text-center text-xs text-ink-muted sm:px-10">
        Video meetings with end-to-end encrypted chat, files and whiteboard.
      </footer>
    </div>
  );
}

export function FullPageSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center text-accent">
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
      className="h-1 w-full overflow-hidden rounded-full bg-accent/15"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-150"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/*
 * Avatars: initials on a colour picked from the name, so a person keeps the
 * same colour everywhere. Every colour carries white text at 4.5:1 or more.
 */
const AVATAR_COLORS = [
  '#1f5fbf',
  '#a8471b',
  '#1b6e3c',
  '#b3261e',
  '#7438c0',
  '#006a73',
  '#8a4d00',
  '#3c5a99',
];

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function avatarColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length] ?? '#1f5fbf';
}

export function Avatar({
  name,
  seed,
  className = 'size-8 text-[13px]',
}: {
  name: string;
  /** Stable id for the colour; defaults to the name. */
  seed?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white select-none ${className}`}
      style={{ backgroundColor: avatarColor(seed ?? name) }}
    >
      {initials(name)}
    </span>
  );
}
