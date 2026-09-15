import { useId, useState, type ReactNode } from 'react';
import type { DeviceLists } from '../../lib/media/local-media';
import type { MediaKind } from '../../lib/media/transport';
import { Popover } from '../Popover';
import { ThemeSwitcher } from '../ThemeSwitcher';
import {
  CameraIcon,
  CameraOffIcon,
  KeyboardIcon,
  LeaveIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  ScreenShareIcon,
} from './icons';

interface CallControlsProps {
  enabled: Record<MediaKind, boolean>;
  available: Record<MediaKind, boolean>;
  devices: DeviceLists;
  selectedDevice: Partial<Record<MediaKind, string>>;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onSwitchDevice: (kind: MediaKind, deviceId: string) => Promise<void>;
  onLeave: () => void;
  /** Screen sharing: null presenter means the slot is free. */
  canShare: boolean;
  sharing: boolean;
  presenterName: string | null;
  onToggleShare: () => void;
  onShowShortcuts: () => void;
}

type Tone = 'neutral' | 'off' | 'active';

const TONES: Record<Tone, string> = {
  neutral: 'bg-stage-raised text-stage-ink hover:bg-stage-hover',
  // Off reads as a warning, the way people know it from Meet and Zoom.
  off: 'bg-stage-danger text-white hover:bg-stage-danger-hover',
  active: 'bg-stage-accent text-stage hover:brightness-110',
};

function ControlButton({
  label,
  onClick,
  tone = 'neutral',
  disabled,
  children,
  shortcut,
}: {
  label: string;
  /** Single-key shortcut, shown in the tooltip (see useCallShortcuts). */
  shortcut?: string;
  onClick: () => void;
  tone?: Tone;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-keyshortcuts={shortcut}
      onClick={onClick}
      disabled={disabled}
      className={`flex size-12 items-center justify-center rounded-full transition-[background-color,filter] duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${TONES[tone]}`}
    >
      {children}
    </button>
  );
}

function DeviceSelect({
  label,
  kind,
  devices,
  value,
  onChange,
}: {
  label: string;
  kind: MediaKind;
  devices: MediaDeviceInfo[];
  value: string | undefined;
  onChange: (kind: MediaKind, deviceId: string) => Promise<void>;
}) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-ink-muted">
        {label}
      </label>
      <select
        id={id}
        value={value ?? ''}
        disabled={devices.length === 0}
        onChange={(e) => {
          setError(null);
          onChange(kind, e.target.value).catch(() => setError('That device could not be started.'));
        }}
        className="h-10 rounded-xl border border-edge-strong/50 bg-surface-raised px-3 text-sm text-ink"
      >
        {devices.length === 0 && <option value="">None found</option>}
        {devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-down">{error}</p>}
    </div>
  );
}

/** The centre of the call bar: your media, presenting, more, and leave. */
export function CallControls(props: CallControlsProps) {
  const { enabled, available } = props;
  return (
    <div role="toolbar" aria-label="Call controls" className="flex items-center gap-3">
      <ControlButton
        label={enabled.audio ? 'Turn off microphone' : 'Turn on microphone'}
        tone={enabled.audio ? 'neutral' : 'off'}
        disabled={!available.audio}
        shortcut="M"
        onClick={props.onToggleAudio}
      >
        {enabled.audio ? <MicIcon /> : <MicOffIcon />}
      </ControlButton>
      <ControlButton
        label={enabled.video ? 'Turn off camera' : 'Turn on camera'}
        tone={enabled.video ? 'neutral' : 'off'}
        disabled={!available.video}
        shortcut="V"
        onClick={props.onToggleVideo}
      >
        {enabled.video ? <CameraIcon /> : <CameraOffIcon />}
      </ControlButton>
      {props.canShare && (
        <ControlButton
          label={
            props.sharing
              ? 'Stop presenting'
              : props.presenterName
                ? `${props.presenterName} is presenting`
                : 'Present your screen'
          }
          tone={props.sharing ? 'active' : 'neutral'}
          disabled={!props.sharing && props.presenterName !== null}
          shortcut="S"
          onClick={props.onToggleShare}
        >
          <ScreenShareIcon />
        </ControlButton>
      )}
      <Popover
        label="More options"
        placement="top"
        button={<MoreIcon />}
        buttonClassName={`flex size-12 items-center justify-center rounded-full transition-colors ${TONES.neutral}`}
        // Centred over its button it would run off a phone screen: there it
        // spans the width, just above the call bar.
        panelClassName="w-80 p-4 max-sm:fixed max-sm:inset-x-4 max-sm:bottom-32 max-sm:mb-0 max-sm:w-auto max-sm:translate-x-0"
      >
        {(close) => (
          <div className="flex flex-col gap-4">
            <DeviceSelect
              label="Microphone"
              kind="audio"
              devices={props.devices.audio}
              value={props.selectedDevice.audio}
              onChange={props.onSwitchDevice}
            />
            <DeviceSelect
              label="Camera"
              kind="video"
              devices={props.devices.video}
              value={props.selectedDevice.video}
              onChange={props.onSwitchDevice}
            />
            <div className="flex items-center justify-between border-t border-edge pt-4">
              <span className="text-sm">Theme</span>
              <ThemeSwitcher />
            </div>
            <button
              type="button"
              onClick={() => {
                close();
                props.onShowShortcuts();
              }}
              aria-keyshortcuts="Shift+?"
              className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-2 text-left text-sm hover:bg-ink/6"
            >
              <span className="text-ink-muted">
                <KeyboardIcon />
              </span>
              Keyboard shortcuts
            </button>
          </div>
        )}
      </Popover>
      <button
        type="button"
        aria-label="Leave call"
        title="Leave call"
        onClick={props.onLeave}
        className="ml-1 flex h-12 w-16 items-center justify-center rounded-full bg-stage-danger text-white transition-colors hover:bg-stage-danger-hover"
      >
        <LeaveIcon />
      </button>
    </div>
  );
}
