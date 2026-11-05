import { HelpButton, useHelpOpen, useHelpTopic } from "./Help";
import type { HelpTopic } from "./helpTopics";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./components/ui/button";
import "./workspace.css";

export function WorkspaceDrawer({
  title,
  helpTopic,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  helpTopic?: HelpTopic;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const helpOpen = useHelpOpen();
  useHelpTopic(helpTopic, helpTopic ? 3 : -1);
  return (
    <DialogPrimitive.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open && !helpOpen) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          className="workspace-drawer"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (helpOpen) event.preventDefault();
          }}
          onFocusOutside={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => {
            const target = event.detail.originalEvent.target as HTMLElement;
            if (
              helpOpen ||
              target.closest(
                ".dialog-content, .dialog-overlay, .help-coach, .help-overlay, [data-help-replay], .action-notifications",
              )
            )
              event.preventDefault();
          }}
        >
          <div className="workspace-drawer-heading">
            <div>
              {subtitle && <p className="muted">{subtitle}</p>}
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            </div>
            <div className="actions">
              {helpTopic && <HelpButton topic={helpTopic} />}
              <DialogPrimitive.Close asChild>
                <Button size="icon" variant="ghost" aria-label="Закрыть панель">
                  <X size={20} />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </div>
          <div className="workspace-drawer-body">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
