import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "./components/ui/button";

export default function ModuleActionMenu({
  name,
  pending,
  disabled,
  removing,
  onAction,
  onRemove,
}: {
  name: string;
  pending: boolean;
  disabled: boolean;
  removing: boolean;
  onAction: (action: "refresh" | "enable" | "disable") => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  function choose(action: () => void) {
    setOpen(false);
    trigger.current?.focus();
    action();
  }
  return (
    <div
      className="module-action-menu"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Tab" && open) {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <Button
        variant="ghost"
        size="icon"
        ref={trigger}
        aria-label={`Действия: ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={19} />
      </Button>
      {open && (
        <div
          role="menu"
          aria-label={`Действия модуля ${name}`}
          className="module-action-popup"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled)',
              ),
            );
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                    items.length;
            items[next]?.focus();
          }}
        >
          <Button
            role="menuitem"
            variant="ghost"
            disabled={pending || disabled || removing}
            onClick={() => choose(() => onAction("refresh"))}
          >
            <RefreshCw size={15} />
            Проверить
          </Button>
          {!removing && (
            <Button
              role="menuitem"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                choose(() => onAction(disabled ? "enable" : "disable"))
              }
            >
              {disabled ? <Play size={15} /> : <Pause size={15} />}
              {disabled ? "Включить" : "Отключить"}
            </Button>
          )}
          <Button
            role="menuitem"
            variant="ghost"
            className="module-menu-danger"
            disabled={pending}
            onClick={() => choose(onRemove)}
          >
            <Trash2 size={15} />
            {removing ? "Повторить удаление" : "Удалить"}
          </Button>
        </div>
      )}
    </div>
  );
}
