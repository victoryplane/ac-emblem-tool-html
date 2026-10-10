# PS2 *Armored Core* Emblem Tool · web edition (single HTML file)

> 中文版：**[README.md](README.md)**

Turn almost any image into an **emblem save** that PS2 *Armored Core* accepts and write it into a memory card —
or pull emblems off a card and export them as PNG.
**Zero install**: download `emblem-tool-<version>.html` from
[Releases](https://github.com/victoryplane/ac-emblem-tool-html/releases/latest) (or just use
`web/dist/emblem-tool.html` in this repo) and double-click it. One HTML file, no networking, nothing uploaded;
the interface comes in **Chinese / English / Japanese / Korean**, switchable at the top right
(it follows your browser language unless you pick one, and remembers your pick).

> **Verified so far**: reading (10 real samples + cross-validation against the official `acet.exe`) · writing and
> creating slots (non-LR and LR, tested in-game) · round-trip fidelity.
> **Not verified yet**: creating a new `E##` save folder · real samples for AC3 / AC2 / AC2AA / NB · whether the
> game validates the 9-byte per-game constant · PS1 (this tool does not do PS1).
> ⇒ So the page opens with a notice you have to dismiss: **back up your memory card yourself**, and
> **fully exit PCSX2 before writing**.

*(Button labels below are the English ones. The UI follows your browser language, so a Japanese browser shows
Japanese labels — the buttons sit in the same places.)*

## How to use

1. Exit PCSX2, and back up `memcards\*.ps2`.
2. Double-click `emblem-tool.html` → click **Choose memory card** in the top bar. The picker opens in
   **Documents**; if you have already clicked **Choose PCSX2 folder** once, it opens straight in `PCSX2\memcards`.
   * Chrome / Edge can hold a write handle ⇒ saving **overwrites the card in place**;
   * other browsers fall back to **downloading** a modified card — exit PCSX2 and copy it back into `memcards\`.
3. Drag an image into the top-left cell (or click **Choose / paste image**, or press Ctrl+V) ⇒ it goes straight
   into **crop mode**: drag / scroll to put the part you want inside the white box, and adjust the box edge length
   with the slider / input box (**1 source pixel** steps), then click **Apply crop**.
4. Pick the game → click the slot you want (the 8 cells are the slots **of the selected game**; each cell shows its
   slot number plus a thumbnail) → click **Write to selected slot**.
   ★ **The first write to a card pops the browser's file-permission prompt — click Allow.** Browsers only allow
   that request in the very moment you click, which is why it shows up here. You may deny it as well: the tool then
   falls back to **downloading** a modified card.
5. The tool writes into an in-memory copy → **reads it back, compares byte for byte, re-runs the 18-segment
   checksums and the ECC check** → only if all of that passes does it show a confirmation dialog (naming the file
   it will overwrite) → overwrite.

Three more buttons: **Export PNG** saves the selected slot as a PNG · **Delete slot** clears a slot (same
confirm → overwrite → read-back path) · **Save card as** saves the current card under another name.

> ⚠ **"This card has no directory for that game" is refused**: for non-LR games every slot is a complete save
> directory (an emblem plus `icon.sys` and icon files), and creating just the directory would produce something the
> game rejects. Fix: **save an emblem into that slot in the game first**, then come back.
> The full reason appears only in the line **above** the write button (hover it for the mechanics) — nothing was
> written, not a single byte.

## Supported games

| Game | Directory on the card | Status |
|---|---|---|
| Silent Line (US / JP) | `BASLUS-20644E02` / `BISLPS-25169E##` | ✅ real samples + verified in-game |
| Nexus | `BISLPS-25338E##` | ✅ same |
| Last Raven | `BISLPS-25462EMB\data0..7` | ✅ same (including creating a slot, verified in-game) |
| AC3 · AC2 · AC2AA · Nine Breaker | `<game ID>E##` | ⚠ same rule, but **no real samples** ⇒ the UI marks them "unverified" |
| Custom | type the game ID yourself (e.g. `BASLUS-20435`) | fallback for anything not listed |

## Safety notes

* **The tool does not back up for you** (the upstream C++ tool has written a `.backup` file since v1.0.1; this
  web edition does not): copy `memcards\*.ps2` somewhere else yourself before you start.
* **Fully exit PCSX2 before writing** — it keeps its own copy of the card and writes it back on exit, which would
  overwrite whatever you wrote here.
* Your original card is **read-only throughout** (all edits happen on an in-memory copy); every write is preceded
  by a confirmation dialog naming the file it will overwrite.
* If the card changed on disk after the tool read it (usually PCSX2), the tool **refuses to write or delete** —
  not a single byte is touched. Follow the on-screen steps: exit PCSX2, then pick the card again.

## What's in this repo

| Directory | What it is |
|---|---|
| `web/` | ★ The tool itself: `dist/emblem-tool.html` (the deliverable, double-click to run) · `src/core/` format & image core · `src/ui/` interface · `test/` four test suites · `check.mjs` one-command checks · `SPEC.md` / `PORT-NOTES.md` (technical contract & implementation notes) |
| `docs/` | Reverse-engineering notes: save format, image pipeline, memory cards & save handling, known limits, sources & checksums |
| `tools/` | Python cross-check layer (`acet_format.py` / `prepare_image.py` / `selftest.py`) |
| `testdata/` | Test samples: synthetic ones + 10 real emblem saves |
| `_selftest/` | Self-check reports + the real-save regression check |

To build it yourself, run the checks, or read why the UI works the way it does, see `web/README.md`
(development notes, written in Chinese).

## License & credits

Released under **MIT**, copyright line `Copyright (c) 2026 victoryplane` (see `LICENSE`).
It builds on reading and cross-validating the upstream [mparley/ac-emblem-tool](https://github.com/mparley/ac-emblem-tool)
(MIT, © 2021 Marcellus Parley); this repository **no longer redistributes** the upstream source or binaries.
The third-party real saves under `testdata/real/` come from
[bucanero/apollo-saves](https://github.com/bucanero/apollo-saves) and are used for local testing only.
