import { useTranslation } from "react-i18next";
export const membersPageSize = 50;
export function MemberPagination({
  offset,
  count,
  pending,
  onPage,
}: {
  offset: number;
  count: number;
  pending: boolean;
  onPage: (offset: number) => void;
}) {
  const { t } = useTranslation("doska");
  if (!offset && count < membersPageSize) return null;
  return (
    <nav className="doska-pagination" aria-label={t("membersPagination")}>
      <button
        type="button"
        disabled={!offset || pending}
        onClick={() => onPage(Math.max(0, offset - membersPageSize))}
      >
        {t("membersPrevious")}
      </button>
      <span className="doska-meta">
        {t("membersPage", { page: offset / membersPageSize + 1 })}
      </span>
      <button
        type="button"
        disabled={count < membersPageSize || pending}
        onClick={() => onPage(offset + membersPageSize)}
      >
        {t("membersNext")}
      </button>
    </nav>
  );
}
