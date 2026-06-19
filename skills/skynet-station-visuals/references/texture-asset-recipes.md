# Texture And Asset Recipes

Use this before editing station textures, sprite sheets, decals, icons, or generated image assets.

## Storage Rules

- Put station bitmaps under `frontend/assets/` in a named subfolder such as `frontend/assets/station/`, `frontend/assets/textures/`, or the existing sprite/furniture folders.
- Add or update a manifest when multiple related assets are loaded dynamically.
- Keep source/provenance notes in the commit message or final response.
- Never commit API keys or generated-provider credentials.
- Do not add huge unoptimized source images to the app bundle unless the runtime uses them.

## Procedural Canvas Texture Ideas

Floor/deck:

- 2x2 or 3x3 panel cadence, subtle tile tone variance, rivets at seam intersections.
- Access hatches, vents, scratch lines, oil stains, worn pathing around desk/conveyor/doors.
- Room-specific tiny stencils, but avoid turning rooms into unrelated color blocks.

Walls/hull:

- Layered hull shell, exterior struts, rivets, panel seams, portholes, antennae, engine glow.
- Wall face ribs and trim bands that reinforce the tilted top-down read.
- Door threshold tracks and light spill to make rooms feel connected.

Props:

- Workbench: monitor glow, keyboard pixels, tool drawers, live status LEDs.
- Connector portal: status ring, server color, pulse on `mcp__*` tool calls.
- Conveyor: belt ribs, rollers, moving highlights, queue jam crates.
- Memory gauge: segmented core, compaction sweep, readable unknown state.
- Agent home corner: small owned decor that the agent placed or prefers.

Agent:

- Preserve foot anchoring and direction reads.
- Add blink/idle/working/sit/look-up states only if the manifest and draw code support them.
- Use accent color primarily for eyes/visor/status detail, not the entire body.

## Generated Bitmap Prompts

Use generated images when a hand-authored bitmap would materially improve a high-value surface. Keep prompts concise and output-specific.

Station trim sheet:

```text
Top-down pixel-art sci-fi station trim sheet, industrial orbital office, dark graphite metal, amber and cyan status lights, panel seams, rivets, vents, hazard marks, clean readable 12px tile style, transparent background.
```

Agent sprite reference:

```text
Small top-down pixel-art AI station worker in a white compact space suit, glowing cyan visor eyes, readable north south east west poses, working at a console, sitting, idle blink, crisp game sprite sheet style.
```

Workbench prop:

```text
Pixel-art sci-fi workbench for a top-down AI station, tiny monitor glow, keyboard, cable bundle, status LEDs, dark metal, 2 tile wide, transparent background, readable at small size.
```

Station wall/floor material reference:

```text
Stylized sci-fi station floor material, graphite metal deck panels, subtle grime, hatches, vents, rivets, amber safety striping, clean readable game texture, not photorealistic, tileable feel.
```

## Integration Checklist

- Confirm image dimensions and scale match the canvas tile system.
- Check `imageSmoothingEnabled` behavior.
- Update manifests and loaders.
- Verify missing asset fallback does not blank the station.
- Capture desktop and mobile screenshots after integration.
- Confirm bundle impact is acceptable.
