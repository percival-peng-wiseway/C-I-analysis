import { X } from "lucide-react";
import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

export function Drawer({
  children,
  description,
  label,
  onClose,
  open,
  presentation = "drawer",
}: {
  children: ReactNode;
  description: string;
  label: string;
  onClose: () => void;
  open: boolean;
  presentation?: "drawer" | "fullscreen";
}) {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  const fullscreen = presentation === "fullscreen";
  return (
    <div
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className={`fixed inset-0 z-50 flex ${fullscreen ? "bg-white" : "justify-end bg-slate-950/45 backdrop-blur-[2px]"}`}
      onKeyDown={trapFocus}
      onMouseDown={(event) => { if (!fullscreen && event.target === event.currentTarget) onClose(); }}
      role="dialog"
    >
      <section
        className={`flex w-full flex-col overflow-hidden bg-white ${fullscreen ? "h-[100dvh]" : "h-full shadow-2xl sm:w-[min(960px,calc(100vw-1.5rem))] sm:border-l sm:border-slate-200"}`}
        data-presentation={presentation}
      >
        <header className={`flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 ${fullscreen ? "sm:px-8" : "sm:px-6"}`}>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[.18em] text-cyan-700">Project calculation ledger</p>
            <h2 className="mt-1 truncate text-xl font-semibold text-slate-950" id={titleId}>{label}</h2>
            <p className="mt-1 text-sm leading-5 text-slate-500" id={descriptionId}>{description}</p>
          </div>
          <button aria-label={`Close ${label}`} className="inline-grid size-10 shrink-0 place-items-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950" onClick={onClose} ref={closeRef} type="button"><X className="size-5" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </section>
    </div>
  );
}

function trapFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab") return;
  const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute("hidden"));
  const first = elements[0];
  const last = elements.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
