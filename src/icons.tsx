import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function IconBase({ size = 20, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const GridIcon = (props: IconProps) => <IconBase {...props}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></IconBase>;
export const PlusIcon = (props: IconProps) => <IconBase {...props}><path d="M12 5v14M5 12h14"/></IconBase>;
export const FolderIcon = (props: IconProps) => <IconBase {...props}><path d="M3 7.5h7l2-2h9v13H3z"/></IconBase>;
export const ChevronIcon = (props: IconProps) => <IconBase {...props}><path d="m9 18 6-6-6-6"/></IconBase>;
export const SunIcon = (props: IconProps) => <IconBase {...props}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></IconBase>;
export const MoonIcon = (props: IconProps) => <IconBase {...props}><path d="M20 15.2A8.3 8.3 0 0 1 8.8 4 8.4 8.4 0 1 0 20 15.2Z"/></IconBase>;
export const PointerIcon = (props: IconProps) => <IconBase {...props}><path d="m5 3 13 9-6 1-3 6z"/></IconBase>;
export const TextIcon = (props: IconProps) => <IconBase {...props}><path d="M5 5h14M12 5v14M8 19h8"/></IconBase>;
export const ImageIcon = (props: IconProps) => <IconBase {...props}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/></IconBase>;
export const SheetIcon = (props: IconProps) => <IconBase {...props}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></IconBase>;
export const LinkIcon = (props: IconProps) => <IconBase {...props}><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1"/></IconBase>;
export const MoreIcon = (props: IconProps) => <IconBase {...props}><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></IconBase>;
export const GripIcon = (props: IconProps) => <IconBase {...props}><circle cx="8" cy="7" r="1" fill="currentColor"/><circle cx="16" cy="7" r="1" fill="currentColor"/><circle cx="8" cy="12" r="1" fill="currentColor"/><circle cx="16" cy="12" r="1" fill="currentColor"/><circle cx="8" cy="17" r="1" fill="currentColor"/><circle cx="16" cy="17" r="1" fill="currentColor"/></IconBase>;
export const CopyIcon = (props: IconProps) => <IconBase {...props}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></IconBase>;
export const TrashIcon = (props: IconProps) => <IconBase {...props}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></IconBase>;
export const UndoIcon = (props: IconProps) => <IconBase {...props}><path d="M9 7 4 12l5 5M5 12h8a6 6 0 0 1 6 6"/></IconBase>;
export const RedoIcon = (props: IconProps) => <IconBase {...props}><path d="m15 7 5 5-5 5M19 12h-8a6 6 0 0 0-6 6"/></IconBase>;
export const ZoomInIcon = (props: IconProps) => <IconBase {...props}><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M10.5 7.5v6M7.5 10.5h6"/></IconBase>;
export const ZoomOutIcon = (props: IconProps) => <IconBase {...props}><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M7.5 10.5h6"/></IconBase>;
export const ExternalIcon = (props: IconProps) => <IconBase {...props}><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/></IconBase>;
export const CheckIcon = (props: IconProps) => <IconBase {...props}><path d="m5 12 4 4L19 6"/></IconBase>;
export const XIcon = (props: IconProps) => <IconBase {...props}><path d="m6 6 12 12M18 6 6 18"/></IconBase>;
export const SearchIcon = (props: IconProps) => <IconBase {...props}><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></IconBase>;
export const DiceIcon = (props: IconProps) => <IconBase {...props}><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="16" cy="8" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="8" cy="16" r="1" fill="currentColor"/><circle cx="16" cy="16" r="1" fill="currentColor"/></IconBase>;
export const BoldIcon = (props: IconProps) => <IconBase {...props}><path d="M7 4h6a4 4 0 0 1 0 8H7z"/><path d="M7 12h7a4 4 0 0 1 0 8H7z"/></IconBase>;
export const ItalicIcon = (props: IconProps) => <IconBase {...props}><path d="M10 4h8M6 20h8M14 4 10 20"/></IconBase>;
export const UnderlineIcon = (props: IconProps) => <IconBase {...props}><path d="M6 4v7a6 6 0 0 0 12 0V4M4 20h16"/></IconBase>;
export const BulletListIcon = (props: IconProps) => <IconBase {...props}><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1.4" fill="currentColor"/><circle cx="4" cy="12" r="1.4" fill="currentColor"/><circle cx="4" cy="18" r="1.4" fill="currentColor"/></IconBase>;
export const NumberedListIcon = (props: IconProps) => <IconBase {...props}><path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 4.5h1.3v3.5M4 8h1.6"/><path d="M4 12.5c0-.7.6-1 1.1-1s1.1.3 1.1 1-1.1 1.1-2.2 2.5h2.3"/></IconBase>;
export const ChecklistIcon = (props: IconProps) => <IconBase {...props}><path d="M3.5 6l1.3 1.3L7.5 4.5"/><path d="M10 6h11"/><path d="M3.5 14l1.3 1.3 2.7-2.8"/><path d="M10 14h11"/></IconBase>;
