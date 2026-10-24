/** Return the URL only if it is http(s); product data comes from imported catalogs. */
export function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function formatPrice(price, currency = 'INR') {
  if (price === null || price === undefined) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(price);
  } catch {
    return `${currency} ${price}`;
  }
}

export default function ProductCard({ product }) {
  const imageUrl = safeHttpUrl(product.image_url);
  const href = safeHttpUrl(product.url);
  const price = formatPrice(product.price, product.currency);

  return (
    <div className="w-40 shrink-0 bg-white rounded-xl border border-slate-200 p-2 flex flex-col gap-1">
      {imageUrl && (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          className="w-full h-24 object-cover rounded-lg bg-slate-100"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      )}
      <p className="text-xs font-semibold text-slate-800 break-words">{product.name}</p>
      {price && <p className="text-xs text-indigo-600">{price}</p>}
      {product.in_stock === false && (
        <span className="self-start text-[10px] font-medium text-red-700 bg-red-100 rounded px-1.5 py-0.5">
          Out of stock
        </span>
      )}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-auto text-center text-xs font-medium text-indigo-600 hover:text-indigo-800"
        >
          View
        </a>
      )}
    </div>
  );
}
