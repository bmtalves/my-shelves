# My Shelves

A catalogue of the physical books you own. Books are shown as spines on the shelves where they live, or as a list with covers.

- **Scan a barcode** with the phone camera (or from a photo) to add a book by its ISBN.
- **Find books online** by title, author or ISBN in [Open Library](https://openlibrary.org) and [Google Books](https://books.google.com).
- Track reading status, rating, notes and who you lent a book to.
- **Export** a backup (`.json`) or a spreadsheet (`.csv`), and **import** a backup on another device.
- Installable on a phone ("Add to Home Screen") and works offline, apart from online search.

## Where your data lives

Books are stored in the browser (`localStorage`) on each device. Nothing is sent to a server except the search terms and ISBNs you look up. Use Export/Import to move or back up your library.

## Google Books key (optional)

Without a key, Google Books' shared free quota is often used up and only Open Library results appear. Add your own free key under **Google Books key** at the bottom of the page.

## Releasing a change

Bump the `?v=` number on `styles.css` and `app.js` in `index.html` (and the same names in `SHELL` in `sw.js`), so phones and browsers load the new files instead of a cached copy.

## Running it

It's a static site with no build step. Serve the folder over HTTPS (for example GitHub Pages) — the camera only works on `https://` or `localhost`.

```
python -m http.server 8765
```
