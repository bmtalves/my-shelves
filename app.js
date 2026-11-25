"use strict";
/* My Shelves — a catalogue of the physical books you own.
   Books live in localStorage on this device; details come from Open Library, Google Books and the National Library of Norway. */

const STATUS = { unread: "To read", reading: "Reading", read: "Read" };
const STORE_KEY = "myshelves.books.v1";
const FIELDS = ["title", "author", "location", "genre", "status", "year", "pages", "isbn", "publisher", "cover", "lentTo", "notes", "rating"];
const state = { books: [], q: "", filter: "all", sort: "author", view: "shelf", expanded: new Set() };
const $ = (s, root = document) => root.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- Storage ---------- */
function loadBooks() {
  try { const raw = localStorage.getItem(STORE_KEY); const arr = raw ? JSON.parse(raw) : []; return Array.isArray(arr) ? arr.filter((b) => b && b.id && b.title) : []; }
  catch (e) { notice("Your saved books couldn't be read from this browser."); return []; }
}
function saveBooks() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.books)); scheduleBackup(); return true; }
  catch (e) { toast("Couldn't save: this browser's storage is full or blocked."); return false; }
}
function newId() { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }
function prefs(k, v) { try { if (v === undefined) return localStorage.getItem("myshelves." + k); localStorage.setItem("myshelves." + k, v); } catch (e) { return null; } }

/* ---------- Small helpers ---------- */
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function spineColor(b) { return `var(--s${(hash((b.title || "") + (b.author || "")) % 8) + 1})`; }
function lastName(a) { const p = String(a || "").split(",")[0].trim().split(/\s+/); return (p[p.length - 1] || "").toLowerCase(); }
function stars(n) { n = Number(n) || 0; return n ? "★".repeat(n) + "☆".repeat(5 - n) : ""; }
function initials(t) { return String(t || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase(); }
function safeUrl(u) { return /^https:\/\//.test(String(u || "")) ? String(u) : ""; }
function coverHtml(b, cls = "cover") {
  const u = safeUrl(b.cover);
  return u ? `<img class="${cls}" src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-initials="${esc(initials(b.title))}" data-bg="${spineColor(b)}">`
    : `<span class="${cls}" style="background:${spineColor(b)}">${esc(initials(b.title))}</span>`;
}
/* A cover that fails to load (or is a 1×1 placeholder) becomes a coloured block with initials. */
function coverFallback(img) {
  const s = document.createElement("span"); s.className = img.className; s.textContent = img.dataset.initials || "?"; s.style.background = img.dataset.bg || "var(--s8)"; img.replaceWith(s);
}
document.addEventListener("error", (e) => { if (e.target instanceof HTMLImageElement && e.target.classList.contains("cover")) coverFallback(e.target); }, true);
document.addEventListener("load", (e) => { const t = e.target; if (t instanceof HTMLImageElement && t.classList.contains("cover") && t.naturalWidth < 5) coverFallback(t); }, true);
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600); }
function notice(msg) { const n = $("#notice"); n.textContent = msg || ""; n.hidden = !msg; }

/* ---------- ISBN ---------- */
function isbn13Valid(d) { if (!/^\d{13}$/.test(d)) return false; let s = 0; for (let i = 0; i < 12; i++) s += Number(d[i]) * (i % 2 ? 3 : 1); return (10 - (s % 10)) % 10 === Number(d[12]); }
function isbn10Valid(d) { if (!/^\d{9}[\dX]$/.test(d)) return false; let s = 0; for (let i = 0; i < 10; i++) s += (d[i] === "X" ? 10 : Number(d[i])) * (10 - i); return s % 11 === 0; }
function isbn10to13(d) { const b = "978" + d.slice(0, 9); let s = 0; for (let i = 0; i < 12; i++) s += Number(b[i]) * (i % 2 ? 3 : 1); return b + ((10 - (s % 10)) % 10); }
/** A valid ISBN-13 for any ISBN-10/13 spelling, else null. */
function normIsbn(raw) {
  const d = String(raw || "").toUpperCase().replace(/[^0-9X]/g, "");
  if (d.length === 13 && /^97[89]/.test(d) && isbn13Valid(d)) return d;
  if (d.length === 10 && isbn10Valid(d)) return isbn10to13(d);
  return null;
}
function prettyIsbn(d) { return d && d.length === 13 ? `${d.slice(0, 3)}-${d.slice(3, 12)}-${d.slice(12)}` : d || ""; }

