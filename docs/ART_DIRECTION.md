# Art direction

## Long-term direction

Pine Star's future home is a top-down explorable AI workplace using a Game Boy Advance-era RPG visual language. FireRed may inform private study of readability, proportions, movement, tile grammar, animation timing, and clarity; it is not an asset source or a license.

Planned characteristics include original Pine Star tiles/sprites, spaces representing teams/tools/projects, visible agent activity, handheld-era readability, and clock-based day/night behavior. Technical administration may remain conventional panels.

## Distribution rules

- Ship original Pine Star branding and artwork only.
- Do not ship StarNet logos, identity, excluded artwork, sprites, or non-licensed brand assets.
- Do not ship Pokémon, Nintendo, or other copyrighted commercial-game assets.
- Do not imply affiliation with or endorsement by upstream/game owners.
- Preserve required code/third-party attribution.

Any private reference extraction must be labeled exactly:

> REFERENCE / PLACEHOLDER — DO NOT DISTRIBUTE

`PS-2026-003` implements the first read-only release check: `npm run release:asset-safety` fails when the exact marker or an explicitly blocked reference/placeholder filename appears in a distributable asset root. This does not replace licensing review or approve the currently inventoried upstream assets for Pine Star distribution.
