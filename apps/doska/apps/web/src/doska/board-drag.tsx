import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type DragMoveEvent,
} from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "framer-motion";
import { boardDropTarget } from "./board-move";
import type { BoardTask } from "./task-card";

type Insertion = {
  targetId: string;
  columnId: string;
  beforeTaskId: string | null;
  after: boolean;
  kind: "task" | "column";
};
const InsertionContext = createContext<Insertion | null>(null);
const CardDragContext = createContext<
  | Pick<
      ReturnType<typeof useDraggable>,
      "attributes" | "listeners" | "setActivatorNodeRef"
    >
  | undefined
>(undefined);

export function useCardTitleDrag() {
  return useContext(CardDragContext);
}

const boardKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { context },
) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code))
    return;
  event.preventDefault();
  const { collisionRect, droppableRects, droppableContainers, active } =
    context;
  if (!collisionRect) return;
  const x = collisionRect.left + collisionRect.width / 2;
  const y = collisionRect.top + collisionRect.height / 2;
  const vertical = event.code === "ArrowUp" || event.code === "ArrowDown";
  const positive = event.code === "ArrowDown" || event.code === "ArrowRight";
  const targets = droppableContainers
    .getEnabled()
    .filter(
      (item) =>
        item.id !== active?.id &&
        (!vertical || item.data.current?.kind === "task"),
    )
    .map((item) => ({ item, rect: droppableRects.get(item.id) }))
    .filter(
      ({ rect }) =>
        rect &&
        (vertical
          ? Math.abs(rect.left + rect.width / 2 - x) <
              collisionRect.width / 2 &&
            (positive
              ? rect.top + rect.height / 2 > y + 1
              : rect.top + rect.height / 2 < y - 1)
          : positive
            ? rect.left + rect.width / 2 > x + 1
            : rect.left + rect.width / 2 < x - 1),
    )
    .sort((a, b) =>
      vertical
        ? Math.abs(a.rect!.top + a.rect!.height / 2 - y) -
          Math.abs(b.rect!.top + b.rect!.height / 2 - y)
        : Math.abs(a.rect!.left + a.rect!.width / 2 - x) -
            Math.abs(b.rect!.left + b.rect!.width / 2 - x) ||
          Math.abs(a.rect!.top - y) - Math.abs(b.rect!.top - y),
    );
  const target = targets[0]?.rect;
  if (target)
    return {
      x: target.left + target.width / 2 - collisionRect.width / 2,
      y:
        target.top +
        target.height / 2 -
        collisionRect.height / 2 +
        (vertical ? (positive ? 1 : -1) : 0),
    };
};
const boardCollisions: CollisionDetection = (args) => {
  const collisions = args.pointerCoordinates
    ? pointerWithin(args)
    : closestCenter(args);
  // Card targets take priority over their containing column. The active card stays
  // a target so returning to the starting position cancels instead of appending.
  const cards = collisions.filter(
    (item) =>
      args.droppableContainers.find((target) => target.id === item.id)?.data
        .current?.kind === "task",
  );
  if (!args.pointerCoordinates) return collisions;
  if (cards.length) return cards;
  const column = collisions.find(
    (item) =>
      args.droppableContainers.find((target) => target.id === item.id)?.data
        .current?.kind === "column",
  );
  if (column) {
    const y = args.pointerCoordinates.y;
    const nearest = args.droppableContainers
      .filter(
        (target) =>
          target.data.current?.kind === "task" &&
          target.data.current?.columnId === column.id,
      )
      .map((target) => ({
        id: target.id,
        rect: args.droppableRects.get(target.id),
      }))
      .filter((target) => target.rect)
      .sort(
        (a, b) =>
          Math.abs(a.rect!.top + a.rect!.height / 2 - y) -
          Math.abs(b.rect!.top + b.rect!.height / 2 - y),
      )[0];
    if (nearest) return [{ id: nearest.id }];
  }
  return collisions;
};