/* ---------- Online book databases ---------- */
async function fetchJson(url, signal, ms = 9000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  const onAbort = () => ctl.abort(); signal?.addEventListener("abort", onAbort);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
  finally { clearTimeout(t); signal?.removeEventListener("abort", onAbort); }
}
function year(s) { return (String(s || "").match(/\d{4}/) || [""])[0]; }
const GENRES = ["Science fiction", "Fantasy", "Mystery", "Crime", "Thriller", "Horror", "Romance", "Historical fiction", "Poetry", "Drama", "Biography", "Autobiography", "Memoir", "History", "Philosophy", "Psychology", "Science", "Mathematics", "Economics", "Politics", "Religion", "Art", "Music", "Travel", "Cooking", "Cookbook", "Self-help", "Business", "Children's fiction", "Juvenile fiction", "Young adult fiction", "Comics", "Graphic novels", "Classics", "Essays", "Fiction", "Nonfiction"];
function tidyGenre(list) {
  const names = (list || []).map((x) => String(x || "").trim()).filter(Boolean);
  // Prefer a familiar English genre name when the subject list contains one.
  for (const g of GENRES) if (names.some((n) => n.toLowerCase() === g.toLowerCase() || n.toLowerCase().startsWith(g.toLowerCase() + " /") || n.toLowerCase().startsWith(g.toLowerCase() + ","))) return g;
  const g = (list || []).map((x) => String(x || "").split(/\s*[\/,]\s*/)[0].trim()).find((x) => x && x.length <= 32 && !/^(general|accessible book|protected daisy|in library|large type books)$/i.test(x));
  return g ? g[0].toUpperCase() + g.slice(1) : "";
}
function olIsbn(isbn, signal) {
  return fetchJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, signal).then((j) => {
    const d = j && j["ISBN:" + isbn]; if (!d || !d.title) return null;
    return { title: d.title, author: (d.authors || []).map((a) => a.name).join(", "), year: year(d.publish_date), pages: d.number_of_pages || "", genre: tidyGenre((d.subjects || []).map((s) => s.name)), publisher: (d.publishers || []).map((p) => p.name).join(", "), cover: safeUrl(d.cover && (d.cover.medium || d.cover.large || d.cover.small)), isbn, source: "Open Library" };
  });
}
function gbItem(it) {
  const v = (it && it.volumeInfo) || {}; const ids = v.industryIdentifiers || [];
  const raw = (ids.find((x) => x.type === "ISBN_13") || ids.find((x) => x.type === "ISBN_10") || {}).identifier;
  const img = v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
  return { title: v.title || "", author: (v.authors || []).join(", "), year: year(v.publishedDate), pages: v.pageCount || "", genre: tidyGenre(v.categories), publisher: v.publisher || "", cover: img ? safeUrl(String(img).replace(/^http:/, "https:").replace("&edge=curl", "")) : "", isbn: normIsbn(raw) || "", source: "Google Books" };
}
function gbSearch(q, signal, max = 10) {
  // Without a key, Google's shared free quota is often used up (HTTP 429); a personal key fixes that.
  const key = (prefs("gbKey") || "").trim();
  return fetchJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${max}&printType=books${key ? "&key=" + encodeURIComponent(key) : ""}`, signal).then((j) => (j.items || []).map(gbItem).filter((b) => b.title));
}
function olSearch(q, signal) {
  return fetchJson(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=10&fields=title,author_name,first_publish_year,number_of_pages_median,isbn,cover_i,subject,publisher`, signal).then((j) => (j.docs || []).map((d) => ({
    title: d.title || "", author: (d.author_name || []).slice(0, 3).join(", "), year: d.first_publish_year ? String(d.first_publish_year) : "", pages: d.number_of_pages_median || "",
    genre: tidyGenre(d.subject), publisher: (d.publisher || [])[0] || "", cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : "",
    isbn: ((d.isbn || []).map(normIsbn).find(Boolean)) || "", source: "Open Library",
  })).filter((b) => b.title));
}
/* National Library of Norway (Nasjonalbiblioteket): legal-deposit catalogue of nearly every book published in Norway. */
function nbName(n) { const [last, first] = String(n || "").split(/,\s*/); return first ? `${first} ${last}` : String(n || "").trim(); }
function nbTitle(m) {
  const alt = (m.titleInfos || []).find((t) => t.type === "alternative" && t.title);
  const t = String(m.title || (alt && alt.title) || "").replace(/^\[|\]$/g, "");
  return t.split(" : ")[0].replace(/\s*[\/:;]\s*$/, "").trim();
}
function nbItem(it) {
  const m = (it && it.metadata) || {}; const l = (it && it._links) || {}; const oi = m.originInfo || {}; const ids = m.identifiers || {};
  const isbn = [...(ids.isbn13 || []), ...(ids.isbn10 || []), ...(ids.isbns || [])].map(normIsbn).find(Boolean) || "";
  const s = m.subject || {};
  return {
    title: nbTitle(m), author: nbName((m.creators || [])[0]), year: year(oi.issued), pages: m.pageCount > 0 ? m.pageCount : "",
    genre: tidyGenre([...(s.genres || []), ...(s.topics || [])]), publisher: oi.publisher || "",
    cover: safeUrl(l.thumbnail_large && l.thumbnail_large.href), isbn, source: "National Library of Norway",
  };
}
function nbIsbn(isbn, signal) {
  return fetchJson(`https://api.nb.no/catalog/v1/items?q=isbn:${isbn}&size=1`, signal).then((j) => {
    const it = j && j._embedded && (j._embedded.items || [])[0]; if (!it) return null;
    const b = nbItem(it); return b.title ? { ...b, isbn } : null;
  });
}
function nbSearch(q, signal) {
  return fetchJson(`https://api.nb.no/catalog/v1/items?q=${encodeURIComponent(q)}&filter=${encodeURIComponent("mediatype:bøker")}&size=10`, signal)
    .then((j) => ((j && j._embedded && j._embedded.items) || []).map(nbItem).filter((b) => b.title));
}

/** Look up one ISBN in every database and merge what they know. Null when none has it. */
async function lookupIsbn(isbn, signal) {
  const names = ["ol", "nb", "gb"];
  const res = await Promise.allSettled([olIsbn(isbn, signal), nbIsbn(isbn, signal), gbSearch("isbn:" + isbn, signal, 1).then((r) => r[0] || null)]);
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  const got = Object.fromEntries(names.map((n, i) => [n, res[i].status === "fulfilled" ? res[i].value : null]));
  // Norwegian ISBNs (978-82) are best described by the National Library; others by Open Library.
  const order = isbn.startsWith("97882") ? ["nb", "ol", "gb"] : ["ol", "gb", "nb"];
  const found = order.map((n) => got[n]).filter(Boolean);
  if (!found.length) { if (res.every((r) => r.status === "rejected")) throw new Error("offline"); return null; }
  const base = { ...found[0] };
  for (const other of found.slice(1)) for (const k of ["author", "year", "pages", "genre", "publisher", "cover"]) if (!base[k] && other[k]) base[k] = other[k];
  base.source = found.map((b) => b.source).join(" + ");
  base.isbn = isbn;
  return base;
}
/** Free-text search (title, author, or ISBN) across every database. */
async function searchOnline(q, signal) {
  const isbn = normIsbn(q);
  if (isbn) { const r = await lookupIsbn(isbn, signal); return r ? [r] : []; }
  const res = await Promise.allSettled([gbSearch(q, signal), nbSearch(q, signal), olSearch(q, signal)]);
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  if (res.every((r) => r.status === "rejected")) throw new Error("offline");
  const out = [], seen = new Set();
  const key = (b) => b.isbn || (b.title + "|" + b.author).toLowerCase();
  const lists = res.map((r) => (r.status === "fulfilled" ? r.value : []));
  for (let i = 0; i < 10; i++) for (const l of lists) { const b = l[i]; if (b && !seen.has(key(b))) { seen.add(key(b)); out.push(b); } }
  return out.slice(0, 18);
}

