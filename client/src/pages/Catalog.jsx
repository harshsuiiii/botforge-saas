import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useBots } from '../hooks/useBots';
import BotSelector from '../components/BotSelector';
import EmptyState from '../components/EmptyState';
import { formatPrice, safeHttpUrl } from '../components/ProductCard';

const POLL_MS = 3000;
const PAGE_SIZE = 20;
const ACTIVE = ['pending', 'processing'];

const STATUS_STYLES = {
  pending: 'bg-slate-100 text-slate-600',
  processing: 'bg-amber-100 text-amber-700',
  ready: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
};

const KIND_LABELS = { spreadsheet: 'Spreadsheet', pdf: 'PDF', url: 'Website' };

function formatDate(ts) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

export default function Catalog() {
  const { apiJson } = useApi();
  const [botId, setBotId] = useState(null);
  const [sources, setSources] = useState([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [dragging, setDragging] = useState(false);

  const [products, setProducts] = useState([]);
  const [pagination, setPagination] = useState({});
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);

  const fileInputRef = useRef(null);
  const resyncInputRef = useRef(null);
  const resyncTarget = useRef(null);

  const { bots, loading: loadingBots } = useBots();
  const [pollRetry, setPollRetry] = useState(0);

  // Default to the user's first bot, like Settings
  useEffect(() => {
    if (bots.length && !botId) setBotId(bots[0].id);
  }, [bots, botId]);

  const loadSources = useCallback(async () => {
    if (!botId) return;
    try {
      const data = await apiJson(`/api/bots/${botId}/catalog/sources`);
      setSources(data.sources || []);
    } catch (err) {
      setBanner({ type: 'error', text: err.message });
      setPollRetry((n) => n + 1); // re-arm polling even though sources didn't change
    }
  }, [apiJson, botId]);

  useEffect(() => {
    if (!botId) return;
    setLoadingSources(true);
    setSources([]);
    loadSources().finally(() => setLoadingSources(false));
  }, [botId, loadSources]);

  // Poll while any import is still running
  const anyActive = sources.some((s) => ACTIVE.includes(s.status));
  useEffect(() => {
    if (!anyActive) return undefined;
    const timer = setTimeout(loadSources, POLL_MS);
    return () => clearTimeout(timer);
  }, [anyActive, sources, pollRetry, loadSources]);

  // Debounce the product search box
  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Re-load the preview whenever an import finishes or the query changes
  const sourcesKey = useMemo(
    () => sources.map((s) => `${s.id}:${s.status}:${s.last_synced_at}`).join('|'),
    [sources],
  );
  useEffect(() => {
    if (!botId) return;
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (debouncedSearch) params.set('search', debouncedSearch);
    apiJson(`/api/bots/${botId}/catalog/products?${params}`)
      .then((data) => { setProducts(data.products || []); setPagination(data.pagination || {}); })
      .catch(() => { setProducts([]); setPagination({}); });
  }, [apiJson, botId, page, debouncedSearch, sourcesKey]);

  async function startImport(request, successText) {
    setBusy(true);
    setBanner(null);
    try {
      await request();
      setBanner({ type: 'info', text: successText });
      await loadSources();
    } catch (err) {
      setBanner({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  function uploadFile(file) {
    if (!file || !botId) return;
    const form = new FormData();
    form.append('file', file);
    startImport(
      () => apiJson(`/api/bots/${botId}/catalog/sources`, { method: 'POST', body: form }),
      `Importing ${file.name}…`,
    );
  }

  function addWebsite(e) {
    e.preventDefault();
    if (!url.trim() || !botId) return;
    startImport(
      () => apiJson(`/api/bots/${botId}/catalog/sources`, {
        method: 'POST',
        body: JSON.stringify({ url: url.trim() }),
      }),
      'Crawling the website…',
    ).then(() => setUrl(''));
  }

  function resync(source) {
    if (source.kind === 'url') {
      startImport(
        () => apiJson(`/api/bots/${botId}/catalog/sources/${source.id}/resync`, { method: 'POST' }),
        `Re-syncing ${source.name}…`,
      );
      return;
    }
    resyncTarget.current = source;
    resyncInputRef.current?.click();
  }

  function onResyncFile(e) {
    const file = e.target.files?.[0];
    const source = resyncTarget.current;
    e.target.value = '';
    if (!file || !source) return;
    const form = new FormData();
    form.append('file', file);
    startImport(
      () => apiJson(`/api/bots/${botId}/catalog/sources/${source.id}/resync`, { method: 'POST', body: form }),
      `Re-importing ${file.name}…`,
    );
  }

  async function remove(source) {
    if (!window.confirm(`Delete "${source.name}" and all products imported from it?`)) return;
    try {
      await apiJson(`/api/bots/${botId}/catalog/sources/${source.id}`, { method: 'DELETE' });
      await loadSources();
    } catch (err) {
      setBanner({ type: 'error', text: err.message });
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    uploadFile(e.dataTransfer.files?.[0]);
  }

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Catalog</h1>
          <p className="text-sm text-slate-500 mt-1">Products and information your bot answers from</p>
        </div>
        <BotSelector selectedBotId={botId} onBotChange={setBotId} showAllOption={false} />
      </div>

      {banner && (
        <div
          className={`mb-6 flex items-start justify-between gap-4 px-4 py-3 rounded-lg text-sm ${
            banner.type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-indigo-50 text-indigo-700 border border-indigo-200'
          }`}
        >
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} className="font-medium hover:underline">
            Dismiss
          </button>
        </div>
      )}

      {!botId && loadingBots ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : !botId ? (
        <p className="text-slate-500">No bots found. Complete onboarding first.</p>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`bg-white rounded-xl border-2 border-dashed shadow-sm p-6 text-center transition-colors ${
                dragging ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200'
              }`}
            >
              <h2 className="font-semibold text-slate-800">Upload a catalog file</h2>
              <p className="text-sm text-slate-500 mt-1">CSV, Excel (.xlsx) or PDF, up to 10 MB</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
                className="mt-4 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors"
              >
                Choose file
              </button>
              <p className="text-xs text-slate-400 mt-2">or drag and drop it here</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.pdf"
                className="hidden"
                onChange={(e) => { uploadFile(e.target.files?.[0]); e.target.value = ''; }}
              />
            </div>

            <form onSubmit={addWebsite} className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
              <h2 className="font-semibold text-slate-800">Add your website</h2>
              <p className="text-sm text-slate-500 mt-1">We read up to 50 pages on the same domain.</p>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://yourshop.com"
                className="mt-4 w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              />
              <button
                type="submit"
                disabled={busy || !url.trim()}
                className="mt-3 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors"
              >
                Import website
              </button>
            </form>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200">
              <h2 className="font-semibold text-slate-800">Sources</h2>
            </div>
            {loadingSources ? (
              <div className="flex justify-center py-12">
                <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : sources.length === 0 ? (
              <EmptyState
                title="No catalog yet"
                message="Upload a file or add your website so your bot can answer from your products."
                icon="table"
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="text-left px-4 py-3 font-semibold text-slate-600">Source</th>
                      <th className="text-left px-4 py-3 font-semibold text-slate-600">Status</th>
                      <th className="text-left px-4 py-3 font-semibold text-slate-600">Items</th>
                      <th className="text-left px-4 py-3 font-semibold text-slate-600">Last synced</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((s) => (
                      <tr key={s.id} className="border-b border-slate-100 align-top">
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-800 break-all">{s.name}</p>
                          <p className="text-xs text-slate-500">{KIND_LABELS[s.kind] ?? s.kind}</p>
                          {s.error && (
                            <p className={`text-xs mt-1 ${s.status === 'failed' ? 'text-red-600' : 'text-amber-700'}`}>
                              {s.error}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[s.status]}`}>
                            {s.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-700">{s.item_count}</td>
                        <td className="px-4 py-3 text-slate-700">{formatDate(s.last_synced_at)}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-right">
                          <button
                            type="button"
                            disabled={busy || anyActive}
                            onClick={() => resync(s)}
                            className="text-sm text-indigo-600 hover:text-indigo-800 font-medium disabled:opacity-40 mr-4"
                          >
                            Re-sync
                          </button>
                          <button
                            type="button"
                            onClick={() => remove(s)}
                            className="text-sm text-red-600 hover:text-red-800 font-medium"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <input
              ref={resyncInputRef}
              type="file"
              accept=".csv,.xlsx,.pdf"
              className="hidden"
              onChange={onResyncFile}
            />
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-slate-200">
              <h2 className="font-semibold text-slate-800">Products</h2>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search products…"
                className="min-w-[200px] px-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            {products.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-10">No products to show.</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="text-left px-4 py-3 font-semibold text-slate-600">Name</th>
                        <th className="text-left px-4 py-3 font-semibold text-slate-600">Category</th>
                        <th className="text-left px-4 py-3 font-semibold text-slate-600">Price</th>
                        <th className="text-left px-4 py-3 font-semibold text-slate-600">Stock</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((p) => {
                        const href = safeHttpUrl(p.url);
                        return (
                          <tr key={p.id} className="border-b border-slate-100">
                            <td className="px-4 py-3 text-slate-800">{p.name}</td>
                            <td className="px-4 py-3 text-slate-600">{p.category || '—'}</td>
                            <td className="px-4 py-3 text-slate-700">{formatPrice(p.price, p.currency) || '—'}</td>
                            <td className="px-4 py-3 text-slate-700">
                              {p.in_stock === true ? 'In stock' : p.in_stock === false ? 'Out of stock' : '—'}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {href && (
                                <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:text-indigo-800">
                                  View
                                </a>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 bg-slate-50">
                  <p className="text-xs text-slate-500">
                    Page {pagination.page} of {pagination.total_pages || 1} · {pagination.total} products
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => p - 1)}
                      className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white disabled:opacity-40 hover:bg-slate-50"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      disabled={page >= (pagination.total_pages || 1)}
                      onClick={() => setPage((p) => p + 1)}
                      className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white disabled:opacity-40 hover:bg-slate-50"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
