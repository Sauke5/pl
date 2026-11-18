import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Disc3, Monitor, Plus } from "lucide-react";
import { api, APIError } from "./api";
import { Badge, Empty, ErrorBox, Field, Panel } from "./components/common";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import {
  finishISO,
  type F12Pending,
  maxImageSize,
  sizeLabel,
  uploadISO,
  type F12Image,
  type F12Library,
  type F12Menu,
} from "./f12";
import "./f12-module.css";

type Instance = { id: string; desired_state: string; observed_state: string };
type Networks = Record<string, string>;

const pxeStatus = {
  manual:
    "Автоматическая загрузка для этой сети недоступна. Для запуска через свою PXE-службу используйте адрес меню iPXE.",
  idle: "Сетевая загрузка PL выключена. Она включится после публикации первого загрузочного образа в этой сети.",
  waiting:
    "PL готовит сетевую загрузку. Дождитесь готовности перед запуском компьютера по F12.",
  active:
    "Сетевая загрузка PL работает. В меню F12 компьютера выберите загрузку по сети.",
  error:
    "Сетевая загрузка PL недоступна. Проверьте состояние модуля и занятость UDP-портов 67, 69 и 4011 на хосте PL.",
};

const isoSources = [
  {
    name: "WinPE от Сергея Стрельца",
    url: "https://sergeistrelec.name/winpe_10_8/",
    description:
      "Восстановление Windows. Распакуйте архив автора и выберите файл .iso.",
  },
  {
    name: "Hiren’s BootCD PE",
    url: "https://www.hirensbootcd.org/download/",
    description:
      "Диагностика и восстановление Windows на компьютерах с UEFI x64.",
  },
  {
    name: "SystemRescue",
    url: "https://www.system-rescue.org/Download/",
    description:
      "Работа с разделами и файловыми системами, копирование данных.",
  },
  {
    name: "Ubuntu Server 24.04 LTS",
    url: "https://releases.ubuntu.com/24.04/",
    description:
      "Установка Ubuntu Server. Выберите ISO с live-server-amd64 в имени.",
  },
];

const recipeNotes: Partial<
  Record<string, { list: string; menu?: string; description: string }>
> = {
  library: {
    list: "Сетевая загрузка недоступна",
    description:
      "У этого ISO пока нет поддерживаемого способа сетевой загрузки.",
  },
  "bios-iso": {
    list: "Пробный запуск в Legacy BIOS",
    menu: "Legacy BIOS",
    description: "Можно попробовать на компьютере с Legacy BIOS.",
  },
  "hirens-winpe-x64": {
    list: "UEFI x64",
    menu: "UEFI x64",
    description:
      "Для компьютеров с UEFI x64. Основные программы доступны на сетевом диске только для чтения.",
  },
  "strelec-winpe": {
    list: "BIOS и UEFI x64",
    menu: "BIOS и UEFI x64",
    description:
      "Для компьютеров с BIOS или UEFI x64. При загрузке выберите версию WinPE из этого образа.",
  },
};

function NetworkChoice({
  networks,
  selected,
  onChange,
  disabled,
  pxe,
}: {
  networks: Networks;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  pxe?: F12Library["pxe"];
}) {
  const manualCount = selected.filter((id) => pxe?.[id] === "manual").length;
  let hint = "Без выбранной сети ISO сохранится в библиотеке.";
  if (pxe && selected.length) {
    if (!manualCount) {
      hint =
        "PL сама включает сетевую загрузку (PXE) после публикации загрузочного образа.";
    } else if (manualCount === selected.length) {
      hint =
        "Для запуска через свою PXE-службу используйте адрес из «Меню загрузки».";
    } else {
      hint =
        "PL включит загрузку в сетях с автоматическим PXE. Для сетей со своей PXE-службой используйте адрес из «Меню загрузки».";
    }
  }
  return (
    <fieldset className="f12-networks" disabled={disabled}>
      <legend>Сети публикации</legend>
      {Object.entries(networks).map(([id, name]) => (
        <label key={id}>
          <input
            type="checkbox"
            checked={selected.includes(id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, id]
                  : selected.filter((x) => x !== id),
              )
            }
          />
          <span>
            {name}
            {pxe?.[id] === "manual" && (
              <small className="muted"> · Своя PXE-служба</small>
            )}
          </span>
        </label>
      ))}
      {!Object.keys(networks).length && (
        <p className="muted">На хосте PL нет доступной сети для публикации.</p>
      )}
      <small className="muted">{hint}</small>
    </fieldset>
  );
}