/* ---------- Rendering ---------- */
function filtered() {
  const q = state.q.trim().toLowerCase();
  const qDigits = q.replace(/[\s-]/g, "");
  const qIsbn = normIsbn(qDigits);
  const list = state.books.filter((b) => {
    if (state.filter === "lent" && !b.lentTo) return false;
    if (state.filter in STATUS && b.status !== state.filter) return false;
    if (!q) return true;
    if (/^[0-9x]{4,}$/.test(qDigits) && b.isbn) {
      const bd = String(b.isbn).toLowerCase().replace(/[^0-9x]/g, "");
      if (bd.includes(qDigits) || (qIsbn && normIsbn(bd) === qIsbn)) return true;
    }
    return [b.title, b.author, b.isbn, b.genre, b.location, b.notes, b.lentTo, b.publisher].some((f) => String(f || "").toLowerCase().includes(q));
  });
  const sorts = {
    author: (a, b) => lastName(a.author).localeCompare(lastName(b.author)) || a.title.localeCompare(b.title),
    title: (a, b) => a.title.localeCompare(b.title),
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    year: (a, b) => (Number(a.year) || 9999) - (Number(b.year) || 9999),
    rating: (a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0),
    // Books with no page count go last either way.
    pagesDesc: (a, b) => (Number(b.pages) || -1) - (Number(a.pages) || -1) || a.title.localeCompare(b.title),
    pagesAsc: (a, b) => (Number(a.pages) || Infinity) - (Number(b.pages) || Infinity) || a.title.localeCompare(b.title),
  };
  return list.sort(sorts[state.sort] || sorts.author);
}

function renderStats() {
  const n = state.books.length;
  const pages = state.books.reduce((t, b) => t + (Number(b.pages) || 0), 0);
  const read = state.books.filter((b) => b.status === "read").length;
  const lent = state.books.filter((b) => b.lentTo).length;
  const authors = new Set(state.books.map((b) => (b.author || "").trim().toLowerCase()).filter(Boolean)).size;
  $("#stats").innerHTML = `<span><b>${n}</b> ${n === 1 ? "book" : "books"}</span><span><b>${authors}</b> ${authors === 1 ? "author" : "authors"}</span><span><b>${pages.toLocaleString()}</b> pages</span><span><b>${n ? Math.round((read / n) * 100) : 0}%</b> read</span>${lent ? `<span><b>${lent}</b> lent out</span>` : ""}`;
}

function renderChips() {
  const counts = { all: state.books.length, unread: 0, reading: 0, read: 0, lent: 0 };
  state.books.forEach((b) => { if (counts[b.status] !== undefined) counts[b.status]++; if (b.lentTo) counts.lent++; });
  const defs = [["all", "All"], ["unread", "To read"], ["reading", "Reading"], ["read", "Read"], ["lent", "Lent out"]];
  $("#chips").innerHTML = defs.map(([k, l]) => `<button type="button" class="chip" data-f="${k}" aria-pressed="${state.filter === k}">${l}<span class="n">${counts[k]}</span></button>`).join("");
}

function renderView() {
  const v = $("#view");
  $("#vShelf").setAttribute("aria-pressed", state.view === "shelf");
  $("#vList").setAttribute("aria-pressed", state.view === "list");
  if (!state.books.length) {
    v.innerHTML = `<div class="empty"><h2>No books on the shelves yet</h2><p>Scan the barcode on the back of a book, or search for it by title.</p><div class="row-btns"><button type="button" class="btn" data-act="scan">Scan barcode</button><button type="button" class="btn primary" data-act="add">+ Add a book</button></div></div>`;
    return;
  }
  const list = filtered();
  if (!list.length) { v.innerHTML = `<div class="empty"><h2>No matches</h2><p>None of your books fit that search or filter.</p></div>`; return; }

  if (state.view === "list") {
    v.innerHTML = `<div class="list">${list.map((b) => `
      <button type="button" class="item" data-id="${esc(b.id)}">
        ${coverHtml(b)}
        <span class="main">
          <span class="ttl">${esc(b.title)}</span>
          <span class="meta"><span>${esc(b.author || "Unknown author")}</span>${b.year ? `<span>${esc(b.year)}</span>` : ""}${b.genre ? `<span>${esc(b.genre)}</span>` : ""}${b.location ? `<span>${esc(b.location)}</span>` : ""}</span>
        </span>
        <span class="right">
          <span class="pill ${b.lentTo ? "lent" : esc(b.status)}">${b.lentTo ? "Lent to " + esc(b.lentTo) : STATUS[b.status] || "To read"}</span>
          ${b.rating ? `<span class="stars">${stars(b.rating)}</span>` : ""}
        </span>
      </button>`).join("")}</div>`;
    return;
  }

  const groups = new Map();
  list.forEach((b) => { const k = (b.location || "").trim() || "Unshelved"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); });
  const keys = [...groups.keys()].sort((a, b) => (a === "Unshelved") - (b === "Unshelved") || a.localeCompare(b));
  // Break each location into planks that fit the screen width, like the shelves of a bookcase.
  const avail = Math.max(240, (v.clientWidth || window.innerWidth - 32) - 24);
  const spine = (b) => {
    const p = Number(b.pages) || 300;
    const w = Math.round(Math.max(26, Math.min(64, 18 + p / 14)));
    const h = 150 + (hash(b.title) % 40);
    const surname = String(b.author || "").split(",")[0].trim().split(/\s+/).pop() || "";
    return { w, html: `<button type="button" class="spine ${b.status === "reading" ? "reading" : ""} ${b.lentTo ? "lent" : ""}" data-id="${esc(b.id)}" style="width:${w}px;height:${h}px;background:${spineColor(b)}" title="${esc(b.title)}${b.author ? " — " + esc(b.author) : ""}" aria-label="${esc(b.title)}${b.author ? " by " + esc(b.author) : ""}"><span class="band"></span><span class="t">${esc(b.title)}</span><span class="a">${esc(surname)}</span>${b.status === "read" || b.status === "reading" ? `<span class="dot"></span>` : ""}</button>` };
  };
  const planks = (bs) => {
    const rows = [[]]; let used = 0;
    for (const b of bs) { const s = spine(b); if (used + s.w > avail && rows[rows.length - 1].length) { rows.push([]); used = 0; } rows[rows.length - 1].push(s.html); used += s.w + 3; }
    return rows;
  };
  const MAX_PLANKS = 3;
  const searching = !!state.q.trim();
  v.innerHTML = `<div class="shelves">${keys.map((k) => {
    const bs = groups.get(k);
    const rows = planks(bs);
    // Only fold a shelf away when it would hide at least a whole plank more than one.
    const open = searching || state.expanded.has(k) || rows.length <= MAX_PLANKS + 1;
    const shown = open ? rows : rows.slice(0, MAX_PLANKS);
    const hiddenBooks = rows.slice(shown.length).reduce((n, r) => n + r.length, 0);
    return `<section class="shelf"><h2>${esc(k)} <span class="count">${bs.length} ${bs.length === 1 ? "vol." : "vols."}</span></h2>
      <div class="rack">${shown.map((r) => `<div class="row">${r.join("")}</div>`).join("")}</div>
      ${hiddenBooks ? `<button type="button" class="btn small more" data-shelf="${esc(k)}">Show ${hiddenBooks} more on this shelf</button>`
        : !searching && rows.length > MAX_PLANKS + 1 ? `<button type="button" class="btn small more" data-shelf="${esc(k)}">Show less</button>` : ""}
    </section>`;
  }).join("")}
  <div class="legend"><span><i style="background:var(--fg)"></i>Read</span><span><i style="background:#f1c75b"></i>Reading now</span><span>Faded spine = lent out</span><span>Spine width follows page count</span></div></div>`;
}

