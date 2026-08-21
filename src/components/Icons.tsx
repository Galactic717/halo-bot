interface IconProps {
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const PlusIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M8 3.5v9M3.5 8h9" /></svg>
);

export const SearchIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3 3" /></svg>
);

export const MonitorIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.4" /><path d="M6 13.2h4" /></svg>
);

export const GearIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M12.9 9.6a1 1 0 0 0 .2 1.1l.1.1a1.2 1.2 0 1 1-1.7 1.7l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9v.2a1.2 1.2 0 0 1-2.4 0v-.1a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a1.2 1.2 0 1 1-1.7-1.7l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6h-.2a1.2 1.2 0 0 1 0-2.4h.1a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a1.2 1.2 0 1 1 1.7-1.7l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9v-.2a1.2 1.2 0 0 1 2.4 0v.1a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a1.2 1.2 0 1 1 1.7 1.7l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6h.2a1.2 1.2 0 0 1 0 2.4h-.1a1 1 0 0 0-.9.6z" />
  </svg>
);

export const ChevronsRightIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="m4 4 4 4-4 4M9 4l4 4-4 4" /></svg>
);

export const ChevronLeftIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M10 3 5 8l5 5" /></svg>
);

export const ArrowUpIcon = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}><path d="M8 12.5v-9M4 7.5 8 3.5l4 4" /></svg>
);

export const StopIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}><rect x="4" y="4" width="8" height="8" rx="1.4" fill="currentColor" /></svg>
);

export const PaperclipIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M11.5 7.2 7.4 11.3a2.3 2.3 0 0 1-3.3-3.3l4.6-4.6a1.6 1.6 0 0 1 2.3 2.3L6.4 10.4a.8.8 0 0 1-1.1-1.1l3.9-3.9" /></svg>
);

export const PlugIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0zM8 11.5V14" /></svg>
);

export const ClockIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}><circle cx="8" cy="8" r="5.6" /><path d="M8 5v3.2l2 1.2" /></svg>
);

export const TrashIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}><path d="M3 4.5h10M6.4 4.5V3h3.2v1.5M4.4 4.5l.6 8.2h6l.6-8.2" /></svg>
);

export const PlayIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}><path d="M5.5 3.6v8.8l7-4.4z" fill="currentColor" /></svg>
);

export const CloseIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="m4 4 8 8M12 4l-8 8" /></svg>
);

export const CheckIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}><path d="m3.5 8.5 3 3 6-7" /></svg>
);

export const RefreshIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5h-2.5" /></svg>
);

export const ListIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.6 4.5h.01M2.6 8h.01M2.6 11.5h.01" /></svg>
);

export const WarningIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M8 2.6 14.2 13H1.8zM8 6.6v3M8 11.4h.01" /></svg>
);

export const FolderIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M2 4.6h4l1.2 1.6H14v6.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /></svg>
);

export const InfoIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><circle cx="8" cy="8" r="6" /><path d="M8 7.4v3.4M8 5.4h.01" /></svg>
);

export const PowerIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M8 2.6v5.2M5 4.4a4.6 4.6 0 1 0 6 0" /></svg>
);

export const SmileIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><circle cx="8" cy="8" r="6" /><path d="M5.6 9.4a3 3 0 0 0 4.8 0M6 6.4h.01M10 6.4h.01" /></svg>
);

export const ReplyIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M6.5 4 3 7.2l3.5 3.2M3.3 7.2H9a4 4 0 0 1 4 4v.6" /></svg>
);

export const CopyIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><rect x="5.4" y="5.4" width="7.2" height="7.2" rx="1.3" /><path d="M10.6 5.4V4.3a1 1 0 0 0-1-1H4.4a1 1 0 0 0-1 1v5.2a1 1 0 0 0 1 1h1.1" /></svg>
);

export const RecordIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><circle cx="8" cy="8" r="5.4" /><circle cx="8" cy="8" r="2.4" fill="currentColor" /></svg>
);

export const SparkIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M8 2.4 9.3 6l3.6 1.3-3.6 1.3L8 12.2 6.7 8.6 3.1 7.3 6.7 6zM12.4 11.2l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" /></svg>
);
