import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { fmtTs } from "../lib/time";
import {
  canonicalsList,
  linksCountsBySource,
  linksCreateCanonicalAndLink,
  linksGetForProduct,
  linksLink,
  linksListUnlinked,
  linksUnlink,
  pricesListForProduct,
  productsListLatest,
  sourcesList,
  type CanonicalDoc,
  type LinkCountsBySource,
  type PricePointDoc,
  type ProductLatestDoc
} from "../convexFns";

export function LinkProductsPage(props: { sessionToken: string }) {
  const { sessionToken } = props;

  const sources = useQuery(sourcesList, { sessionToken }) ?? [];

  const [productSourceSlug, setProductSourceSlug] = useState<string | null>(null);
  useEffect(() => {
    if (!productSourceSlug && sources.length > 0) {
      setProductSourceSlug(sources[0]!.slug);
    }
  }, [productSourceSlug, sources]);

  const skip = "skip" as const;

  const linkCounts =
    useQuery(
      linksCountsBySource,
      sources.length > 0 ? { sessionToken, sourceSlugs: sources.map((s) => s.slug) } : ("skip" as const)
    ) ??
    [];
  const countsBySourceSlug = new Map<string, LinkCountsBySource>(linkCounts.map((c) => [c.sourceSlug, c]));

  const products =
    useQuery(
      productsListLatest,
      productSourceSlug ? { sessionToken, limit: 25, sourceSlug: productSourceSlug } : skip
    ) ?? [];

  const [unlinkedQuery, setUnlinkedQuery] = useState("");
  const unlinked =
    useQuery(
      linksListUnlinked,
      productSourceSlug
        ? {
            sessionToken,
            sourceSlug: productSourceSlug,
            limit: 60,
            q: unlinkedQuery.trim() ? unlinkedQuery.trim() : undefined
          }
        : skip
    ) ?? [];

  const productByKey = useMemo(() => {
    const map = new Map<string, ProductLatestDoc>();
    for (const p of products) map.set(`${p.sourceSlug}:${p.itemId}`, p);
    for (const p of unlinked) map.set(`${p.sourceSlug}:${p.itemId}`, p);
    return map;
  }, [products, unlinked]);

  const [selectedProductKey, setSelectedProductKey] = useState<{ sourceSlug: string; itemId: string } | null>(
    null
  );
  useEffect(() => {
    const current =
      selectedProductKey && productByKey.get(`${selectedProductKey.sourceSlug}:${selectedProductKey.itemId}`);
    if (current) return;

    const first = unlinked[0] ?? products[0];
    if (first) {
      setSelectedProductKey({ sourceSlug: first.sourceSlug, itemId: first.itemId });
    } else {
      setSelectedProductKey(null);
    }
  }, [selectedProductKey, productByKey, products, unlinked]);

  const selectedProduct = selectedProductKey
    ? productByKey.get(`${selectedProductKey.sourceSlug}:${selectedProductKey.itemId}`) ?? null
    : null;

  const pricePoints =
    useQuery(
      pricesListForProduct,
      selectedProductKey
        ? {
            sessionToken,
            sourceSlug: selectedProductKey.sourceSlug,
            itemId: selectedProductKey.itemId,
            limit: 120
          }
        : skip
    ) ?? [];
  const pricePointsChrono: PricePointDoc[] = [...pricePoints].reverse();

  const [canonicalQuery, setCanonicalQuery] = useState("");
  const canonicals =
    useQuery(canonicalsList, {
      sessionToken,
      limit: 80,
      q: canonicalQuery.trim() ? canonicalQuery.trim() : undefined
    }) ?? [];

  const linkForProduct = useQuery(
    linksGetForProduct,
    selectedProductKey
      ? { sessionToken, sourceSlug: selectedProductKey.sourceSlug, itemId: selectedProductKey.itemId }
      : skip
  );

  const linkProduct = useMutation(linksLink);
  const unlinkProduct = useMutation(linksUnlink);
  const createCanonicalAndLink = useMutation(linksCreateCanonicalAndLink);

  const [selectedCanonicalId, setSelectedCanonicalId] = useState<string | null>(null);
  const [newCanonicalName, setNewCanonicalName] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    setLinkError(null);
    setSelectedCanonicalId(null);
    setNewCanonicalName(selectedProduct?.name ?? "");
  }, [selectedProductKey?.sourceSlug, selectedProductKey?.itemId, selectedProduct?.name]);

  const canonicalOptions: CanonicalDoc[] = useMemo(() => {
    const canonical = linkForProduct?.canonical;
    if (!canonical) return canonicals;
    if (canonicals.some((c) => c._id === canonical._id)) return canonicals;
    return [canonical, ...canonicals];
  }, [canonicals, linkForProduct?.canonical]);

  useEffect(() => {
    const linkedCanonicalId = linkForProduct?.link.canonicalId;
    if (linkedCanonicalId && selectedCanonicalId !== linkedCanonicalId) {
      setSelectedCanonicalId(linkedCanonicalId);
      return;
    }
    if (!selectedCanonicalId && canonicalOptions.length > 0) setSelectedCanonicalId(canonicalOptions[0]!._id);
  }, [selectedCanonicalId, linkForProduct?.link.canonicalId, canonicalOptions]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 md:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <div className="text-sm font-medium">Latest products</div>
            {sources.length > 0 ? (
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <span>source</span>
                <select
                  className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                  value={productSourceSlug ?? ""}
                  onChange={(e) => setProductSourceSlug(e.target.value || null)}
                >
                  {sources.map((s) => (
                    <option key={s._id} value={s.slug}>
                      {s.slug}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <div className="px-4 py-3">
            {productSourceSlug === null ? (
              <div className="text-sm text-slate-300">Seed demo sources to view products.</div>
            ) : products.length === 0 ? (
              <div className="text-sm text-slate-300">No products yet.</div>
            ) : (
              <ul className="space-y-2">
                {products.map((p) => (
                  <li
                    key={p._id}
                    className={`flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 ${
                      selectedProductKey?.sourceSlug === p.sourceSlug && selectedProductKey?.itemId === p.itemId
                        ? "border-sky-700 bg-sky-950/30"
                        : "border-slate-800 bg-slate-950/40 hover:border-slate-700"
                    }`}
                    onClick={() => setSelectedProductKey({ sourceSlug: p.sourceSlug, itemId: p.itemId })}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {p.image?.mediaUrl ? (
                        <img
                          src={p.image.mediaUrl}
                          alt={p.name}
                          className="h-10 w-10 rounded bg-slate-900 object-cover"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <div className="h-10 w-10 rounded border border-slate-800 bg-slate-900/40" />
                      )}
                      <div className="min-w-0">
                        {p.url ? (
                          <a
                            className="truncate text-sm hover:underline"
                            href={p.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {p.name}
                          </a>
                        ) : (
                          <div className="truncate text-sm">{p.name}</div>
                        )}
                        <div className="mt-0.5 truncate text-xs text-slate-400">
                          {p.itemId} · seen {fmtTs(p.lastSeenAt)}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm">
                        {typeof p.lastPrice === "number" ? `${p.lastPrice} ${p.currency ?? ""}`.trim() : "—"}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/40 md:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <div className="text-sm font-medium">Unlinked products</div>
            {productSourceSlug ? (
              <div className="flex items-center gap-2 text-xs text-slate-300">
                <span className="text-slate-400">{productSourceSlug}</span>
                {(() => {
                  const c = countsBySourceSlug.get(productSourceSlug);
                  return c ? <span>{c.unlinked} unlinked</span> : null;
                })()}
              </div>
            ) : (
              <div className="text-xs text-slate-400">Select a source</div>
            )}
          </div>
          <div className="px-4 py-3">
            {productSourceSlug === null ? (
              <div className="text-sm text-slate-300">Seed demo sources and run a scraper first.</div>
            ) : (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                    placeholder="search name or itemId…"
                    value={unlinkedQuery}
                    onChange={(e) => setUnlinkedQuery(e.target.value)}
                  />
                  {unlinkedQuery.trim() ? (
                    <button
                      className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800"
                      type="button"
                      onClick={() => setUnlinkedQuery("")}
                    >
                      Clear
                    </button>
                  ) : null}
                </div>

                {unlinked.length === 0 ? (
                  <div className="text-sm text-slate-300">No unlinked products found.</div>
                ) : (
                  <ul className="space-y-2">
                    {unlinked.map((p) => (
                      <li
                        key={p._id}
                        className={`flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 ${
                          selectedProductKey?.sourceSlug === p.sourceSlug && selectedProductKey?.itemId === p.itemId
                            ? "border-sky-700 bg-sky-950/30"
                            : "border-slate-800 bg-slate-950/40 hover:border-slate-700"
                        }`}
                        onClick={() => setSelectedProductKey({ sourceSlug: p.sourceSlug, itemId: p.itemId })}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          {p.image?.mediaUrl ? (
                            <img
                              src={p.image.mediaUrl}
                              alt={p.name}
                              className="h-10 w-10 rounded bg-slate-900 object-cover"
                              loading="lazy"
                              decoding="async"
                            />
                          ) : (
                            <div className="h-10 w-10 rounded border border-slate-800 bg-slate-900/40" />
                          )}
                          <div className="min-w-0">
                            {p.url ? (
                              <a
                                className="truncate text-sm hover:underline"
                                href={p.url}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {p.name}
                              </a>
                            ) : (
                              <div className="truncate text-sm">{p.name}</div>
                            )}
                            <div className="mt-0.5 truncate text-xs text-slate-400">
                              {p.itemId} · seen {fmtTs(p.lastSeenAt)}
                            </div>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm">
                            {typeof p.lastPrice === "number" ? `${p.lastPrice} ${p.currency ?? ""}`.trim() : "—"}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/40 md:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <div className="text-sm font-medium">Price history</div>
            {selectedProduct ? (
              <div className="text-xs text-slate-400">
                {selectedProduct.sourceSlug} · {selectedProduct.itemId}
              </div>
            ) : (
              <div className="text-xs text-slate-400">Select a product</div>
            )}
          </div>
          <div className="px-4 py-3">
            {selectedProduct === null ? (
              <div className="text-sm text-slate-300">Select a product above.</div>
            ) : pricePointsChrono.length === 0 ? (
              <div className="text-sm text-slate-300">No price points yet.</div>
            ) : (
              <ul className="space-y-1">
                {pricePointsChrono.map((pt) => (
                  <li
                    key={pt._id}
                    className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/40 px-3 py-2"
                  >
                    <div className="text-xs text-slate-300">{fmtTs(pt.ts)}</div>
                    <div className="text-xs text-slate-200">
                      {Number.isFinite(pt.price) ? `${pt.price} ${pt.currency}`.trim() : "—"}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/40 md:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <div className="text-sm font-medium">Linking</div>
            {selectedProduct ? (
              <div className="text-xs text-slate-400">
                {selectedProduct.sourceSlug} · {selectedProduct.itemId}
              </div>
            ) : (
              <div className="text-xs text-slate-400">Select a product</div>
            )}
          </div>
          <div className="space-y-3 px-4 py-3">
            {linkError ? <div className="text-xs text-rose-200/90">link error: {linkError}</div> : null}

            {selectedProduct === null ? (
              <div className="text-sm text-slate-300">Select a product above.</div>
            ) : linkForProduct === undefined ? (
              <div className="text-sm text-slate-300">Loading link…</div>
            ) : (
              <>
                <div className="rounded border border-slate-800 bg-slate-950/40 px-3 py-2">
                  <div className="text-xs text-slate-400">Current canonical</div>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      {linkForProduct?.canonical ? (
                        <div className="truncate text-sm">{linkForProduct.canonical?.name}</div>
                      ) : linkForProduct ? (
                        <div className="truncate text-sm text-amber-200/90">Missing canonical</div>
                      ) : (
                        <div className="truncate text-sm text-slate-300">Unlinked</div>
                      )}
                      {linkForProduct?.canonical?.description ? (
                        <div className="mt-0.5 truncate text-xs text-slate-400">
                          {linkForProduct.canonical?.description}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800 disabled:opacity-50"
                        type="button"
                        disabled={!linkForProduct || linking}
                        onClick={async () => {
                          setLinking(true);
                          setLinkError(null);
                          try {
                            await unlinkProduct({
                              sessionToken,
                              sourceSlug: selectedProduct.sourceSlug,
                              itemId: selectedProduct.itemId
                            });
                          } catch (err) {
                            setLinkError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setLinking(false);
                          }
                        }}
                      >
                        Unlink
                      </button>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="rounded border border-slate-800 bg-slate-950/40 px-3 py-2">
                    <div className="text-xs text-slate-400">Link to existing canonical</div>
                    <div className="mt-2 flex flex-col gap-2">
                      <input
                        className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                        placeholder="search…"
                        value={canonicalQuery}
                        onChange={(e) => setCanonicalQuery(e.target.value)}
                      />
                      <select
                        className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                        value={selectedCanonicalId ?? ""}
                        onChange={(e) => setSelectedCanonicalId(e.target.value || null)}
                      >
                        <option value="" disabled>
                          Select canonical…
                        </option>
                        {canonicalOptions.map((c: CanonicalDoc) => (
                          <option key={c._id} value={c._id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800 disabled:opacity-50"
                        type="button"
                        disabled={!selectedCanonicalId || linking}
                        onClick={async () => {
                          if (!selectedCanonicalId) return;
                          setLinking(true);
                          setLinkError(null);
                          try {
                            await linkProduct({
                              sessionToken,
                              canonicalId: selectedCanonicalId,
                              sourceSlug: selectedProduct.sourceSlug,
                              itemId: selectedProduct.itemId
                            });
                          } catch (err) {
                            setLinkError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setLinking(false);
                          }
                        }}
                      >
                        Link
                      </button>
                    </div>
                  </div>

                  <div className="rounded border border-slate-800 bg-slate-950/40 px-3 py-2">
                    <div className="text-xs text-slate-400">Create canonical + link</div>
                    <div className="mt-2 flex flex-col gap-2">
                      <input
                        className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                        placeholder="Canonical name"
                        value={newCanonicalName}
                        onChange={(e) => setNewCanonicalName(e.target.value)}
                      />
                      <button
                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 hover:bg-slate-800 disabled:opacity-50"
                        type="button"
                        disabled={linking || !newCanonicalName.trim()}
                        onClick={async () => {
                          setLinking(true);
                          setLinkError(null);
                          try {
                            await createCanonicalAndLink({
                              sessionToken,
                              sourceSlug: selectedProduct.sourceSlug,
                              itemId: selectedProduct.itemId,
                              name: newCanonicalName.trim()
                            });
                            setCanonicalQuery("");
                          } catch (err) {
                            setLinkError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setLinking(false);
                          }
                        }}
                      >
                        Create + link
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