function render() { renderStats(); renderChips(); renderView(); }

/* ---------- Modals ---------- */
let modalCleanup = null;
function closeModal() { if (modalCleanup) { const f = modalCleanup; modalCleanup = null; f(); } $("#modalRoot").innerHTML = ""; }
function openModal(html, onClose) {
  closeModal();
  $("#modalRoot").innerHTML = `<div class="overlay" data-close="1"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  modalCleanup = onClose || null;
  const first = $("#modalRoot").querySelector("[autofocus], input:not([type=file]), button"); if (first) first.focus({ preventScroll: true });
}
const modalOpen = () => !!$("#modalRoot").innerHTML;

function showDetail(id) {
  const b = state.books.find((x) => x.id === id); if (!b) return;
  const rows = [["Status", b.lentTo ? `${STATUS[b.status] || "To read"} · lent to ${esc(b.lentTo)}` : esc(STATUS[b.status] || "To read")], ["Shelf", esc(b.location)], ["Genre", esc(b.genre)], ["Published", esc(b.year)], ["Publisher", esc(b.publisher)], ["Pages", esc(b.pages)], ["ISBN", b.isbn ? `<span class="mono">${esc(prettyIsbn(b.isbn))}</span>` : ""], ["Rating", b.rating ? `<span class="stars">${stars(b.rating)}</span>` : ""], ["Notes", esc(b.notes)]].filter((r) => r[1]);
  openModal(`<div class="detail">
    <div class="detail-head">${coverHtml(b)}<div><h2>${esc(b.title)}</h2><div class="by">${esc(b.author || "Unknown author")}</div></div></div>
    <dl class="dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <div class="actions"><button type="button" class="btn danger" data-act="del" data-id="${esc(b.id)}">Delete</button><div class="r"><button type="button" class="btn" data-close="1">Close</button><button type="button" class="btn primary" data-act="edit" data-id="${esc(b.id)}">Edit</button></div></div>
  </div>`);
}

function showDelete(id) {
  const b = state.books.find((x) => x.id === id); if (!b) return;
  openModal(`<div class="detail"><h2>Delete “${esc(b.title)}”?</h2><p>This removes it from your library on this device.</p>
    <div class="actions"><div class="r"><button type="button" class="btn" data-close="1">Keep it</button><button type="button" class="btn danger solid" data-act="confirmDel" data-id="${esc(id)}">Delete</button></div></div></div>`);
}

/* ---------- Add / edit form ---------- */
function setStatus(cls, msg) { const s = $("#onStatus"); if (!s) return; s.className = "status " + cls; s.textContent = msg; s.hidden = !msg; }
function fillForm(found, overwrite) {
  const map = { title: "#f-title", author: "#f-author", genre: "#f-genre", year: "#f-year", pages: "#f-pages", isbn: "#f-isbn", publisher: "#f-publisher" };
  for (const [k, sel] of Object.entries(map)) {
    const el = $(sel); const v = found[k];
    if (!el || v === undefined || v === null || String(v).trim() === "") continue;
    if (overwrite || !el.value.trim()) el.value = k === "isbn" ? normIsbn(v) || v : String(v);
  }
  if (found.cover && (overwrite || !$("#f-cover").value)) $("#f-cover").value = found.cover;
  renderPicked();
}
function renderPicked() {
  const box = $("#picked"); if (!box) return;
  const b = { title: $("#f-title").value, cover: $("#f-cover").value };
  if (!b.cover) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = `${coverHtml(b)}<div><div class="ttl">${esc(b.title || "Untitled")}</div><button type="button" class="btn small" id="clearCover">Remove cover</button></div>`;
}

function showForm(id, opts = {}) {
  const b = id ? state.books.find((x) => x.id === id) : { status: "unread", rating: 0, location: prefs("lastLocation") || "" };
  if (!b) return;
  const locs = [...new Set(state.books.map((x) => (x.location || "").trim()).filter(Boolean))].sort();
  const genres = [...new Set(state.books.map((x) => (x.genre || "").trim()).filter(Boolean))].sort();
  const lookupCtl = { c: null };
  openModal(`<form id="bookForm" class="detail" novalidate>
    <h2>${id ? "Edit book" : opts.isbn ? "Scanned " + esc(prettyIsbn(opts.isbn)) : "Add a book"}</h2>
    ${id ? "" : `<div class="online">
      <span class="lbl">Find it online</span>
      <div class="bar"><input id="onQ" type="search" placeholder="Title, author or ISBN" autocomplete="off" aria-label="Search book databases online"><button type="button" class="btn" id="onGo">Search</button></div>
      <div class="status" id="onStatus" hidden></div>
      <div class="results" id="onResults"></div>
    </div>`}
    <div class="picked" id="picked" hidden></div>
    <input type="hidden" id="f-cover" name="cover" value="${esc(b.cover)}">
    <div class="form">
      <div class="field full"><label for="f-title">Title</label><input id="f-title" name="title" value="${esc(b.title)}"></div>
      <div class="field"><label for="f-author">Author</label><input id="f-author" name="author" value="${esc(b.author)}"></div>
      <div class="field"><label for="f-location">Shelf / location</label><input id="f-location" name="location" list="locs" placeholder="e.g. Living room · Shelf 2" value="${esc(b.location)}"><datalist id="locs">${locs.map((l) => `<option value="${esc(l)}">`).join("")}</datalist></div>
      <div class="field"><label for="f-status">Status</label><select id="f-status" name="status">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${b.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label for="f-genre">Genre</label><input id="f-genre" name="genre" list="genres" value="${esc(b.genre)}"><datalist id="genres">${genres.map((l) => `<option value="${esc(l)}">`).join("")}</datalist></div>
      <div class="field"><label for="f-year">Year published</label><input id="f-year" name="year" inputmode="numeric" value="${esc(b.year)}"></div>
      <div class="field"><label for="f-pages">Pages</label><input id="f-pages" name="pages" inputmode="numeric" value="${esc(b.pages)}"></div>
      <div class="field"><label for="f-isbn">ISBN</label><input id="f-isbn" name="isbn" class="mono" inputmode="numeric" value="${esc(prettyIsbn(b.isbn))}"></div>
      <div class="field"><label for="f-publisher">Publisher</label><input id="f-publisher" name="publisher" value="${esc(b.publisher)}"></div>
      <div class="field"><label for="f-lent">Lent to</label><input id="f-lent" name="lentTo" placeholder="Leave empty if it's at home" value="${esc(b.lentTo)}"></div>
      <div class="field"><label>Rating</label><div class="rating" id="rating" data-v="${Number(b.rating) || 0}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-r="${n}" class="${n <= (Number(b.rating) || 0) ? "on" : ""}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}</div></div>
      <div class="field full"><label for="f-notes">Notes</label><textarea id="f-notes" name="notes">${esc(b.notes)}</textarea></div>
    </div>
    <div class="err" id="formErr" hidden></div>
    <div class="actions">
      <div class="r">
        <button type="button" class="btn" data-close="1">Cancel</button>
        ${id ? "" : `<button type="submit" class="btn" data-next="1">Save &amp; scan next</button>`}
        <button type="submit" class="btn primary">${id ? "Save changes" : "Add to shelf"}</button>
      </div>
    </div>
  </form>`, () => lookupCtl.c?.abort());
  renderPicked();

  const runSearch = async (q) => {
    q = String(q || "").trim(); if (!q) return;
    lookupCtl.c?.abort(); const c = new AbortController(); lookupCtl.c = c;
    const res = $("#onResults"); res.innerHTML = "";
    setStatus("", "Searching Open Library, Google Books and the National Library of Norway…");
    try {
      const found = await searchOnline(q, c.signal);
      if (c.signal.aborted || !$("#bookForm")) return;
      if (!found.length) { setStatus("bad", normIsbn(q) ? "This ISBN isn't in Open Library, Google Books or the National Library of Norway. Search by title instead, or type the details below." : "No books found. Try fewer words, or just the author's surname and a title word."); return; }
      if (found.length === 1 && normIsbn(q)) { fillForm(found[0], true); setStatus("ok", `Found in ${found[0].source}. Check the details, pick a shelf, and save.`); return; }
      setStatus("", `${found.length} results. Pick the edition you own.`);
      res._found = found;
      res.innerHTML = found.map((r, i) => `<button type="button" class="result" data-pick="${i}">${coverHtml(r)}<span><span class="ttl">${esc(r.title)}</span><span class="meta">${esc([r.author, r.year, r.publisher].filter(Boolean).join(" · "))}${r.isbn ? ` · <span class="mono">${esc(r.isbn)}</span>` : ""}</span></span></button>`).join("");
    } catch (e) {
      if (c.signal.aborted || e.name === "AbortError") return;
      setStatus("bad", navigator.onLine === false ? "You're offline. Type the details below, or try again when you're connected." : "The book databases didn't answer. Try again in a moment, or type the details below.");
    }
  };

  const form = $("#bookForm");
  if (!id) {
    $("#onGo").addEventListener("click", () => runSearch($("#onQ").value));
    $("#onQ").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(e.target.value); } });
    $("#onResults").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pick]"); if (!btn) return;
      const r = $("#onResults")._found[Number(btn.dataset.pick)]; if (!r) return;
      const dup = r.isbn && state.books.find((x) => normIsbn(x.isbn) === r.isbn);
      fillForm(r, true); $("#onResults").innerHTML = "";
      setStatus(dup ? "bad" : "ok", dup ? `You already have this edition: “${dup.title}”.` : `Filled in from ${r.source}. Check the details, pick a shelf, and save.`);
    });
  }
  form.addEventListener("click", (e) => { if (e.target.id === "clearCover") { $("#f-cover").value = ""; renderPicked(); } });
  $("#f-title").addEventListener("change", renderPicked);

  if (opts.isbn) { $("#f-isbn").value = prettyIsbn(opts.isbn); $("#onQ").value = opts.isbn; runSearch(opts.isbn); }
  else if (!id) $("#onQ").focus();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const next = e.submitter && e.submitter.dataset.next;
    const fd = new FormData(form); const data = {};
    for (const k of FIELDS) if (k !== "rating") data[k] = String(fd.get(k) || "").trim();
    data.rating = Number($("#rating").dataset.v) || 0;
    const err = $("#formErr");
    if (!data.title) { err.textContent = "Give the book a title, or search for it above."; err.hidden = false; $("#f-title").focus(); return; }
    if (data.pages && !/^\d+$/.test(data.pages)) { err.textContent = "Pages must be a whole number."; err.hidden = false; return; }
    data.pages = data.pages ? Number(data.pages) : "";
    if (data.isbn) data.isbn = normIsbn(data.isbn) || data.isbn.replace(/\s+/g, "");
    data.cover = safeUrl(data.cover);
    if (!STATUS[data.status]) data.status = "unread";
    if (id) {
      const i = state.books.findIndex((x) => x.id === id);
      state.books[i] = { ...state.books[i], ...data, updatedAt: Date.now() };
    } else {
      state.books.push({ id: newId(), ...data, addedAt: Date.now() });
    }
    if (!saveBooks()) return;
    if (data.location) prefs("lastLocation", data.location);
    render(); closeModal();
    toast(id ? "Saved" : `Added “${data.title}”`);
    if (next) startScanner();
  });
}

/* ---------- Barcode scanning ---------- */
let zx = null;
function zxReader() {
  if (zx || !window.ZXing) return zx;
  const Z = window.ZXing; const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  zx = new Z.MultiFormatReader(); zx.setHints(hints);
  return zx;
}
function zxDecode(canvas) {
  const r = zxReader(); if (!r) return null; const Z = window.ZXing;
  try { return r.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)))).getText(); }
  catch (e) { return null; } finally { r.reset && r.reset(); }
}
let nativeDetector;
async function getNativeDetector() {
  if (nativeDetector !== undefined) return nativeDetector;
  nativeDetector = null;
  try { if ("BarcodeDetector" in window) { const f = await BarcodeDetector.getSupportedFormats(); if (f.includes("ean_13")) nativeDetector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a"].filter((x) => f.includes(x)) }); } } catch (e) {}
  return nativeDetector;
}
function drawTo(src, sw, sh, maxSide, rot = 0, crop = null) {
  const cx = crop ? crop.x : 0, cy = crop ? crop.y : 0, cw = crop ? crop.w : sw, ch = crop ? crop.h : sh;
  const k = Math.min(1, maxSide / Math.max(cw, ch)); const w = Math.round(cw * k), h = Math.round(ch * k);
  const c = document.createElement("canvas"); const swap = rot % 180 !== 0; c.width = swap ? h : w; c.height = swap ? w : h;
  const g = c.getContext("2d", { willReadFrequently: true }); g.translate(c.width / 2, c.height / 2); g.rotate((rot * Math.PI) / 180); g.drawImage(src, cx, cy, cw, ch, -w / 2, -h / 2, w, h);
  return c;
}
async function decodeStill(img) {
  const det = await getNativeDetector();
  if (det) { try { const r = await det.detect(img); if (r.length) return r.map((x) => x.rawValue); } catch (e) {} }
  for (const size of [1400, 900, 2200]) for (const rot of [0, 90]) {
    const t = zxDecode(drawTo(img, img.naturalWidth, img.naturalHeight, size, rot)); if (t) return [t];
    await new Promise((r) => setTimeout(r, 0));
  }
  return [];
}

function onIsbnFound(isbn) {
  const dup = state.books.find((b) => normIsbn(b.isbn) === isbn);
  if (dup) { showDetail(dup.id); toast("You already own this one"); return; }
  showForm(null, { isbn });
}

async function startScanner() {
  const canCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
  if (!canCamera) { $("#photoInput").click(); return; }
  let stream = null, stopped = false, timer = 0, lastBad = "";
  const stop = () => { stopped = true; clearTimeout(timer); if (stream) stream.getTracks().forEach((t) => t.stop()); };
  openModal(`<div class="detail">
    <h2>Scan a barcode</h2>
    <div class="cam"><video id="cam" playsinline muted autoplay></video><div class="aim"></div></div>
    <p class="by" id="camMsg">Hold the barcode on the back cover inside the box.</p>
    <div class="actions"><label class="btn" for="photoInput">Use a photo instead</label><div class="r"><button type="button" class="btn" data-act="typeIsbn">Type the ISBN</button><button type="button" class="btn" data-close="1">Cancel</button></div></div>
  </div>`, stop);
  const msg = (t) => { const m = $("#camMsg"); if (m) m.textContent = t; };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    if (stopped) return;
    msg(e && e.name === "NotAllowedError" ? "Camera access was blocked. Allow the camera for this site in your browser settings, or use a photo instead." : "No camera could be opened. Use a photo instead.");
    return;
  }
  if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
  const video = $("#cam"); video.srcObject = stream;
  try { await video.play(); } catch (e) {}
  const det = await getNativeDetector();
  const tick = async () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      let codes = [];
      const vw = video.videoWidth, vh = video.videoHeight;
      if (det) { try { codes = (await det.detect(video)).map((r) => r.rawValue); } catch (e) {} }
      else {
        const crop = { x: Math.round(vw * 0.05), y: Math.round(vh * 0.25), w: Math.round(vw * 0.9), h: Math.round(vh * 0.5) };
        const t = zxDecode(drawTo(video, vw, vh, 1000, 0, crop)); if (t) codes = [t];
      }
      if (stopped) return;
      const isbn = codes.map(normIsbn).find(Boolean);
      if (isbn) { navigator.vibrate && navigator.vibrate(60); closeModal(); onIsbnFound(isbn); return; }
      if (codes[0] && codes[0] !== lastBad) { lastBad = codes[0]; msg(`That barcode (${codes[0]}) isn't an ISBN. Look for the one starting with 978 or 979.`); }
    }
    timer = setTimeout(tick, det ? 150 : 250);
  };
  tick();
}

