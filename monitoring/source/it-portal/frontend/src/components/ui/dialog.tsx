import {
  HelpButton,
  HelpFeedback,
  useHelpOpen,
  useHelpTopic,
} from "../../Help";
import type { HelpTopic } from "../../helpTopics";
import { Dialog as SharedDialog } from "@pl/ui/dialog";
import type { ReactNode } from "react";

export function Dialog({
  helpTopic,
  ...props
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  helpTopic?: HelpTopic;
}) {
  const helpOpen = useHelpOpen();
  useHelpTopic(helpTopic, 10);
  return (
    <SharedDialog
      {...props}
      blockClose={helpOpen}
      onPointerDownOutside={(event) => {
        const target = event.detail.originalEvent.target;
        if (
          target instanceof Element &&
          target.closest(".action-notifications")
        )
          event.preventDefault();
      }}
      headingActions={<HelpButton topic={helpTopic} />}
      footer={<HelpFeedback />}
    />
  );
}
