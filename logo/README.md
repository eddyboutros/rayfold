# Rayfold logo assets

Mark: **Folded R**. 64-unit grid, 13-unit stroke weight, 5-unit crease, all folds at 45 degrees.

## Colours
| Token | Hex | Use |
|---|---|---|
| Fold Teal | #0F6E5A | ink on light |
| Flap Teal | #4EC3A3 | accent flap on light |
| Fold Teal Dark | #5FD3B4 | ink on near-black |
| Flap Teal Dark | #0F8A6F | accent flap on near-black |
| Ink | #12211D | one-colour on light |

## Files
- `rayfold-symbol-*.svg`: symbol alone, 64x64 box with 6 units of built-in clear space.
- `rayfold-lockup-horizontal-*.svg`: symbol + wordmark, gap 0.3x symbol width.
- `rayfold-lockup-stacked-*.svg`: symbol above wordmark, centred.
- `rayfold-favicon.svg` / `-mono.svg`: tighter crop for 16/32px.

Variants: `color` (light bg), `color-dark` (near-black bg), `black`, `white`.

## Minimum sizes
Symbol 16px. Horizontal lockup 96px wide. Stacked lockup 72px wide.

## Clear space
One stroke weight (13 units, = 0.25x the mark) on all four sides.

## Type
Wordmark is Archivo SemiBold, tracking -0.032em. The lockup SVGs reference Archivo by
name — outline the text to paths before shipping to environments without the font.