async function handlePhoto(file) {
  if (!file) return;
  openModal(`<div class="scanbox"><h2>Reading the barcode…</h2><p class="by">Looking for the ISBN on your photo.</p></div>`);
  const url = URL.createObjectURL(file);
  const img = new Image();
  const ok = await new Promise((res) => { img.onload = () => res(true); img.onerror = () => res(false); img.src = url; });
  if (!ok) { URL.revokeObjectURL(url); return photoFailed("That file isn't a photo this browser can open. Try a JPEG or PNG."); }
  const codes = await decodeStill(img);
  if (!modalOpen()) { URL.revokeObjectURL(url); return; }
  const isbn = codes.map(normIsbn).find(Boolean);
  if (isbn) { URL.revokeObjectURL(url); closeModal(); return onIsbnFound(isbn); }
  photoFailed(codes[0] ? `That barcode (${esc(codes[0])}) isn't an ISBN. Books have one starting with 978 or 979, usually on the back cover.` : "No barcode found. Get closer so the bars fill most of the photo, keep it sharp and well lit, and try again.", url);
}
function photoFailed(msg, url) {
  openModal(`<div class="scanbox"><h2>Couldn't read an ISBN</h2>${url ? `<img src="${url}" alt="Your photo">` : ""}<p>${msg}</p>
    <div class="actions"><div class="r"><button type="button" class="btn" data-act="add">Search by title instead</button><label class="btn primary" for="photoInput">Try another photo</label></div></div></div>`, () => url && URL.revokeObjectURL(url));
}