export function BoardDragSurface({
  children,
  tasks,
  onMove,
  disabled,
}: {
  children: ReactNode;
  tasks: BoardTask[];
  onMove: (
    task: BoardTask,
    columnId: string,
    beforeTaskId: string | null,
  ) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("doska");
  const reducedMotion = useReducedMotion();
  const [active, setActive] = useState<BoardTask | null>(null);
  const [insertion, setInsertion] = useState<Insertion | null>(null);
  const targetRef = useRef<Insertion | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: boardKeyboardCoordinates }),
  );
  function preview({
    over,
    active: dragged,
    activatorEvent,
    delta,
  }: DragMoveEvent) {
    let target: Insertion | null = null;
    if (over && active && over.id !== active.id) {
      const kind = over.data.current?.kind as "task" | "column";
      const columnId = String(over.data.current?.columnId ?? over.id);
      const pointer = activatorEvent as PointerEvent;
      const center = dragged.rect.current.translated;
      const y =
        typeof pointer.clientY === "number"
          ? pointer.clientY + delta.y
          : center
            ? center.top + center.height / 2
            : over.rect.top;
      const after = y > over.rect.top + over.rect.height / 2;
      target = {
        ...boardDropTarget(tasks, active.id, String(over.id), columnId, after),
        targetId: String(over.id),
        kind,
        after,
      };
    }
    targetRef.current = target;
    setInsertion(target);
  }
  function clear() {
    setActive(null);
    setInsertion(null);
    targetRef.current = null;
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollisions}
      accessibility={{
        screenReaderInstructions: { draggable: t("dragInstructions") },
        announcements: {
          onDragStart: () => t("dragStarted"),
          onDragOver: ({ over }) =>
            over
              ? t("dragOverColumn", {
                  column: over.data.current?.name ?? over.data.current?.title,
                })
              : t("dragOutside"),
          onDragEnd: ({ over }) =>
            over ? t("dragReleased") : t("dragCancelled"),
          onDragCancel: () => t("dragCancelled"),
        },
      }}
      onDragStart={({ active: item }) => {
        if (!disabled)
          setActive(tasks.find((task) => task.id === item.id) ?? null);
      }}
      onDragMove={preview}
      onDragOver={preview}
      onDragCancel={clear}
      onDragEnd={({ over }) => {
        const target = targetRef.current;
        if (!disabled && active && over && target) {
          const currentColumn = tasks.filter(
            (task) => task.columnId === active.columnId,
          );
          const next =
            currentColumn[
              currentColumn.findIndex((task) => task.id === active.id) + 1
            ]?.id ?? null;
          if (
            target.columnId !== active.columnId ||
            target.beforeTaskId !== next
          )
            onMove(active, target.columnId, target.beforeTaskId);
        }
        clear();
      }}
    >
      <InsertionContext.Provider value={insertion}>
        {children}
      </InsertionContext.Provider>
      <DragOverlay
        dropAnimation={
          reducedMotion
            ? null
            : { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }
        }
      >
        {active && (
          <div
            className="doska-task-card doska-drag-overlay"
            aria-hidden="true"
          >
            <span className="doska-task-number">#{active.number}</span>
            <strong>{active.title}</strong>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

export function DraggableBoardTask({
  task,
  disabled,
  children,
}: {
  task: BoardTask;
  disabled: boolean;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const insertion = useContext(InsertionContext);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } =
    useDraggable({ id: task.id, disabled });
  const { setNodeRef: setDropRef } = useDroppable({
    id: task.id,
    disabled,
    data: { kind: "task", columnId: task.columnId, title: task.title },
  });
  const marker =
    insertion?.targetId === task.id
      ? insertion.after
        ? " is-insert-after"
        : " is-insert-before"
      : "";
  return (
    <motion.div
      layout="position"
      transition={{
        layout: { duration: reducedMotion ? 0 : 0.2, ease: "easeOut" },
      }}
      ref={(node) => {
        setNodeRef(node);
        setDropRef(node);
      }}
      className={`doska-draggable-task${isDragging ? " is-dragging" : ""}${marker}`}
    >
      <CardDragContext.Provider
        value={
          disabled ? undefined : { attributes, listeners, setActivatorNodeRef }
        }
      >
        {children}
      </CardDragContext.Provider>
    </motion.div>
  );
}

export function DroppableBoardColumn({
  id,
  name,
  disabled,
  semanticState,
  children,
}: {
  id: string;
  name: string;
  disabled: boolean;
  semanticState: string;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id,
    disabled,
    data: { kind: "column", name, columnId: id },
  });
  const insertion = useContext(InsertionContext);
  return (
    <section
      ref={setNodeRef}
      className={`doska-column state-${semanticState}${isOver ? " is-drop-target" : ""}${insertion?.kind === "column" && insertion.columnId === id ? " is-insert-end" : ""}`}
    >
      {children}
    </section>
  );
}
