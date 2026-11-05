import * as DialogPrimitive from "@radix-ui/react-dialog";
import { LazyMotion, domAnimation, m, useReducedMotion } from "motion/react";
import { useRef, type ComponentProps, type ReactNode } from "react";
import { Button } from "./react";

export function Dialog({
  title,
  description,
  children,
  onClose,
  wide = false,
  blockClose = false,
  headingActions,
  footer,
  closeLabel = "Закрыть",
  onPointerDownOutside,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  blockClose?: boolean;
  headingActions?: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
  onPointerDownOutside?: ComponentProps<typeof DialogPrimitive.Content>["onPointerDownOutside"];
}) {
  const reduce = useReducedMotion();
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open && !blockClose) onClose();
      }}
    >
      <LazyMotion features={domAnimation}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="dialog-overlay pl-ui-dialog-overlay" />
          <DialogPrimitive.Content
            {...(!description ? { "aria-describedby": undefined } : {})}
            onEscapeKeyDown={(event) => {
              if (blockClose) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (blockClose) event.preventDefault();
              onPointerDownOutside?.(event);
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              previousFocus.current?.focus();
            }}
            asChild
          >
            <m.div
              initial={reduce ? false : { opacity: 0, y: 10, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 380, damping: 33, mass: 0.8 }
              }
              transformTemplate={(_, transform) =>
                `translate(-50%, -50%) ${transform === "none" ? "" : transform}`
              }
              className={`dialog-content pl-ui-dialog ${wide ? "dialog-wide pl-ui-dialog-wide" : ""}`}
            >
              <div className="dialog-heading">
                <div>
                  <DialogPrimitive.Title className="dialog-title">
                    {title}
                  </DialogPrimitive.Title>
                  {description && (
                    <DialogPrimitive.Description className="muted">
                      {description}
                    </DialogPrimitive.Description>
                  )}
                </div>
                <div className="dialog-heading-actions">
                  {headingActions}
                  <DialogPrimitive.Close asChild>
                    <Button variant="ghost" size="icon" aria-label={closeLabel}>
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <path d="m6 6 12 12M18 6 6 18" />
                      </svg>
                    </Button>
                  </DialogPrimitive.Close>
                </div>
              </div>
              {children}
              {footer}
            </m.div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </LazyMotion>
    </DialogPrimitive.Root>
  );
}
