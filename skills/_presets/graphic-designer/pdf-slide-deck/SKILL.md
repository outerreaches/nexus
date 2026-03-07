---
name: pdf-slide-deck
description: Generate presentation slide decks as PDF by producing individual slide images and assembling them.
triggers: slides, slide deck, presentation, pdf slides, pdf deck, make a deck, create slides
---

# PDF Slide Deck Generation

Use this skill to create visual presentation slide decks delivered as a single PDF file.

## Strategy

Each slide is generated as an individual image (`image_generate`) or SVG (`generate_svg`), then assembled into a PDF using a Python script via `shell_exec`. The orchestrator drives the pipeline directly — do not delegate the full workflow to graphic-designer (it lacks shell access for assembly).

## Preflight

1. Verify Python and img2pdf are available:
   ```
   python3 -c "import img2pdf" 2>/dev/null || pip3 install --user img2pdf
   ```
   Fallback if pip is restricted: use Pillow (`pip3 install --user Pillow`) with the save-as-PDF method.
2. Create a working directory for slide assets:
   ```
   mkdir -p /data/workspace/slides/<deck-name>
   ```

## Workflow

### Step 1: Plan the Deck

Before generating anything, plan the full deck:
- Determine slide count, titles, and key content per slide.
- Choose a consistent visual style (color palette, font style, mood).
- Decide dimensions: landscape 1792x1024 is standard for presentations.

### Step 2: Generate Slides

Generate each slide as a separate image using `image_generate`:
- Use a detailed prompt for each slide that specifies:
  - Slide number, title text, and bullet points or content to render.
  - Visual style keywords (consistent across all slides).
  - Layout guidance (title position, content area, margins).
  - Text: "large readable text", "white text on dark background", etc.
- Save each slide to the working directory with ordered filenames:
  - `slide-01-title.png`, `slide-02-overview.png`, etc.
- Use `sizeHint: "2K"` or `"4K"` for crisp output.

For diagram-heavy slides, use `generate_svg` instead, then convert:
```
generate_svg → save as .svg → rsvg-convert or cairosvg to PNG
```

### Step 3: Review Slides (optional)

Use `image_analyze` on each generated slide to verify:
- Text is readable and correctly rendered.
- Layout matches the intended design.
- No artifacts or cut-off content.
Re-generate any slide that fails review.

### Step 4: Assemble PDF

Assemble all slide images into a single PDF:
```bash
python3 -c "
import img2pdf, glob, os
imgs = sorted(glob.glob('/data/workspace/slides/<deck-name>/slide-*.png'))
if not imgs:
    raise SystemExit('No slide images found')
with open('/data/workspace/slides/<deck-name>/deck.pdf', 'wb') as f:
    f.write(img2pdf.convert(imgs))
print(f'Created PDF with {len(imgs)} slides')
"
```

Pillow fallback (no img2pdf):
```bash
python3 -c "
from PIL import Image
import glob
imgs = sorted(glob.glob('/data/workspace/slides/<deck-name>/slide-*.png'))
if not imgs:
    raise SystemExit('No slide images found')
frames = [Image.open(f).convert('RGB') for f in imgs]
frames[0].save('/data/workspace/slides/<deck-name>/deck.pdf', save_all=True, append_images=frames[1:])
print(f'Created PDF with {len(frames)} slides')
"
```

### Step 5: Deliver

- Report the PDF path and slide count.
- Optionally send via `telegram_send` if requested.
- Write a blackboard entry with the PDF path and deck summary.

## Prompt Engineering Tips

For consistent multi-slide decks:
- Include a style anchor in every prompt: "modern dark presentation slide, clean layout, sans-serif font, brand blue #2563EB accents".
- Specify text content explicitly — image models render text better with exact wording.
- Use "slide N of M" framing to help the model understand context.
- For text-heavy slides, prefer fewer words with larger font — image models struggle with dense text.

## Guardrails

1. Always use absolute paths under `/data/workspace/`.
2. Do not generate more than 20 slides per deck (context and quality degrade).
3. Verify each slide image exists before assembly.
4. If image generation fails for a slide, report which slide and retry once before skipping.
5. Clean up temporary files after successful PDF assembly only if explicitly asked.

## Completion Protocol

1. Report: deck title, slide count, PDF path, total file size.
2. List any slides that failed generation or review.
3. Summarize the visual style used.