/* ---------- Export / import ---------- */
function download(name, text, type) {
  const blob = new Blob([text], { type }); const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
/* On phones and tablets, open the share sheet (Proton Drive, Files, email…) instead of a plain download. */
const isTouchDevice = () => window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
async function shareOrDownload(name, text, type) {
  if (isTouchDevice() && navigator.share && navigator.canShare) {
    // Some share targets only accept common types, so fall back to text/plain with the same file name.
    for (const t of [type, "text/plain"]) {
      const file = new File([text], name, { type: t });
      if (!navigator.canShare({ files: [file] })) continue;
      try { await navigator.share({ files: [file], title: name }); return "shared"; }
      catch (e) { if (e && e.name === "AbortError") return "cancelled"; break; }
    }
  }
  download(name, text, type);
  return "downloaded";
}
const today = () => new Date().toISOString().slice(0, 10);
const backupText = () => JSON.stringify({ app: "my-shelves", version: 1, exportedAt: new Date().toISOString(), books: state.books }, null, 2);
async function exportJson() {
  if (!state.books.length) return toast("Nothing to export yet");
  const r = await shareOrDownload(`my-shelves-${today()}.json`, backupText(), "application/json");
  if (r === "downloaded") toast("Backup saved to your downloads");
}
async function exportCsv() {
  if (!state.books.length) return toast("Nothing to export yet");
  const cols = ["title", "author", "isbn", "year", "pages", "genre", "publisher", "location", "status", "rating", "lentTo", "notes"];
  const cell = (v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.join(","), ...filtered().map((b) => cols.map((c) => cell(c === "status" ? STATUS[b.status] || b.status : b[c])).join(","))];
  await shareOrDownload(`my-shelves-${today()}.csv`, "﻿" + lines.join("\r\n"), "text/csv");
}

/* ---------- Auto-save to a backup file (Chrome/Edge on a computer) ----------
   The chosen file's handle is kept in IndexedDB; after every change the whole library is rewritten to it.
   Put the file in a synced folder (Proton Drive, OneDrive…) and the cloud copy stays current. */
const autoSave = { supported: "showSaveFilePicker" in window && window.self === window.top, handle: null, state: "off", last: 0, timer: 0, writing: null };
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open("myshelves", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function kv(key, value) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", value === undefined ? "readonly" : "readwrite"); const st = tx.objectStore("kv");
    const r = value === undefined ? st.get(key) : value === null ? st.delete(key) : st.put(value, key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function renderAutoSave() {
  const box = $("#autosave"); if (!box) return;
  if (!autoSave.supported) {
    // Firefox and Safari can't keep writing to a chosen file, and phones have no synced folders to pick from.
    box.hidden = isTouchDevice();
    box.innerHTML = `<span class="lbl">Auto-save backup</span><p>Auto-saving to a file only works in Chrome or Edge on a computer, because this browser doesn't let websites keep writing to a file. Here, use <b>Export backup</b> and save the file into your Proton Drive folder.</p>`;
    return;
  }
  box.hidden = false;
  const name = autoSave.handle ? autoSave.handle.name : "";
  const when = autoSave.last ? new Date(autoSave.last).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const msg = {
    off: "Pick a file inside your Proton Drive folder (or any synced folder) and every change is saved to it automatically.",
    on: `Saving to <b>${esc(name)}</b>${when ? ` · last saved ${when}` : ""}.`,
    paused: `Auto-save to <b>${esc(name)}</b> is paused until you allow it again.`,
    error: `Couldn't write to <b>${esc(name)}</b>. It may have been moved or deleted. Choose the file again.`,
  }[autoSave.state];
  const btns = autoSave.state === "off" ? `<button type="button" class="btn small" data-as="pick">Choose backup file…</button>`
    : autoSave.state === "paused" ? `<button type="button" class="btn small primary" data-as="resume">Resume auto-save</button><button type="button" class="btn small" data-as="stop">Stop</button>`
    : `<button type="button" class="btn small" data-as="pick">Change file…</button><button type="button" class="btn small" data-as="stop">Stop auto-save</button>`;
  box.innerHTML = `<span class="lbl">Auto-save backup</span><p class="${autoSave.state === "error" ? "err" : ""}">${msg}</p><div class="foot-actions">${btns}</div>`;
}
async function writeBackup() {
  if (!autoSave.handle || autoSave.state !== "on") return;
  if (autoSave.writing) { await autoSave.writing; }
  autoSave.writing = (async () => {
    try {
      const w = await autoSave.handle.createWritable();
      await w.write(backupText()); await w.close();
      autoSave.last = Date.now();
    } catch (e) {
      autoSave.state = e && e.name === "NotAllowedError" ? "paused" : "error";
    }
    renderAutoSave();
  })();
  await autoSave.writing; autoSave.writing = null;
}
function scheduleBackup() { if (autoSave.state !== "on") return; clearTimeout(autoSave.timer); autoSave.timer = setTimeout(writeBackup, 800); }
async function pickBackupFile() {
  let handle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName: "my-shelves-backup.json", types: [{ description: "My Shelves backup", accept: { "application/json": [".json"] } }] });
  } catch (e) { if (e && e.name !== "AbortError") toast("Couldn't open the file picker."); return; }
  autoSave.handle = handle; autoSave.state = "on";
  try { await kv("backupHandle", handle); } catch (e) {}
  await writeBackup();
  if (autoSave.state === "on") toast(`Auto-saving to ${handle.name}`);
}
async function resumeAutoSave() {
  if (!autoSave.handle) return;
  let p = "denied";
  try { p = await autoSave.handle.requestPermission({ mode: "readwrite" }); } catch (e) {}
  if (p === "granted") { autoSave.state = "on"; await writeBackup(); } else { autoSave.state = "paused"; renderAutoSave(); }
}
async function stopAutoSave() {
  autoSave.handle = null; autoSave.state = "off"; autoSave.last = 0; clearTimeout(autoSave.timer);
  try { await kv("backupHandle", null); } catch (e) {}
  renderAutoSave(); toast("Auto-save stopped");
}
async function initAutoSave() {
  if (!autoSave.supported) return renderAutoSave();
  try {
    const h = await kv("backupHandle");
    if (h) {
      autoSave.handle = h;
      const p = await h.queryPermission({ mode: "readwrite" });
      autoSave.state = p === "granted" ? "on" : "paused";
    }
  } catch (e) {}
  renderAutoSave();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-as]"); if (!b) return;
  ({ pick: pickBackupFile, resume: resumeAutoSave, stop: stopAutoSave }[b.dataset.as] || (() => {}))();
});
async function importJson(file) {
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { return toast("That file isn't a My Shelves backup (it's not valid JSON)."); }
  const incoming = Array.isArray(data) ? data : data && Array.isArray(data.books) ? data.books : null;
  if (!incoming) return toast("That file isn't a My Shelves backup.");
  const byId = new Set(state.books.map((b) => b.id));
  const byIsbn = new Set(state.books.map((b) => normIsbn(b.isbn)).filter(Boolean));
  let added = 0, skipped = 0;
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object" || !String(raw.title || "").trim()) { skipped++; continue; }
    const b = { id: String(raw.id || newId()), addedAt: Number(raw.addedAt) || Date.now() };
    for (const k of FIELDS) b[k] = raw[k] ?? "";
    b.title = String(b.title).trim(); b.rating = Math.max(0, Math.min(5, Number(b.rating) || 0)); b.cover = safeUrl(b.cover);
    if (!STATUS[b.status]) b.status = "unread";
    const isbn = normIsbn(b.isbn);
    if (byId.has(b.id) || (isbn && byIsbn.has(isbn))) { skipped++; continue; }
    state.books.push(b); byId.add(b.id); if (isbn) byIsbn.add(isbn); added++;
  }
  if (added && !saveBooks()) return;
  render();
  toast(`Imported ${added} ${added === 1 ? "book" : "books"}${skipped ? `, skipped ${skipped} already here` : ""}`);
}

