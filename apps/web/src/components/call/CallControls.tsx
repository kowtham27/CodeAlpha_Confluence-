import { useId, useState, type ReactNode } from 'react';
import type { DeviceLists } from '../../lib/media/local-media';
import type { MediaKind } from '../../lib/media/transport';
import {
  CameraIcon,
  CameraOffIcon,
  LeaveIcon,
  MicIcon,
  MicOffIcon,
  ScreenShareIcon,
  SettingsIcon,
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
}

function ControlButton({
  label,
  onClick,
  active,
  danger,
  disabled,
  children,
  expanded,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  children: ReactNode;
}) {
  const tone = danger
    ? 'bg-down text-white hover:opacity-90'
    : active === false
      ? 'bg-down-soft text-down hover:opacity-90'
      : 'bg-surface-sunken text-ink hover:bg-edge';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      className={`flex size-12 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
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
        className="rounded-lg border border-edge-strong bg-surface-raised px-3 py-2 text-sm"
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

export function CallControls(props: CallControlsProps) {
  const [showDevices, setShowDevices] = useState(false);
  const { enabled, available } = props;

  return (
    <div className="relative flex flex-col items-center gap-3">
      {showDevices && (
        <div className="absolute bottom-full mb-3 w-72 rounded-2xl border border-edge bg-surface-raised p-4 shadow-lg">
          <div className="flex flex-col gap-3">
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
          </div>
        </div>
      )}
      <div
        role="toolbar"
        aria-label="Call controls"
        className="flex items-center gap-3 rounded-full border border-edge bg-surface-raised px-4 py-2 shadow-sm"
      >
        <ControlButton
          label={enabled.audio ? 'Turn off microphone' : 'Turn on microphone'}
          active={enabled.audio}
          disabled={!available.audio}
          onClick={props.onToggleAudio}
        >
          {enabled.audio ? <MicIcon /> : <MicOffIcon />}
        </ControlButton>
        <ControlButton
          label={enabled.video ? 'Turn off camera' : 'Turn on camera'}
          active={enabled.video}
          disabled={!available.video}
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
            active={props.sharing ? false : undefined}
            disabled={!props.sharing && props.presenterName !== null}
            onClick={props.onToggleShare}
          >
            <ScreenShareIcon />
          </ControlButton>
        )}
        <ControlButton
          label="Choose camera and microphone"
          expanded={showDevices}
          onClick={() => setShowDevices((v) => !v)}
        >
          <SettingsIcon />
        </ControlButton>
        <ControlButton label="Leave call" danger onClick={props.onLeave}>
          <LeaveIcon />
        </ControlButton>
      </div>
    </div>
  );
}
