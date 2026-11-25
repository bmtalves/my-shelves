# My Shelves

A catalogue of the physical books you own. Books are shown as spines on the shelves where they live, or as a list with covers.

- **Scan a barcode** with the phone camera (or from a photo) to add a book by its ISBN.
- **Find books online** by title, author or ISBN in [Open Library](https://openlibrary.org), [Google Books](https://books.google.com) and the [National Library of Norway](https://www.nb.no). Portuguese ISBNs also use an index of the National Library of Portugal's records.
- Track reading status, rating, notes and who you lent a book to.
- **Export** a backup (`.json`) or a spreadsheet (`.csv`), and **import** a backup on another device.
- Installable on a phone ("Add to Home Screen") and works offline, apart from online search.

## Where your data lives

Books are stored in the browser (`localStorage`) on each device. Nothing is sent to a server except the search terms and ISBNs you look up. Use Export/Import to move or back up your library.

## Portuguese ISBN index

Portuguese books (ISBNs starting 978-972 or 978-989) are looked up in `pt-isbn/`, an index built from the [Portuguese National Bibliography](https://opendata.bnportugal.gov.pt/oai-pmh.htm) published by the National Library of Portugal under CC0. The library's own catalogue can't be queried from a website, so the index is downloaded and stored here.

To refresh it with books added since the last run:

```
python tools/build_pt_index.py all
```

The first run downloads everything (1–2 hours); later runs only fetch new and changed records. Downloaded data is kept in `.cache/pt/`, which isn't committed.

## Google Books key (optional)

Without a key, Google Books' shared free quota is often used up and only Open Library results appear. Add your own free key under **Google Books key** at the bottom of the page.

## Releasing a change

Bump the `?v=` number on `styles.css` and `app.js` in `index.html` (and the same names in `SHELL` in `sw.js`), so phones and browsers load the new files instead of a cached copy.

## Running it

It's a static site with no build step. Serve the folder over HTTPS (for example GitHub Pages) — the camera only works on `https://` or `localhost`.

```
python -m http.server 8765
```