/* ---------- Events ---------- */
document.addEventListener("click", (e) => {
  const t = e.target.closest("button, .overlay");
  if (!t) return;
  if (t.dataset.close && (t.tagName === "BUTTON" || e.target === t)) return closeModal();
  if (t.tagName !== "BUTTON") return;
  if (t.dataset.f) { state.filter = t.dataset.f; return render(); }
  if (t.dataset.shelf !== undefined) {
    const k = t.dataset.shelf; const wasOpen = state.expanded.has(k);
    wasOpen ? state.expanded.delete(k) : state.expanded.add(k); renderView();
    if (wasOpen) { const h = [...document.querySelectorAll(".shelf")].find((s) => s.querySelector("[data-shelf]")?.dataset.shelf === k); h && h.scrollIntoView({ block: "nearest" }); }
    return;
  }
  if (t.dataset.r) { const r = $("#rating"); const n = Number(t.dataset.r) === Number(r.dataset.v) ? 0 : Number(t.dataset.r); r.dataset.v = n; r.querySelectorAll("button").forEach((x) => x.classList.toggle("on", Number(x.dataset.r) <= n)); return; }
  const act = t.dataset.act;
  if (act === "add") return showForm();
  if (act === "scan") return startScanner();
  if (act === "typeIsbn") return showForm();
  if (act === "edit") return showForm(t.dataset.id);
  if (act === "del") return showDelete(t.dataset.id);
  if (act === "confirmDel") { state.books = state.books.filter((b) => b.id !== t.dataset.id); saveBooks(); render(); closeModal(); return toast("Deleted"); }
  if (t.dataset.id && (t.classList.contains("spine") || t.classList.contains("item"))) return showDetail(t.dataset.id);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modalOpen()) closeModal(); });
