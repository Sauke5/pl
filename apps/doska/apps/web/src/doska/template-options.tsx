import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
export function TemplateOptions({
  value,
  onChange,
  manageOnly = false,
  disabled = false,
}: {
  value: string;
  onChange: (id: string) => void;
  manageOnly?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation("doska");
  const list = useInfiniteQuery({
    queryKey: ["doska", "templates"],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api.listTemplates(pageParam),
    getNextPageParam: (last, pages) =>
      last.hasMore ? pages.length + 1 : undefined,
  });
  const items =
    list.data?.pages
      .flatMap((page) => page.items)
      .filter((item) => !manageOnly || item.canManage) ?? [];
  return (
    <div className="doska-template-options">
      <label className="doska-field">
        {t(manageOnly ? "templateSaveAs" : "template")}
        <select
          value={value}
          disabled={disabled || list.isPending}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">
            {t(manageOnly ? "templateNew" : "templateWithout")}
          </option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {list.isError && (
        <p role="alert" className="doska-error">
          {t("loadError")}{" "}
          <button type="button" onClick={() => void list.refetch()}>
            {t("retry")}
          </button>
        </p>
      )}
      {list.hasNextPage && (
        <button
          type="button"
          disabled={disabled || list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t("loadMore")}
        </button>
      )}
    </div>
  );
}
