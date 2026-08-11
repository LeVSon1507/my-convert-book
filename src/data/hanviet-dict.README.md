# hanviet-dict.json

Chinese → Vietnamese (Hán-Việt) term dictionary, used by [`src/lib/hanvietDict.ts`](../lib/hanvietDict.ts)
to power the free auto-glossary pre-pass (`enableAutoGlossary` in the translate workspace).

## Source

- Repo: https://github.com/NguyenVi07/zhcn-vi-dic (`addon/dictionaries/dic.dic`)
- That repo packages the dictionary as an NVDA screen-reader add-on. The word data itself
  was compiled by the Vietnamese Chinese-novel "convert" community (Tang Thư Viện and
  related forums); the repo owner (KtGame) adapted the format for NVDA.
- License: GPL-2.0 (per that repo's `LICENSE`).

## Processing

Generated from the upstream `dic.dic` (tab-separated: `chinese\tvietnamese\t0\t0`, UTF-8 with
BOM) with the following rules, ported from that repo's `zhcnViDict.py`:

- Skip blank/comment lines and lines whose Chinese field is bare punctuation.
- `的` and `了` map to `""` (silent); a term ending in `的`/`了` has the trailing
  " đích"/" liễu" (or "đích"/"liễu") stripped from its Vietnamese reading.
- Where the same Chinese key appears on multiple lines, only the **first** Vietnamese
  reading is kept (matches upstream's `vietnameseOptions[0]` lookup behavior).

Result: 294,039 unique keys, keys 1–10 Hán tự long (99.99% are 1–3).

To regenerate: download `dic.dic` from the source repo above and re-run the same rules.
