import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export function SortableColumnRow({
  id,
  disabled,
  label,
  title,
  children,
}: {
  id: string;
  disabled: boolean;
  label: string;
  title: ReactNode;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  return (
    <li
      ref={setNodeRef}
      className={isDragging ? "doska-column-row-dragging" : undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div
        ref={setActivatorNodeRef}
        className="doska-column-drag-title"
        {...attributes}
        {...listeners}
        aria-label={label}
        tabIndex={disabled ? -1 : 0}
      >
        {title}
      </div>
      {children}
    </li>
  );
}
