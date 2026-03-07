---
name: image-editing
description: Iterative image editing pipeline using vision analysis and generative editing tools.
triggers: edit image, image edit, modify image, change image, inpaint, outpaint, background removal, style transfer, photo edit, retouch
---

# Image Editing Pipeline

Use this skill for iterative image editing tasks: inpainting, outpainting, style transfer, background replacement, color correction, text overlay, object removal, and compositional changes.

## Tools Required

- `image_analyze` — inspect source image, verify edits
- `image_edit` — apply generative edits (inpaint/outpaint/restyle)
- `image_generate` — create replacement elements or full re-generations
- `write_to_blackboard` — store results with metadata
- `vectorize` — convert final result to SVG if scalable output needed

## Workflow

### Step 1: Analyze Source Image

Always start by inspecting the source image with `image_analyze`:
- Identify dimensions, composition, color palette, subject matter.
- Note specific areas or elements that need editing.
- Assess image quality (resolution, artifacts, noise).

Use a targeted analysis prompt:
- "Describe this image in detail: subject, composition, colors, text, background. Note any quality issues."

### Step 2: Plan the Edit

Based on analysis, determine the edit approach:

| Task | Tool | Approach |
|------|------|----------|
| Object removal/replacement | `image_edit` | Describe what to remove and what should replace it |
| Background change | `image_edit` | "Replace the background with..." |
| Style transfer | `image_edit` | "Transform this image to [style] while preserving the subject" |
| Color correction | `image_edit` | "Adjust colors to be warmer/cooler/more saturated..." |
| Add elements | `image_edit` | "Add [element] in [position] of the image" |
| Text overlay | `image_edit` | "Add text '[content]' in [position] with [style]" |
| Full re-imagine | `image_generate` | Generate a new image from scratch with reference to original |
| Raster to vector | `vectorize` | Convert after edits are finalized |

### Step 3: Apply Edit

Call `image_edit` with:
- `sourceImage`: path to the source image or blackboard attachment ID.
- `prompt`: detailed edit instruction. Be specific about what to change AND what to preserve.
- `model`: defaults to `google/gemini-3-pro-image-preview`.
- `outputCount`: generate 2-3 variants for selection when the edit is subjective.
- `saveTo`: save to workspace with descriptive filename (e.g., `edited-bg-removed.png`).

Prompt pattern for best results:
```
"Edit this image: [SPECIFIC CHANGE]. Preserve [WHAT TO KEEP UNCHANGED].
Style: [STYLE CONSTRAINTS]. Output should be [QUALITY/FORMAT NOTES]."
```

### Step 4: Verify Result

Use `image_analyze` on the edited image:
- Confirm the edit was applied correctly.
- Check for artifacts, distortion, or unintended changes.
- Verify preserved elements are intact.

Verification prompt:
- "Compare this edited image against these requirements: [ORIGINAL EDIT REQUEST]. Was the edit applied correctly? Note any artifacts or issues."

### Step 5: Iterate or Finalize

- If the result is unsatisfactory, refine the prompt and re-edit.
- Maximum 3 edit iterations per element — if still failing, report the limitation and try an alternative approach.
- Once satisfied, save the final version with a clear filename.

### Step 6: Deliver

- Write to blackboard with: final image path, edit summary, before/after description.
- Send via `telegram_send` if requested.
- If multiple variants were generated, report all paths and recommend the best one.

## Multi-Step Editing

For complex edits requiring multiple changes:
1. Apply edits sequentially — one change per `image_edit` call.
2. Use the output of each step as the input to the next.
3. Verify after each step, not just at the end.
4. Keep intermediate files (e.g., `step-01-bg-removed.png`, `step-02-color-adjusted.png`).

## Guardrails

1. Always analyze before editing — never edit blind.
2. Save source and intermediate images — never overwrite the original.
3. Use absolute paths under `/data/workspace/` or `/data/nexus/`.
4. If `image_edit` returns an error or unusable result after 2 retries, report the blocker.
5. Do not attempt edits that require pixel-precise positioning — generative models approximate.
6. For text rendering in images, keep text short and large — models struggle with small/dense text.

## Completion Protocol

1. Report: source image, edits applied, final image path.
2. Summarize what changed vs what was preserved.
3. Note any quality limitations or suggested follow-up edits.
