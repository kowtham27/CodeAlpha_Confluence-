/** Minimal inline icons. Decorative: every use sits next to a text label or aria-label. */

const base = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const MicIcon = () => (
  <svg {...base}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

export const MicOffIcon = ({ size = 20 }: { size?: number }) => (
  <svg {...base} width={size} height={size}>
    <path d="M3 3l18 18M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3" />
    <path d="M5 11a7 7 0 0 0 11.7 5.2M19 11a7 7 0 0 1-.6 2.8M12 18v3" />
  </svg>
);

export const CameraIcon = () => (
  <svg {...base}>
    <rect x="2" y="6" width="14" height="12" rx="2" />
    <path d="M16 10l6-3v10l-6-3z" />
  </svg>
);

export const CameraOffIcon = () => (
  <svg {...base}>
    <path d="M3 3l18 18M16 16v1a1 1 0 0 1-1 1H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2m4 0h5a1 1 0 0 1 1 1v3l6-3v10" />
  </svg>
);

export const SettingsIcon = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

/** A handset turned down: the universal "end call". */
export const LeaveIcon = () => (
  <svg viewBox="0 0 24 24" width={22} height={22} fill="currentColor" aria-hidden="true">
    <path d="M12 9.2c-2.3 0-4.5.4-6.6 1.2-.9.3-1.4 1.1-1.4 2v2.1c0 .7.7 1.3 1.4 1.1l2.6-.7c.6-.2 1-.7 1-1.3v-1.6c1-.3 2-.4 3-.4s2 .1 3 .4v1.6c0 .6.4 1.1 1 1.3l2.6.7c.7.2 1.4-.4 1.4-1.1v-2.1c0-.9-.5-1.7-1.4-2-2.1-.8-4.3-1.2-6.6-1.2z" />
  </svg>
);

export const ScreenShareIcon = () => (
  <svg {...base}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4M9 10l3-3 3 3M12 7v7" />
  </svg>
);

export const PaperclipIcon = () => (
  <svg {...base}>
    <path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />
  </svg>
);

export const LockIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...base} width={size} height={size}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export const FileIcon = () => (
  <svg {...base}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
  </svg>
);

export const DownloadIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...base} width={size} height={size}>
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </svg>
);

export const TrashIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...base} width={size} height={size}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3" />
  </svg>
);

export const CloseIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...base} width={size} height={size}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const ChatIcon = () => (
  <svg {...base}>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
  </svg>
);

export const MoreIcon = () => (
  <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="5.5" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="12" cy="18.5" r="1.8" />
  </svg>
);

export const InfoIcon = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.6v.1" />
  </svg>
);

export const PeopleIcon = () => (
  <svg {...base}>
    <circle cx="9" cy="8.5" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5.2a3.5 3.5 0 0 1 0 6.6M18.5 20a6.5 6.5 0 0 0-3-5.5" />
  </svg>
);

export const CopyIcon = () => (
  <svg {...base} width={18} height={18}>
    <rect x="8" y="8" width="12" height="12" rx="2.5" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);

export const CheckIcon = () => (
  <svg {...base} width={18} height={18}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export const KeyboardIcon = () => (
  <svg {...base}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9" />
  </svg>
);

export const PaletteIcon = () => (
  <svg {...base}>
    <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.5-1.9-.3-1 .4-2.1 1.5-2.1h2A4 4 0 0 0 21 13c0-5.5-4-10-9-10z" />
    <circle cx="7.5" cy="11.5" r="1" />
    <circle cx="10.5" cy="7.5" r="1" />
    <circle cx="15" cy="8" r="1" />
  </svg>
);
