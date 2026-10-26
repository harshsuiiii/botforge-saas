/**
 * BotForge Widget  –  widget.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop-in embeddable chat widget. Self-contained — no external dependencies.
 *
 * Usage:
 *   <script src="https://botforge.io/widget.js" data-bot="YOUR_EMBED_KEY" async></script>
 *
 * All DOM elements use the bf- class prefix to avoid colliding with host styles.
 * All styles are injected into a <style> tag in document <head>.
 */

(function () {
  'use strict';

  // ─── Configuration ──────────────────────────────────────────────────────────

  const BOT_NAME    = 'BotForge Assistant';  // default; overridden by server first-msg metadata
  const SESSION_KEY = 'bf_session_id';
  const MAX_CARDS   = 4;

  // ─── Pure helpers (product cards) ───────────────────────────────────────────

  /** Return the URL only if it is http(s); blocks javascript:, data: and junk. */
  function safeHttpUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(String(value));
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  /** Locale currency formatting, falling back to "CODE amount" for bad codes. */
  function formatPrice(price, currency) {
    if (price === null || price === undefined) return '';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(price);
    } catch {
      return `${currency} ${price}`;
    }
  }

  // Test hook: tests set window.__BF_TEST__ = true before loading the script.
  if (window.__BF_TEST__ === true) window.__BF_TEST__ = { safeHttpUrl, formatPrice };

  /** Find THIS script tag to read data-* attributes. */
  const scriptTag = document.currentScript ||
    (function () {
      const tags = document.getElementsByTagName('script');
      return tags[tags.length - 1];
    })();

  const EMBED_KEY = scriptTag?.getAttribute('data-bot') ?? '';

  if (!EMBED_KEY) {
    console.warn('[BotForge] No data-bot attribute found on widget script tag.');
    return;
  }

  /**
   * The API lives on the same server that serves widget.js, so derive it from
   * the script's own src. An explicit data-api attribute overrides this.
   */
  function resolveApiBase() {
    const override = scriptTag?.getAttribute('data-api');
    if (override) return override.replace(/\/+$/, '');
    try {
      return new URL(scriptTag.src).origin;
    } catch {
      return window.location.origin;
    }
  }

  const API_BASE = resolveApiBase();
  const CHAT_URL = `${API_BASE}/chat`;

  // ─── Session ID ─────────────────────────────────────────────────────────────

  function getSessionId() {
    return sessionStorage.getItem(SESSION_KEY) ?? null;
  }

  function setSessionId(id) {
    sessionStorage.setItem(SESSION_KEY, id);
  }

  // ─── Injected Styles ────────────────────────────────────────────────────────

  const CSS = `
    /* ── Reset for bf- elements only ── */
    .bf-widget *,
    .bf-widget *::before,
    .bf-widget *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    /* ── Bubble trigger button ── */
    #bf-bubble {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483646;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      box-shadow: 0 4px 20px rgba(99,102,241,0.45), 0 2px 8px rgba(0,0,0,0.18);
      transition: transform 0.2s cubic-bezier(0.34,1.56,0.64,1),
                  box-shadow 0.2s ease;
      outline: none;
    }
    #bf-bubble:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 28px rgba(99,102,241,0.55), 0 3px 12px rgba(0,0,0,0.22);
    }
    #bf-bubble:active { transform: scale(0.96); }

    #bf-bubble svg { transition: opacity 0.18s ease, transform 0.18s ease; }
    #bf-bubble .bf-icon-close { display: none; }

    #bf-bubble.bf-open .bf-icon-chat  { display: none; }
    #bf-bubble.bf-open .bf-icon-close { display: block; }

    /* Notification badge */
    #bf-badge {
      position: absolute;
      top: -2px;
      right: -2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #ef4444;
      border: 2px solid #fff;
      display: none;
    }
    #bf-badge.bf-visible { display: block; }

    /* ── Chat panel ── */
    #bf-panel {
      position: fixed;
      bottom: 92px;
      right: 24px;
      z-index: 2147483645;
      width: 350px;
      height: 520px;
      border-radius: 20px;
      background: #0f0f13;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 24px 64px rgba(0,0,0,0.5), 0 4px 16px rgba(0,0,0,0.3);
      display: flex;
      flex-direction: column;
      overflow: hidden;

      /* Hidden state */
      opacity: 0;
      transform: translateY(16px) scale(0.97);
      pointer-events: none;
      transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.34,1.56,0.64,1);
    }
    #bf-panel.bf-visible {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: all;
    }

    /* ── Header ── */
    #bf-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      background: linear-gradient(135deg, #18181f 0%, #1e1b2e 100%);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    }
    .bf-avatar {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .bf-avatar svg { width: 18px; height: 18px; }
    #bf-bot-name {
      flex: 1;
      font-size: 14px;
      font-weight: 600;
      color: #f1f1f3;
      letter-spacing: 0.01em;
    }
    #bf-status {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: #6b7280;
    }
    .bf-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 6px rgba(34,197,94,0.6);
    }
    #bf-close-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: #6b7280;
      padding: 4px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      transition: color 0.15s, background 0.15s;
    }
    #bf-close-btn:hover { color: #f1f1f3; background: rgba(255,255,255,0.07); }

    /* ── Message list ── */
    #bf-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scroll-behavior: smooth;
    }
    #bf-messages::-webkit-scrollbar { width: 4px; }
    #bf-messages::-webkit-scrollbar-track { background: transparent; }
    #bf-messages::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.1);
      border-radius: 4px;
    }

    /* ── Message bubbles ── */
    .bf-msg {
      display: flex;
      gap: 8px;
      align-items: flex-end;
      max-width: 100%;
      flex-shrink: 0;   /* rows keep their height once the list overflows and scrolls */
    }
    .bf-msg.bf-user { flex-direction: row-reverse; }

    .bf-msg-avatar {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
    }
    .bf-msg.bf-bot .bf-msg-avatar {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
    }
    .bf-msg.bf-user .bf-msg-avatar {
      background: rgba(255,255,255,0.1);
      color: #9ca3af;
    }

    .bf-bubble {
      max-width: 78%;
      padding: 10px 13px;
      border-radius: 16px;
      font-size: 13.5px;
      line-height: 1.55;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .bf-msg.bf-bot .bf-bubble {
      background: rgba(255,255,255,0.06);
      color: #e5e7eb;
      border-bottom-left-radius: 4px;
    }
    .bf-msg.bf-user .bf-bubble {
      background: linear-gradient(135deg, #6366f1, #7c3aed);
      color: #fff;
      border-bottom-right-radius: 4px;
      box-shadow: 0 2px 12px rgba(99,102,241,0.3);
    }

    /* ── Typing indicator ── */
    #bf-typing {
      display: none;
      align-items: flex-end;
      gap: 8px;
    }
    #bf-typing.bf-visible { display: flex; }
    .bf-typing-bubble {
      background: rgba(255,255,255,0.06);
      border-radius: 16px;
      border-bottom-left-radius: 4px;
      padding: 12px 14px;
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .bf-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #6366f1;
      animation: bf-bounce 1.2s infinite ease-in-out;
    }
    .bf-dot:nth-child(1) { animation-delay: 0s; }
    .bf-dot:nth-child(2) { animation-delay: 0.18s; }
    .bf-dot:nth-child(3) { animation-delay: 0.36s; }
    @keyframes bf-bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30%            { transform: translateY(-5px); opacity: 1; }
    }

    /* ── Timestamp ── */
    .bf-ts {
      font-size: 10px;
      color: #4b5563;
      padding: 0 4px;
      align-self: flex-end;
    }

    /* ── Empty state ── */
    #bf-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      color: #4b5563;
      font-size: 13px;
      text-align: center;
      padding: 24px;
    }
    #bf-empty svg { opacity: 0.3; margin-bottom: 4px; }
    #bf-empty p { color: #6b7280; }

    /* ── Input area ── */
    #bf-input-area {
      padding: 12px 14px 14px;
      border-top: 1px solid rgba(255,255,255,0.06);
      background: #0f0f13;
      flex-shrink: 0;
    }
    #bf-form {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 14px;
      padding: 8px 8px 8px 14px;
      transition: border-color 0.18s;
    }
    #bf-form:focus-within {
      border-color: rgba(99,102,241,0.5);
      box-shadow: 0 0 0 3px rgba(99,102,241,0.12);
    }
    #bf-input {
      flex: 1;
      background: none;
      border: none;
      outline: none;
      color: #f1f1f3;
      font-size: 13.5px;
      line-height: 1.5;
      resize: none;
      max-height: 100px;
      overflow-y: auto;
      padding: 2px 0;
      caret-color: #6366f1;
    }
    #bf-input::placeholder { color: #4b5563; }
    #bf-input::-webkit-scrollbar { width: 3px; }
    #bf-input::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }

    #bf-send {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      border: none;
      cursor: pointer;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #6366f1, #7c3aed);
      box-shadow: 0 2px 8px rgba(99,102,241,0.35);
      transition: transform 0.15s ease, opacity 0.15s ease, box-shadow 0.15s ease;
    }
    #bf-send:hover {
      transform: scale(1.06);
      box-shadow: 0 4px 14px rgba(99,102,241,0.5);
    }
    #bf-send:active { transform: scale(0.94); }
    #bf-send:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }
    #bf-send svg { width: 16px; height: 16px; }

    #bf-footer {
      text-align: center;
      font-size: 10px;
      color: #374151;
      margin-top: 8px;
      letter-spacing: 0.02em;
    }
    #bf-footer a {
      color: #4b5563;
      text-decoration: none;
    }
    #bf-footer a:hover { color: #6366f1; }

    /* ── Mobile responsive ── */
    @media (max-width: 480px) {
      #bf-panel {
        bottom: 0;
        right: 0;
        left: 0;
        width: 100%;
        height: 90dvh;
        border-radius: 20px 20px 0 0;
        transform: translateY(24px) scale(1);
      }
      #bf-panel.bf-visible { transform: translateY(0) scale(1); }
      #bf-bubble {
        bottom: 16px;
        right: 16px;
      }
    }

    /* ── Cursor blink for streaming ── */
    .bf-cursor::after {
      content: '▍';
      display: inline-block;
      animation: bf-blink 0.7s step-end infinite;
      color: #6366f1;
      font-size: 11px;
      vertical-align: middle;
      margin-left: 1px;
    }
    @keyframes bf-blink {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0; }
    }

    /* ── Product cards ── */
    .bf-cards {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding: 2px 0 4px 32px;
      flex-shrink: 0;   /* overflow-x makes min-height 0, so without this the row collapses */
    }
    .bf-cards::-webkit-scrollbar { height: 4px; }
    .bf-cards::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
    .bf-card {
      flex: 0 0 140px;
      width: 140px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px;
      border-radius: 12px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .bf-card-img {
      width: 100%;
      height: 88px;
      object-fit: cover;
      border-radius: 8px;
      background: rgba(255,255,255,0.04);
    }
    .bf-card-name {
      font-size: 12px;
      font-weight: 600;
      color: #e5e7eb;
      line-height: 1.35;
      word-break: break-word;
    }
    .bf-card-price { font-size: 12px; color: #a5b4fc; }
    .bf-card-badge {
      align-self: flex-start;
      font-size: 10px;
      color: #fca5a5;
      background: rgba(239,68,68,0.15);
      border-radius: 6px;
      padding: 1px 6px;
    }
    .bf-card-link {
      margin-top: auto;
      font-size: 12px;
      font-weight: 600;
      color: #fff;
      text-align: center;
      text-decoration: none;
      padding: 5px 0;
      border-radius: 8px;
      background: linear-gradient(135deg, #6366f1, #7c3aed);
    }
    .bf-card-link:hover { opacity: 0.9; }
  `;

  // ─── SVG Icons ───────────────────────────────────────────────────────────────

  const ICON_CHAT = `<svg class="bf-icon-chat" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

  const ICON_CLOSE_BUBBLE = `<svg class="bf-icon-close" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  const ICON_CLOSE_PANEL = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  const ICON_SEND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;

  const ICON_BOT = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="15" x2="8" y2="15"/><line x1="16" y1="15" x2="16" y2="15"/></svg>`;

  const ICON_EMPTY = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

  // ─── DOM Construction ────────────────────────────────────────────────────────

  function injectStyles() {
    const style = document.createElement('style');
    style.id    = 'bf-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function buildWidget() {
    // ── Bubble ──────────────────────────────────────────────────────────────
    const bubble = document.createElement('button');
    bubble.id    = 'bf-bubble';
    bubble.setAttribute('aria-label', 'Open chat');
    bubble.classList.add('bf-widget');
    bubble.innerHTML = ICON_CHAT + ICON_CLOSE_BUBBLE + '<span id="bf-badge"></span>';

    // ── Panel ───────────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.id    = 'bf-panel';
    panel.classList.add('bf-widget');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Chat with bot');

    panel.innerHTML = `
      <div id="bf-header">
        <div class="bf-avatar">${ICON_BOT}</div>
        <div style="flex:1;min-width:0;">
          <div id="bf-bot-name">${BOT_NAME}</div>
          <div id="bf-status">
            <span class="bf-status-dot"></span>
            <span>Online</span>
          </div>
        </div>
        <button id="bf-close-btn" aria-label="Close chat">${ICON_CLOSE_PANEL}</button>
      </div>

      <div id="bf-messages" role="log" aria-live="polite" aria-label="Chat messages">
        <div id="bf-empty">
          ${ICON_EMPTY}
          <p>Send a message to start the conversation.</p>
        </div>

        <div id="bf-typing" role="status" aria-label="Bot is typing">
          <div class="bf-msg-avatar bf-widget" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:10px;color:#fff;">B</div>
          <div class="bf-typing-bubble">
            <span class="bf-dot"></span>
            <span class="bf-dot"></span>
            <span class="bf-dot"></span>
          </div>
        </div>
      </div>

      <div id="bf-input-area">
        <form id="bf-form" autocomplete="off">
          <textarea
            id="bf-input"
            rows="1"
            placeholder="Type a message…"
            aria-label="Chat input"
            maxlength="4096"
          ></textarea>
          <button id="bf-send" type="submit" aria-label="Send message">
            ${ICON_SEND}
          </button>
        </form>
        <div id="bf-footer">Powered by <a href="https://botforge.io" target="_blank" rel="noopener">BotForge</a></div>
      </div>
    `;

    document.body.appendChild(bubble);
    document.body.appendChild(panel);

    return { bubble, panel };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Auto-resize textarea up to max-height as user types. */
  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
  }

  /** Scroll the message list to the very bottom. */
  function scrollToBottom(container) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }

  // ─── Message Rendering ───────────────────────────────────────────────────────

  /**
   * Append a message row to the list and return the bubble element.
   * For bot streaming messages, the bubble is returned so tokens can be appended.
   *
   * @param {'user'|'bot'} role
   * @param {string}       text        – initial content (may be empty for streaming)
   * @param {HTMLElement}  msgList
   * @param {HTMLElement}  emptyState
   * @returns {HTMLElement} the inner bubble <div>
   */
  function appendMessage(role, text, msgList, emptyState) {
    // Hide empty state on first message
    if (emptyState) emptyState.style.display = 'none';

    const row = document.createElement('div');
    row.classList.add('bf-msg', 'bf-widget', role === 'user' ? 'bf-user' : 'bf-bot');

    const avatarEl = document.createElement('div');
    avatarEl.classList.add('bf-msg-avatar', 'bf-widget');
    avatarEl.textContent = role === 'user' ? 'U' : 'B';

    const bubbleEl = document.createElement('div');
    bubbleEl.classList.add('bf-bubble', 'bf-widget');
    if (text) bubbleEl.textContent = text;

    const tsEl = document.createElement('div');
    tsEl.classList.add('bf-ts', 'bf-widget');
    tsEl.textContent = formatTime(new Date());

    if (role === 'user') {
      row.appendChild(tsEl);
      row.appendChild(bubbleEl);
      row.appendChild(avatarEl);
    } else {
      row.appendChild(avatarEl);
      row.appendChild(bubbleEl);
      row.appendChild(tsEl);
    }

    // Insert before the typing indicator (always last child)
    const typing = document.getElementById('bf-typing');
    msgList.insertBefore(row, typing);

    return bubbleEl;
  }

  /**
   * Insert up to MAX_CARDS product cards after a bot message row.
   * Card data is untrusted: text goes through textContent only, and links /
   * images are used only when they are http(s) URLs.
   *
   * @param {Array<{ name, price, currency, in_stock, url, image_url }>} products
   * @param {HTMLElement} afterEl – the bot message row
   */
  function renderProductCards(products, afterEl) {
    if (!products.length || !afterEl) return;

    const row = document.createElement('div');
    row.classList.add('bf-cards', 'bf-widget');

    for (const product of products.slice(0, MAX_CARDS)) {
      const card = document.createElement('div');
      card.classList.add('bf-card');

      const imageUrl = safeHttpUrl(product.image_url);
      if (imageUrl) {
        const img = document.createElement('img');
        img.classList.add('bf-card-img');
        img.src     = imageUrl;
        img.alt     = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => img.remove());
        card.appendChild(img);
      }

      const name = document.createElement('div');
      name.classList.add('bf-card-name');
      name.textContent = product.name ?? '';
      card.appendChild(name);

      const priceText = formatPrice(product.price, product.currency);
      if (priceText) {
        const price = document.createElement('div');
        price.classList.add('bf-card-price');
        price.textContent = priceText;
        card.appendChild(price);
      }

      if (product.in_stock === false) {
        const badge = document.createElement('span');
        badge.classList.add('bf-card-badge');
        badge.textContent = 'Out of stock';
        card.appendChild(badge);
      }

      const href = safeHttpUrl(product.url);
      if (href) {
        const link = document.createElement('a');
        link.classList.add('bf-card-link');
        link.href        = href;
        link.target      = '_blank';
        link.rel         = 'noopener noreferrer';
        link.textContent = 'View';
        card.appendChild(link);
      }

      row.appendChild(card);
    }

    afterEl.insertAdjacentElement('afterend', row);
  }

  // ─── SSE Streaming ──────────────────────────────────────────────────────────

  /**
   * POST to /chat with stream:true and pipe delta tokens into `targetBubble`.
   *
   * @param {string}      message
   * @param {string|null} sessionId
   * @param {HTMLElement} targetBubble  – bot bubble element to stream into
   * @returns {Promise<string>}         – resolved session_id from server
   */
  async function streamChat(message, sessionId, targetBubble) {
    const response = await fetch(CHAT_URL, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({
        embed_key  : EMBED_KEY,
        message,
        session_id : sessionId,
      }),
    });

    // ── Non-streaming (blocked or error) response ──────────────────────────
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const json = await response.json().catch(() => ({}));
      if (json.blocked) {
        targetBubble.textContent = json.reply ?? 'Sorry, I cannot discuss that topic.';
        return sessionId;
      }
      throw new Error(json.error ?? `Server error ${response.status}`);
    }

    // ── Streaming SSE response ─────────────────────────────────────────────
    const reader  = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let   buffer  = '';
    let   resolvedSessionId = sessionId;

    // Show blinking cursor while streaming
    targetBubble.classList.add('bf-cursor');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete tail

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const raw = trimmed.slice('data:'.length).trim();
        if (raw === '[DONE]') {
          targetBubble.classList.remove('bf-cursor');
          continue;
        }

        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }

        // First event carries session_id
        if (parsed.session_id) {
          resolvedSessionId = parsed.session_id;
          continue;
        }

        // Product cards for catalog matches (sent once, after the text)
        if (Array.isArray(parsed.products)) {
          renderProductCards(parsed.products, targetBubble.parentElement);
          scrollToBottom(targetBubble.closest('#bf-messages'));
          continue;
        }

        // Delta tokens
        if (parsed.delta) {
          // Append text node — avoids innerHTML injection risk
          targetBubble.appendChild(document.createTextNode(parsed.delta));
          scrollToBottom(targetBubble.closest('#bf-messages'));
        }
      }
    }

    // Ensure cursor removed even if [DONE] was missing
    targetBubble.classList.remove('bf-cursor');
    return resolvedSessionId;
  }

  // ─── Widget Controller ───────────────────────────────────────────────────────

  function init() {
    injectStyles();
    const { bubble, panel } = buildWidget();

    const msgList   = document.getElementById('bf-messages');
    const emptyEl   = document.getElementById('bf-empty');
    const typingEl  = document.getElementById('bf-typing');
    const form      = document.getElementById('bf-form');
    const input     = document.getElementById('bf-input');
    const sendBtn   = document.getElementById('bf-send');
    const closeBtn  = document.getElementById('bf-close-btn');
    const badge     = document.getElementById('bf-badge');

    let isOpen      = false;
    let isStreaming = false;

    // ── Open / close panel ───────────────────────────────────────────────────

    function openPanel() {
      isOpen = true;
      panel.classList.add('bf-visible');
      bubble.classList.add('bf-open');
      bubble.setAttribute('aria-label', 'Close chat');
      badge.classList.remove('bf-visible');
      setTimeout(() => input.focus(), 220);
    }

    function closePanel() {
      isOpen = false;
      panel.classList.remove('bf-visible');
      bubble.classList.remove('bf-open');
      bubble.setAttribute('aria-label', 'Open chat');
    }

    function togglePanel() {
      isOpen ? closePanel() : openPanel();
    }

    bubble.addEventListener('click', togglePanel);
    closeBtn.addEventListener('click', closePanel);

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) closePanel();
    });

    // ── Auto-resize textarea ─────────────────────────────────────────────────

    input.addEventListener('input', () => autoResize(input));

    // Submit on Enter (Shift+Enter = newline)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isStreaming) form.requestSubmit();
      }
    });

    // ── Submit handler ───────────────────────────────────────────────────────

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const text = input.value.trim();
      if (!text || isStreaming) return;

      isStreaming         = true;
      sendBtn.disabled    = true;
      input.value         = '';
      input.style.height  = 'auto';

      // Render user message
      appendMessage('user', text, msgList, emptyEl);
      scrollToBottom(msgList);

      // Show typing indicator
      typingEl.classList.add('bf-visible');
      scrollToBottom(msgList);

      // Create empty bot bubble for streaming
      const botBubble = appendMessage('bot', '', msgList, emptyEl);

      // Hide typing once streaming starts (bubble is visible)
      typingEl.classList.remove('bf-visible');
      scrollToBottom(msgList);

      let currentSessionId = getSessionId();

      try {
        const nextSessionId = await streamChat(text, currentSessionId, botBubble);
        if (nextSessionId && nextSessionId !== currentSessionId) {
          setSessionId(nextSessionId);
        }
      } catch (err) {
        console.error('[BotForge] Chat error:', err);
        botBubble.textContent =
          'Sorry, something went wrong. Please try again in a moment.';
        botBubble.style.color = '#f87171';
      } finally {
        typingEl.classList.remove('bf-visible');
        isStreaming      = false;
        sendBtn.disabled = false;
        input.focus();
        scrollToBottom(msgList);
      }
    });

    // ── Notification badge on hidden panel ───────────────────────────────────
    // (Uncomment and call showBadge() to trigger e.g. from a proactive greeting)
    // function showBadge() {
    //   if (!isOpen) badge.classList.add('bf-visible');
    // }
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
