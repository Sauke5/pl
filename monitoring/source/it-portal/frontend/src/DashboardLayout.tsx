import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  GripVertical,
  LockKeyhole,
  Minus,
  RotateCcw,
  UnlockKeyhole,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { api, queryClient, useAPI } from "./api";
import { Button } from "./components/ui/button";
import { ErrorBox } from "./components/common";
import "./dashboard-layout.css";

export type DashboardTile = {
  id: string;
  width: number;
  height: number;
  heightRows?: number;
  pinned: boolean;
};
export type DashboardLayoutState = {
  revision: number;
  tiles: DashboardTile[];
  hidden: string[];
};
type Item = {
  id: string;
  label: string;
  content: ReactNode;
  width?: number;
  height?: number;
  hideable?: boolean;
};

function tileHeightRows(tile: DashboardTile): number {
  return (
    tile.heightRows ??
    (tile.height ? Math.ceil((88 + tile.height * 80) / 16) : 0)
  );
}

function clampHeightRows(rows: number): number {
  return Math.max(5, Math.min(100, Math.round(rows)));
}

export function DashboardLayout({
  view,
  items,
  legacyHidden = [],
  onAdvanced,
  toolbarActions,
}: {
  view: "admin" | "employee";
  items: Item[];
  legacyHidden?: string[];
  onAdvanced?: () => void;
  toolbarActions?: ReactNode;
}) {
  const columns = view === "admin" ? 12 : 8;
  const minWidth = view === "admin" ? 3 : 2;
  const path = `/dashboard-layout?view=${view}`;
  const saved = useAPI<DashboardLayoutState>(path);
  const [draft, setDraft] = useState<DashboardLayoutState>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const reducedMotion = useReducedMotion();
  const [dragID, setDragID] = useState<string>();
  const [dragOutline, setDragOutline] = useState<
    { x: number; y: number; width: number; height: number } | undefined
  >();
  const [rowSpans, setRowSpans] = useState<Record<string, number>>({});
  const gridRef = useRef<HTMLDivElement>(null);
  const hoverID = useRef<string | undefined>(undefined);
  const dragging = useRef<
    | {
        id: string;
        x: number;
        y: number;
        width: number;
        height: number;
        active: boolean;
      }
    | undefined
  >(undefined);
  const resize = useRef<
    | {
        id: string;
        x: number;
        y: number;
        width: number;
        heightRows: number;
        stepX: number;
      }
    | undefined
  >(undefined);
  const editing = !!draft;
  const itemSignature = items.map((item) => item.id).join("|");
  useEffect(() => {
    if (!editing) return;
    setDraft((previous) => {
      if (!previous) return previous;
      const added = items.filter(
        (item) => !previous.tiles.some((tile) => tile.id === item.id),
      );
      if (!added.length) return previous;
      return {
        ...previous,
        tiles: [
          ...previous.tiles,
          ...added.map((item) => ({
            id: item.id,
            width: item.width || 1,
            height: item.height ?? 0,
            heightRows: 0,
            pinned: false,
          })),
        ],
      };
    });
  }, [editing, itemSignature]);
  const source = draft || saved.data;
  const ordered = [
    ...(source?.tiles || [])
      .map((tile) => items.find((item) => item.id === tile.id))
      .filter((item): item is Item => !!item),
    ...items.filter(
      (item) => !source?.tiles.some((tile) => tile.id === item.id),
    ),
  ];
  const effectiveHidden = editing
    ? draft.hidden
    : saved.data?.revision
      ? saved.data.hidden
      : legacyHidden;
  const visible = ordered.filter((item) => !effectiveHidden.includes(item.id));
  const restorable = editing
    ? ordered.filter((item) => effectiveHidden.includes(item.id))
    : [];
  function tile(id: string): DashboardTile {
    const item = items.find((value) => value.id === id)!;
    return (
      source?.tiles.find((value) => value.id === id) || {
        id,
        width: item.width || 1,
        height: item.height ?? 0,
        heightRows: 0,
        pinned: false,
      }
    );
  }
  function begin() {
    setError(undefined);
    setDraft({
      revision: saved.data?.revision || 0,
      tiles: ordered.map((item) => tile(item.id)),
      hidden: saved.data?.revision ? [...saved.data.hidden] : [...legacyHidden],
    });
  }
  function update(id: string, change: Partial<DashboardTile>) {
    setDraft(
      (previous) =>
        previous && {
          ...previous,
          tiles: previous.tiles.map((value) =>
            value.id === id ? { ...value, ...change } : value,
          ),
        },
    );
  }
  function move(id: string, target: string, after = false) {
    if (id === target || tile(id).pinned || tile(target).pinned) return;
    setDraft((previous) => {
      if (!previous) return previous;
      const tiles = [...previous.tiles];
      const from = tiles.findIndex((value) => value.id === id);
      if (from < 0) return previous;
      const [moved] = tiles.splice(from, 1);
      const to = tiles.findIndex((value) => value.id === target);
      if (to < 0) return previous;
      tiles.splice(to + Number(after), 0, moved);
      return { ...previous, tiles };
    });
  }
  function step(id: string, delta: number) {
    const index = visible.findIndex((item) => item.id === id);
    const target = visible[index + delta];
    if (target) move(id, target.id, delta > 0);
  }
  const tileSignature = visible
    .map(
      (item) =>
        `${item.id}:${tile(item.id).width}:${tileHeightRows(tile(item.id))}`,
    )
    .join("|");
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const observer = new ResizeObserver((entries) => {
      const next: Record<string, number> = {};
      for (const entry of entries) {
        const id = entry.target.parentElement?.getAttribute("data-layout-tile");
        if (!id) continue;
        const height =
          entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        next[id] = Math.max(1, Math.ceil((height + 8) / 16));
      }
      setRowSpans((previous) => {
        if (Object.entries(next).every(([id, span]) => previous[id] === span))
          return previous;
        return { ...previous, ...next };
      });
    });
    grid
      .querySelectorAll<HTMLElement>(
        "[data-layout-tile] > .dashboard-tile-content",
      )
      .forEach((content) => observer.observe(content));
    return () => observer.disconnect();
  }, [tileSignature]);
  function pointerStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (!editing || event.button !== 0) return;
    const dragHandle = (event.target as HTMLElement).closest(
      ".dashboard-drag-handle",
    );
    const dragTile = dragHandle?.closest<HTMLElement>("[data-layout-tile]");
    const dragTileID = dragTile?.dataset.layoutTile;
    if (dragTileID && !tile(dragTileID).pinned) {
      const bounds = dragTile.getBoundingClientRect();
      dragging.current = {
        id: dragTileID,
        x: event.clientX,
        y: event.clientY,
        width: bounds.width,
        height: bounds.height,
        active: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const handle = (event.target as HTMLElement).closest(
      ".dashboard-resize-handle",
    );
    const id = handle
      ?.closest("[data-layout-tile]")
      ?.getAttribute("data-layout-tile");
    if (!id) return;
    const state = tile(id);
    if (state.pinned) return;
    const grid = event.currentTarget;
    const style = getComputedStyle(grid);
    const activeColumns =
      grid.getBoundingClientRect().width <= 760
        ? 1
        : parseFloat(style.getPropertyValue("--layout-columns")) || columns;
    const gap = parseFloat(style.columnGap) || 24;
    const stepX = (grid.getBoundingClientRect().width + gap) / activeColumns;
    const naturalHeight = handle!
      .closest("[data-layout-tile]")!
      .getBoundingClientRect().height;
    resize.current = {
      id,
      x: event.clientX,
      y: event.clientY,
      width: state.width,
      heightRows:
        tileHeightRows(state) ||
        clampHeightRows(Math.ceil((naturalHeight + 8) / 16)),
      stepX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragging.current;
    if (drag) {
      if (
        !drag.active &&
        Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5
      )
        return;
      if (!drag.active) {
        drag.active = true;
        setDragID(drag.id);
      }
      setDragOutline({
        x: event.clientX,
        y: event.clientY,
        width: drag.width,
        height: drag.height,
      });
      const grid = gridRef.current;
      const gridBounds = grid?.getBoundingClientRect();
      if (
        !grid ||
        !gridBounds ||
        event.clientX < gridBounds.left ||
        event.clientX > gridBounds.right ||
        event.clientY < gridBounds.top ||
        event.clientY > gridBounds.bottom
      )
        return;
      let target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-layout-tile]");
      if (!target) {
        const candidates = Array.from(
          grid.querySelectorAll<HTMLElement>("[data-layout-tile]"),
        ).filter(
          (node) =>
            node.dataset.layoutTile !== drag.id &&
            !tile(node.dataset.layoutTile!).pinned,
        );
        target = candidates.reduce<HTMLElement | undefined>((nearest, node) => {
          if (!nearest) return node;
          const distance = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            return Math.hypot(
              event.clientX - (rect.left + rect.right) / 2,
              event.clientY - (rect.top + rect.bottom) / 2,
            );
          };
          return distance(node) < distance(nearest) ? node : nearest;
        }, undefined);
      }
      const id = target?.dataset.layoutTile;
      if (!target || !id || id === drag.id || tile(id).pinned) return;
      const rect = target.getBoundingClientRect();
      const source = gridRef.current?.querySelector<HTMLElement>(
        `[data-layout-tile="${CSS.escape(drag.id)}"]`,
      );
      const sourceRect = source?.getBoundingClientRect();
      const sameRow = sourceRect && Math.abs(sourceRect.top - rect.top) < 16;
      const after = sameRow
        ? event.clientX > (rect.left + rect.right) / 2
        : event.clientY > (rect.top + rect.bottom) / 2;
      const hoverKey = `${id}:${after}`;
      if (hoverID.current !== hoverKey) {
        hoverID.current = hoverKey;
        move(drag.id, id, after);
      }
      return;
    }
    const start = resize.current;
    if (!start) return;
    const width = Math.max(
      minWidth,
      Math.min(
        columns,
        start.width + Math.round((event.clientX - start.x) / start.stepX),
      ),
    );
    const deltaRows = Math.round((event.clientY - start.y) / 16);
    update(start.id, {
      width,
      ...(deltaRows
        ? { heightRows: clampHeightRows(start.heightRows + deltaRows) }
        : {}),
    });
  }
  function pointerEnd() {
    dragging.current = undefined;
    hoverID.current = undefined;
    setDragID(undefined);
    setDragOutline(undefined);
    resize.current = undefined;
  }
  function resizeKey(event: ReactKeyboardEvent<HTMLButtonElement>, id: string) {
    const state = tile(id);
    if (state.pinned) return;
    const delta =
      event.key === "ArrowRight"
        ? { width: 1 }
        : event.key === "ArrowLeft"
          ? { width: -1 }
          : event.key === "ArrowDown"
            ? { height: 1 }
            : event.key === "ArrowUp"
              ? { height: -1 }
              : undefined;
    if (!delta) return;
    event.preventDefault();
    update(id, {
      width: Math.max(
        minWidth,
        Math.min(columns, state.width + (delta.width || 0)),
      ),
      ...(delta.height
        ? {
            heightRows: clampHeightRows(
              (tileHeightRows(state) ||
                Math.ceil(
                  (event.currentTarget
                    .closest("[data-layout-tile]")!
                    .getBoundingClientRect().height +
                    8) /
                    16,
                )) + delta.height,
            ),
          }
        : {}),
    });
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api<DashboardLayoutState>(path, "PUT", draft);
      queryClient.setQueryData([path], result);
      setDraft(undefined);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!editing) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDraft(undefined);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [editing]);
  return (
    <>
      <div className="dashboard-layout-toolbar">
        {editing ? (
          <>
            <span className="muted">
              Перетащите карточку за верхнюю ручку или измените размер за угол.
            </span>
            <Button
              size="sm"
              onClick={() =>
                setDraft(
                  (previous) =>
                    previous && {
                      ...previous,
                      tiles: items.map((item) => ({
                        id: item.id,
                        width: item.width || 1,
                        height: item.height ?? 0,
                        heightRows: 0,
                        pinned: false,
                      })),
                      hidden: [],
                    },
                )
              }
            >
              <RotateCcw size={15} /> Сбросить
            </Button>
            {onAdvanced && (
              <Button size="sm" onClick={onAdvanced}>
                Избранное и Wayline
              </Button>
            )}
            {toolbarActions}
            <Button
              size="sm"
              onClick={() => setDraft(undefined)}
              disabled={busy}
            >
              Отменить
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={() => void save()}
              disabled={busy}
            >
              Сохранить
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={begin}
            disabled={saved.isPending || !!saved.error}
          >
            Настроить главную
          </Button>
        )}
      </div>
      {saved.error && (
        <ErrorBox error={saved.error} retry={() => void saved.refetch()} />
      )}
      {error && <ErrorBox error={error} />}
      {editing && restorable.length > 0 && (
        <div className="dashboard-layout-restore">
          <span>Скрытые карточки:</span>
          {restorable.map((item) => (
            <Button
              key={item.id}
              size="sm"
              onClick={() =>
                setDraft(
                  (previous) =>
                    previous && {
                      ...previous,
                      hidden: previous.hidden.filter((id) => id !== item.id),
                    },
                )
              }
            >
              + {item.label}
            </Button>
          ))}
        </div>
      )}
      {!visible.length && !editing && (
        <p className="muted">
          Все карточки скрыты. Откройте «Настроить главную», чтобы вернуть
          нужные.
        </p>
      )}
      <div
        ref={gridRef}
        className={`dashboard-layout-grid dashboard-layout-${view} ${editing ? "is-editing" : ""}`}
        onPointerDown={pointerStart}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
        onLostPointerCapture={pointerEnd}
      >
        <AnimatePresence initial={false}>
          {visible.map((item) => {
            const state = tile(item.id);
            const heightRows = tileHeightRows(state);
            return (
              <motion.div
                key={item.id}
                layout
                initial={false}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 380, damping: 33, mass: 0.8 }
                }
                className={`dashboard-layout-tile ${heightRows > 0 ? "has-fixed-height" : ""} ${view === "admin" ? "home-section" : ""} ${item.id === "integrations" && view === "admin" ? "home-section-integrations" : ""} ${dragID === item.id ? "is-dragging" : ""}`}
                data-layout-tile={item.id}
                data-home-section={view === "admin" ? item.id : undefined}
                style={
                  {
                    "--tile-width": state.width,
                    "--tile-height-rows": heightRows,
                    "--tile-row-span": heightRows || rowSpans[item.id] || 1,
                  } as CSSProperties
                }
              >
                {editing && (
                  <>
                    {item.hideable && (
                      <button
                        type="button"
                        className="dashboard-remove-handle"
                        aria-label={`Скрыть: ${item.label}`}
                        title="Скрыть карточку"
                        onClick={() =>
                          setDraft(
                            (previous) =>
                              previous && {
                                ...previous,
                                hidden: [...previous.hidden, item.id],
                              },
                          )
                        }
                      >
                        <Minus size={19} strokeWidth={3} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="dashboard-drag-handle"
                      disabled={state.pinned}
                      aria-label={`Переместить: ${item.label}`}
                      title="Перетащить; стрелки вверх и вниз меняют порядок"
                      onKeyDown={(event) => {
                        if (
                          event.key === "ArrowUp" ||
                          event.key === "ArrowLeft"
                        ) {
                          event.preventDefault();
                          step(item.id, -1);
                        } else if (
                          event.key === "ArrowDown" ||
                          event.key === "ArrowRight"
                        ) {
                          event.preventDefault();
                          step(item.id, 1);
                        }
                      }}
                    >
                      <GripVertical size={18} />
                      <span>Переместить</span>
                    </button>
                    <button
                      type="button"
                      className="dashboard-pin-handle"
                      aria-label={`${state.pinned ? "Открепить" : "Закрепить"} положение: ${item.label}`}
                      title={
                        state.pinned
                          ? "Разрешить перемещение и размер"
                          : "Запретить ручное перемещение и изменение размера"
                      }
                      aria-pressed={state.pinned}
                      onClick={() => update(item.id, { pinned: !state.pinned })}
                    >
                      {state.pinned ? (
                        <LockKeyhole size={17} />
                      ) : (
                        <UnlockKeyhole size={17} />
                      )}
                    </button>
                    <button
                      type="button"
                      className="dashboard-resize-handle"
                      disabled={state.pinned}
                      aria-label={`Изменить размер: ${item.label}`}
                      title="Потяните за угол: размер привязывается к сетке. Двойной щелчок вернёт автоматическую высоту"
                      onKeyDown={(event) => resizeKey(event, item.id)}
                      onDoubleClick={() =>
                        update(item.id, { heightRows: 0, height: 0 })
                      }
                    >
                      <span aria-hidden="true" />
                    </button>
                  </>
                )}
                <div className="dashboard-tile-content">{item.content}</div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      {editing && dragOutline && (
        <div
          className="dashboard-drag-outline"
          data-drag-outline
          aria-hidden="true"
          style={{
            width: dragOutline.width,
            height: dragOutline.height,
            transform: `translate3d(${dragOutline.x - dragOutline.width / 2}px, ${dragOutline.y - 15}px, 0)`,
          }}
        />
      )}
    </>
  );
}