$("#addBtn").addEventListener("click", () => showForm());
$("#scanBtn").addEventListener("click", () => startScanner());
$("#photoInput").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; handlePhoto(f); });
$("#importInput").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; importJson(f); });
$("#exportJson").addEventListener("click", exportJson);
$("#exportCsv").addEventListener("click", exportCsv);
$("#gbKey").value = prefs("gbKey") || "";
$("#gbKeySave").addEventListener("click", () => { prefs("gbKey", $("#gbKey").value.trim()); toast($("#gbKey").value.trim() ? "Google Books key saved" : "Google Books key removed"); });
$("#q").addEventListener("input", (e) => { state.q = e.target.value; renderView(); });
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; prefs("sort", state.sort); renderView(); });
$("#vShelf").addEventListener("click", () => { state.view = "shelf"; prefs("view", "shelf"); renderView(); });
$("#vList").addEventListener("click", () => { state.view = "list"; prefs("view", "list"); renderView(); });
{ let w = window.innerWidth, t = 0; window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { if (Math.abs(window.innerWidth - w) > 20 && state.view === "shelf" && !modalOpen()) { w = window.innerWidth; renderView(); } }, 200); }); }
window.addEventListener("storage", (e) => { if (e.key === STORE_KEY) { state.books = loadBooks(); render(); } });

/* ---------- Start ---------- */
{ const v = prefs("view"); if (v === "list" || v === "shelf") state.view = v; const s = prefs("sort"); if (s) { state.sort = s; $("#sort").value = s; } }
state.books = loadBooks();
render();
initAutoSave();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