function UploadDialog({
  base,
  networks,
  pxe,
  onClose,
  onDone,
}: {
  base: string;
  networks: Networks;
  pxe?: F12Library["pxe"];
  onClose: () => void;
  onDone: (image: F12Image) => void;
}) {
  const [file, setFile] = useState<File>();
  const [segments, setSegments] = useState<string[]>([]);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [sent, setSent] = useState(0);
  const [id] = useState(() => crypto.randomUUID());
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function upload() {
    if (!file || busy || cancelling) return;
    if (
      !file.name.toLowerCase().endsWith(".iso") ||
      file.size <= 0 ||
      file.size > maxImageSize
    ) {
      setError(new Error("Выберите файл .iso размером до 32 ГиБ."));
      return;
    }
    const run = new AbortController();
    controller.current = run;
    setBusy(true);
    setError(undefined);
    setStarted(true);
    try {
      const image = await uploadISO(
        base,
        id,
        file,
        segments,
        run.signal,
        (bytes, preparing) => {
          setSent(bytes);
          setProcessing(preparing);
        },
      );
      if (!run.signal.aborted) onDone(image);
    } catch (err) {
      if (!run.signal.aborted) setError(err);
    } finally {
      if (!run.signal.aborted) setBusy(false);
    }
  }
  async function cancel() {
    if (cancelling) return;
    if (!started) return onClose();
    controller.current?.abort();
    setBusy(false);
    setCancelling(true);
    try {
      await api(base + "/uploads/" + id, "DELETE");
      onClose();
    } catch (err) {
      if (err instanceof APIError && err.status === 404) {
        onClose();
        return;
      }
      setError(err);
      setCancelling(false);
    }
  }
  return (
    <Dialog
      title="Добавить ISO"
      onClose={() => {
        if (!busy && !cancelling) {
          if (!started) onClose();
          else void cancel();
        }
      }}
    >
      <form
        className="f12-form"
        onSubmit={(e) => {
          e.preventDefault();
          void upload();
        }}
      >
        <Field
          label="Файл образа"
          hint="Подойдёт исходный файл .iso размером до 32 ГиБ."
        >
          <input
            type="file"
            accept=".iso,application/x-iso9660-image"
            disabled={started}
            onChange={(e) => {
              setFile(e.target.files?.[0]);
              setError(undefined);
            }}
          />
        </Field>
        <details className="f12-sources">
          <summary>Где скачать ISO</summary>
          <ul>
            {isoSources.map(({ name, url, description }) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {name}
                </a>
                <span className="muted">{description}</span>
              </li>
            ))}
          </ul>
        </details>
        <NetworkChoice
          networks={networks}
          pxe={pxe}
          selected={segments}
          onChange={setSegments}
          disabled={started}
        />
        {started && file && (
          <div className="f12-progress" role="status">
            <span>
              {processing
                ? "PL готовит загрузочное меню…"
                : "Передано " + sizeLabel(sent) + " из " + sizeLabel(file.size)}
            </span>
            <progress aria-label="Передача ISO" max={file.size} value={sent} />
          </div>
        )}
        {error != null && <ErrorBox error={error} />}
        <div className="dialog-footer">
          <Button
            type="button"
            disabled={cancelling || (processing && busy)}
            onClick={() => void cancel()}
          >
            {started ? "Отменить загрузку" : "Отмена"}
          </Button>
          <Button
            type="submit"
            variant="default"
            disabled={!file || busy || cancelling}
          >
            {busy
              ? processing
                ? "Подготовка…"
                : "Загрузка…"
              : started
                ? "Продолжить"
                : "Загрузить ISO"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ImageDialog({
  base,
  image,
  networks,
  pxe,
  onClose,
  onDone,
}: {
  base: string;
  image: F12Image;
  networks: Networks;
  pxe?: F12Library["pxe"];
  onClose: () => void;
  onDone: () => void;
}) {
  const [segments, setSegments] = useState(
    image.segments.filter((id) => id in networks),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const description = recipeNotes[image.recipe]?.description;
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await api(base + "/images/" + image.id + "/networks", "PUT", {
        segments,
      });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={image.name}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="f12-form">
        <p>
          {sizeLabel(image.size)}
          {description && ` · ${description}`}
        </p>
        {image.recipe !== "library" && (
          <NetworkChoice
            networks={networks}
            pxe={pxe}
            selected={segments}
            onChange={setSegments}
            disabled={busy}
          />
        )}
        <details>
          <summary>Технические сведения</summary>
          <dl className="detail-grid f12-facts">
            <dt>Способ загрузки</dt>
            <dd>{image.compatibility}</dd>
            <dt>Файловая система</dt>
            <dd>{image.filesystem}</dd>
            <dt>SHA-256</dt>
            <dd>
              <code>{image.id}</code>
            </dd>
          </dl>
        </details>
        {error != null && <ErrorBox error={error} />}
        <div className="dialog-footer">
          <Button disabled={busy} onClick={onClose}>
            Закрыть
          </Button>
          {image.recipe !== "library" && (
            <Button
              variant="default"
              disabled={busy}
              onClick={() => void save()}
            >
              Сохранить сети
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function MenuDialog({
  base,
  library,
  libraryError,
  onRetry,
  onClose,
}: {
  base: string;
  library: F12Library;
  libraryError: unknown;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [segment, setSegment] = useState(
    Object.keys(library.segments)[0] || "",
  );
  const path = base + "/menu?segment=" + encodeURIComponent(segment);
  const menu = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api<F12Menu>(path, "GET", undefined, {}, signal),
    enabled: !!segment,
    staleTime: 0,
  });
  const pxe = library.pxe ? (library.pxe[segment] ?? "error") : undefined;
  return (
    <Dialog title="Меню загрузки" onClose={onClose}>
      <div className="f12-form">
        <Field label="Сеть компьютера">
          <select value={segment} onChange={(e) => setSegment(e.target.value)}>
            {Object.entries(library.segments).map(([id, name]) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        {pxe &&
          (libraryError ? (
            <ErrorBox error={libraryError} retry={onRetry} />
          ) : (
            <p role="status">{pxeStatus[pxe]}</p>
          ))}
        {menu.isError ? (
          <ErrorBox error={menu.error} retry={() => void menu.refetch()} />
        ) : menu.isPending ? (
          <p role="status">Загружаем меню…</p>
        ) : menu.data.items.length ? (
          <ol className="f12-menu">
            {menu.data.items.map((item) => {
              const label = recipeNotes[item.recipe]?.menu;
              return (
                <li key={item.id}>
                  <Disc3 size={16} />
                  {item.name}
                  {label && <small className="muted">{label}</small>}
                </li>
              );
            })}
          </ol>
        ) : (
          <Empty
            title="В этой сети пока нет образов"
            detail="Выберите эту сеть в карточке нужного ISO."
          />
        )}
        {library.boot_urls?.[segment] && (
          <details key={segment} open={pxe === "manual" ? true : undefined}>
            <summary>
              {pxe ? "Адрес меню iPXE" : "Как компьютер получает меню"}
            </summary>
            {!pxe && (
              <p>
                При старте по сети компьютер запускает iPXE через PXE-службу
                этой сети. Адрес меню для iPXE
              </p>
            )}
            <code>{library.boot_urls[segment]}</code>
          </details>
        )}
        <div className="dialog-footer">
          <Button onClick={onClose}>Закрыть</Button>
        </div>
      </div>
    </Dialog>
  );
}

function PendingUpload({
  base,
  upload,
  onDone,
}: {
  base: string;
  upload: F12Pending;
  onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const complete = upload.offset === upload.size;
  async function act(finish: boolean) {
    const run = new AbortController();
    active.current = run;
    setBusy(true);
    setError(undefined);
    try {
      if (finish) {
        await finishISO(base, upload.id, run.signal);
        onDone("Образ готов. Сети публикации указаны в библиотеке.");
      } else {
        await api(
          base + "/uploads/" + upload.id,
          "DELETE",
          undefined,
          {},
          run.signal,
        );
        onDone("Незавершённая загрузка отменена. Можно выбрать ISO заново.");
      }
    } catch (err) {
      if (!run.signal.aborted) setError(err);
    } finally {
      if (!run.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="f12-pending">
      <p>
        <strong>
          {complete ? "Подготовка образа" : "Незавершённая загрузка"}
        </strong>{" "}
        · {upload.name} · {sizeLabel(upload.offset)} из {sizeLabel(upload.size)}
      </p>
      {error != null && <ErrorBox error={error} />}
      <div className="actions">
        {complete && (
          <Button disabled={busy} onClick={() => void act(true)}>
            Проверить готовность
          </Button>
        )}
        {upload.state !== "processing" && (
          <Button disabled={busy} onClick={() => void act(false)}>
            Отменить загрузку
          </Button>
        )}
      </div>
    </div>
  );
}

export default function F12Module({ instance }: { instance: Instance }) {
  const base = "/modules/" + encodeURIComponent(instance.id) + "/f12";
  const path = base + "/library";
  const running =
    instance.desired_state === "enabled" &&
    instance.observed_state === "running";
  const [dialog, setDialog] = useState<"upload" | "menu" | F12Image>();
  const library = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) =>
      api<F12Library>(path, "GET", undefined, {}, signal),
    enabled: running,
    staleTime: 0,
    refetchInterval: (query) =>
      dialog === "menu" && query.state.data?.pxe ? 4000 : false,
  });
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const data = library.data;
  const items = (data?.items || []).filter((im) =>
    im.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  function close() {
    setDialog(undefined);
  }
  function done(message: string) {
    setNotice(message);
    close();
    void library.refetch();
  }
  return (
    <div className="f12-page">
      <div className="page-title">
        <div>
          <a
            className="back-link"
            href={"#modules?instance=" + encodeURIComponent(instance.id)}
          >
            <ArrowLeft size={15} /> К модулям
          </a>
          <h1>Сетевая загрузка F12</h1>
        </div>
        {running && (
          <div className="actions">
            <Button
              disabled={!data || !Object.keys(data.segments).length}
              onClick={() => {
                setDialog("menu");
                if (data?.pxe) void library.refetch();
              }}
            >
              <Monitor size={16} /> Меню загрузки
            </Button>
            <Button
              variant="default"
              disabled={!data || !!data.pending}
              onClick={() => setDialog("upload")}
            >
              <Plus size={16} /> Добавить ISO
            </Button>
          </div>
        )}
      </div>
      {!running ? (
        <Empty
          title={
            instance.desired_state === "enabled"
              ? "Модуль F12 недоступен"
              : "Модуль F12 отключён"
          }
          detail="Состояние экземпляра доступно в списке модулей."
        />
      ) : (
        <Panel title="Библиотека ISO" icon={<Disc3 size={18} />}>
          {data?.pending && dialog !== "upload" && (
            <PendingUpload
              key={data.pending.id}
              base={base}
              upload={data.pending}
              onDone={done}
            />
          )}
          {notice && (
            <p role="status" className="f12-notice">
              {notice}
            </p>
          )}
          {library.isError && (
            <ErrorBox
              error={library.error}
              retry={() => void library.refetch()}
            />
          )}
          {library.isPending ? (
            <p role="status">Загружаем библиотеку…</p>
          ) : (
            data && (
              <>
                {data.items.length > 0 && (
                  <Field label="Поиск по названию">
                    <input
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Имя ISO"
                    />
                  </Field>
                )}
                {!items.length ? (
                  <Empty
                    title={
                      search ? "Образы не найдены" : "Библиотека пока пуста"
                    }
                    detail={
                      search
                        ? "Измените название в поиске."
                        : "Добавьте загрузочный ISO и выберите сети, в которых он появится в меню компьютера."
                    }
                  />
                ) : (
                  <div className="f12-table-wrap">
                    <table aria-label="Образы ISO">
                      <thead>
                        <tr>
                          <th>Образ</th>
                          <th>Размер</th>
                          <th>Сети</th>
                          <th>Публикация</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((im) => {
                          const reachable = im.segments.some(
                            (id) => id in data.segments,
                          );
                          const label = recipeNotes[im.recipe]?.list;
                          return (
                            <tr key={im.id}>
                              <td>
                                <button
                                  className="f12-image-link"
                                  onClick={() => setDialog(im)}
                                >
                                  {im.name}
                                </button>
                                {label && (
                                  <small className="muted">{label}</small>
                                )}
                              </td>
                              <td>{sizeLabel(im.size)}</td>
                              <td>
                                {im.segments
                                  .map(
                                    (id) =>
                                      data.segments[id] || "Сеть недоступна",
                                  )
                                  .join(", ") || "—"}
                              </td>
                              <td>
                                <Badge
                                  value={reachable ? "connected" : "disabled"}
                                >
                                  {reachable
                                    ? "Опубликован"
                                    : im.segments.length
                                      ? "Сеть недоступна"
                                      : "В библиотеке"}
                                </Badge>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )
          )}
        </Panel>
      )}
      {running && data && dialog === "upload" && (
        <UploadDialog
          base={base}
          networks={data.segments}
          pxe={data.pxe}
          onClose={() => {
            close();
            void library.refetch();
          }}
          onDone={(image) =>
            done(
              image.existing
                ? image.segments.length
                  ? "Этот ISO уже в библиотеке. Выбранные сети сохранены."
                  : "Этот ISO уже есть в библиотеке."
                : image.segments.length
                  ? "Образ опубликован в выбранных сетях."
                  : "Образ добавлен в библиотеку.",
            )
          }
        />
      )}
      {running && data && dialog === "menu" && (
        <MenuDialog
          base={base}
          library={data}
          libraryError={library.error}
          onRetry={() => void library.refetch()}
          onClose={close}
        />
      )}
      {running && data && typeof dialog === "object" && (
        <ImageDialog
          base={base}
          image={dialog}
          networks={data.segments}
          pxe={data.pxe}
          onClose={close}
          onDone={() => done("Сети публикации сохранены.")}
        />
      )}
    </div>
  );
}
