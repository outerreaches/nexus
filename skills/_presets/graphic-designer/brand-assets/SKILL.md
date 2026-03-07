---
name: brand-assets
description: Generate logos, icons, banners, and brand identity assets through a raster-to-vector pipeline.
triggers: logo, icon, favicon, banner, brand, brand assets, app icon, social banner, brand identity, create logo
---

# Brand Asset Pipeline

Use this skill to create brand identity assets: logos, app icons, favicons, social media banners, and other visual identity elements.

## Tools Required

- `image_generate` — create initial raster concepts
- `image_analyze` — evaluate concepts for quality and clarity
- `image_edit` — refine and iterate on concepts
- `generate_svg` — create vector versions directly from description
- `vectorize` — convert raster concepts to scalable SVG
- `write_to_blackboard` — store final assets with metadata
- `shell_exec` — resize/export variants (requires orchestrator, not graphic-designer)

## Workflow

### Step 1: Define the Brief

Before generating, clarify:
- **Brand name** and optional tagline.
- **Asset types needed**: logo, icon, favicon, banner, etc.
- **Style direction**: minimal, bold, playful, corporate, vintage, tech, organic.
- **Color preferences**: specific hex values or general palette (warm, cool, monochrome).
- **Usage context**: app store icon, website header, social media profile, print.
- **Dimensions**: see size reference table below.

### Step 2: Generate Concepts

**For icons and logos** — start with `generate_svg` for clean vector output:
```
generate_svg(instructions: "Minimalist logo mark for '[BRAND]'. Abstract geometric shape
representing [CONCEPT]. Single color #2563EB on transparent background.
Simple, recognizable at small sizes, no text, clean lines, balanced composition.")
```

**For photorealistic or complex imagery** — use `image_generate`:
```
image_generate(prompt: "Professional logo for '[BRAND]': [DESCRIPTION].
Clean background, centered composition, high contrast, suitable for both
light and dark backgrounds. Style: [STYLE].", sizeHint: "2K")
```

Generate 2-3 concept variants with different approaches:
- Variant A: icon/symbol mark (no text)
- Variant B: wordmark (stylized text)
- Variant C: combination mark (icon + text)

### Step 3: Evaluate Concepts

Use `image_analyze` on each variant:
```
"Evaluate this logo concept for: 1) Clarity at small sizes (16x16 to 512x512),
2) Color contrast and readability, 3) Uniqueness and memorability,
4) Suitability for [USAGE CONTEXT]. Rate each criterion 1-5."
```

Select the strongest concept or combine elements from multiple.

### Step 4: Refine

Iterate on the selected concept:
- Use `image_edit` for raster refinements (color adjustment, detail cleanup).
- Use `generate_svg` with a more specific prompt for vector refinements.
- Maximum 3 refinement rounds — diminishing returns beyond that.

### Step 5: Vectorize (if raster-based)

If the final concept was generated as raster (image_generate/image_edit):
```
vectorize(sourceImage: "/data/workspace/brand/concept-final.png",
  guidance: "Clean vector trace of this logo. Preserve shapes and colors.
  Simplify to minimal paths. Remove noise and artifacts.")
```

### Step 6: Export Size Variants

Use `shell_exec` to create sized exports from the final asset.

**From SVG** (best quality):
```bash
for size in 16 32 48 64 128 256 512 1024; do
  cairosvg /data/workspace/brand/logo.svg \
    -o /data/workspace/brand/logo-${size}.png \
    -W $size -H $size
done
```

**From raster** (Pillow resize):
```bash
python3 -c "
from PIL import Image
img = Image.open('/data/workspace/brand/logo-master.png')
for size in [16, 32, 48, 64, 128, 256, 512, 1024]:
    resized = img.resize((size, size), Image.LANCZOS)
    resized.save(f'/data/workspace/brand/logo-{size}.png')
print('Exported all sizes')
"
```

**Favicon .ico** (multi-resolution):
```bash
python3 -c "
from PIL import Image
img = Image.open('/data/workspace/brand/logo-master.png')
sizes = [(16,16), (32,32), (48,48)]
img.save('/data/workspace/brand/favicon.ico', sizes=sizes)
print('Created favicon.ico')
"
```

### Step 7: Deliver

- Write all asset paths to blackboard with metadata (type, dimensions, format).
- Report: concept selected, style summary, files generated.
- Send preview via `telegram_send` if requested.

## Asset Size Reference

| Asset | Dimensions | Format |
|-------|-----------|--------|
| Favicon | 16x16, 32x32, 48x48 | .ico (multi-res) |
| App icon (iOS) | 1024x1024 | PNG (no alpha) |
| App icon (Android) | 512x512 | PNG |
| Social profile | 400x400 | PNG/JPG |
| Twitter/X banner | 1500x500 | PNG/JPG |
| Open Graph image | 1200x630 | PNG/JPG |
| LinkedIn banner | 1584x396 | PNG/JPG |

## Prompt Engineering for Logos

- **Simplicity**: "minimalist, flat design, no gradients, max 3 colors"
- **Scalability**: "recognizable at 16x16 pixels, clean silhouette"
- **Versatility**: "works on both light and dark backgrounds"
- **Avoid**: "no realistic textures, no thin lines, no tiny details, no embedded text smaller than 1/4 of canvas"

## Guardrails

1. Save all assets under `/data/workspace/brand/` with descriptive filenames.
2. Always keep the master/highest-resolution version — never overwrite it with a resize.
3. SVG is preferred for logos and icons — always attempt vectorization.
4. Do not generate more than 5 concept variants (context waste).
5. If vectorize produces poor results, report and deliver the raster version instead.
6. Test readability at small sizes via image_analyze before finalizing.

## Completion Protocol

1. Report: asset types created, file paths, formats, and dimensions.
2. Summarize design choices: color palette (hex values), style, composition.
3. List all generated files with sizes.
4. Note any limitations (e.g., text rendering issues, vectorization quality).
