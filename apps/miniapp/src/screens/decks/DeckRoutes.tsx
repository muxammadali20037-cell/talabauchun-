import { Link, Route, Routes } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { MessageKey } from "@talaba/shared";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { Badge, Empty, ErrorState, Loading, Screen } from "../../components/ui";
import { DeckNew } from "./DeckNew";
import { DeckScreen } from "./DeckScreen";
import { formatDate, STATUS_KIND, THEME_SWATCH, type DeckListItem } from "./types";
import "./decks.css";

/** Presentation Studio: list → create (optionally plan first) → preview/edit/export. */
export function DeckRoutes() {
  return (
    <Routes>
      <Route index element={<DeckList />} />
      <Route path="new" element={<DeckNew />} />
      <Route path=":id" element={<DeckScreen />} />
    </Routes>
  );
}

function DeckList() {
  const { t, lang } = useI18n();
  const q = useInfiniteQuery({
    queryKey: ["decks"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<{ items: DeckListItem[]; nextCursor: string | null }>(`/api/decks?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (p) => p.nextCursor,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Screen title={t("deck.listTitle")} actions={<Link className="btn btn-primary btn-sm" to="/decks/new">+ {t("deck.create")}</Link>}>
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !items.length ? (
        <Empty icon="📊" text={t("deck.listEmpty")} action={<Link className="btn btn-primary" to="/decks/new">{t("deck.create")}</Link>} />
      ) : (
        <div className="stack">
          <div className="list">
            {items.map((d) => (
              <Link key={d.id} to={`/decks/${d.id}`} className="list-item">
                <span className="deck-swatch" aria-hidden style={{ background: THEME_SWATCH[d.theme]?.[0] }}>
                  <span style={{ background: THEME_SWATCH[d.theme]?.[1] }} />
                </span>
                <span className="grow">
                  <span className="break deck-list-title">{d.title}</span>
                  <span className="meta">
                    {t("deck.slidesN", { n: d.slides })} · {t("deck.updatedAt", { date: formatDate(d.updatedAt, lang) })}
                  </span>
                </span>
                <Badge kind={STATUS_KIND[d.status]}>{t(`deck.status.${d.status}` as MessageKey)}</Badge>
                <span className="chev" aria-hidden>›</span>
              </Link>
            ))}
          </div>
          {q.hasNextPage && (
            <button className="btn btn-secondary" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
              {q.isFetchingNextPage && <span className="spinner" aria-hidden />}
              {t("deck.loadMore")}
            </button>
          )}
        </div>
      )}
    </Screen>
  );
}
