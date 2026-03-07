---
name: design-system
description: Generate cohesive design systems with color palettes, typography scales, component specs, and style guide assets.
triggers: design system, color palette, style guide, typography, brand colors, color scheme, design tokens, theme, ui kit
---

# Design System Generation

Use this skill to create cohesive visual design systems including color palettes, typography scales, and component specifications. Outputs visual swatches and structured specs.

## Tools Required

- `image_generate` — create visual swatches, sample compositions, and component previews
- `generate_svg` — create scalable color palette cards, typography specimens, and layout grids
- `image_analyze` — verify generated assets for visual coherence
- `write_to_blackboard` — store the design system spec

## Workflow

### Step 1: Gather Requirements

Determine:
- **Brand context**: Industry, mood (corporate, playful, luxury, tech), existing brand colors (if any)
- **Use case**: Web app, mobile app, marketing site, print materials
- **Constraints**: Accessibility requirements (WCAG AA/AAA), dark mode support, existing frameworks (Tailwind, Material, etc.)

### Step 2: Color Palette

Generate a palette with:
- **Primary**: 1 brand color + 5-shade scale (50, 100, 300, 500, 700, 900)
- **Secondary**: 1 accent color + 3-shade scale
- **Neutrals**: Gray scale (50-900) for text, borders, backgrounds
- **Semantic**: Success (green), Warning (amber), Error (red), Info (blue)

For each color, provide:
- Hex value
- HSL value
- WCAG contrast ratio against white and black backgrounds
- Recommended use (headings, body text, buttons, backgrounds, borders)

**Generate a visual swatch card** using `generate_svg`:
```
Create a color palette card showing:
- Row 1: Primary shades (50→900) as labeled rectangles
- Row 2: Secondary shades
- Row 3: Neutral scale
- Row 4: Semantic colors (success, warning, error, info)
Each swatch shows hex code below. White background, clean grid layout.
```

### Step 3: Typography Scale

Define a modular type scale:
- **Scale ratio**: 1.25 (major third) or 1.333 (perfect fourth)
- **Base size**: 16px
- **Levels**: xs (12px), sm (14px), base (16px), lg (18px), xl (20px), 2xl (24px), 3xl (30px), 4xl (36px)
- **Line heights**: Tight (1.25), normal (1.5), relaxed (1.75)
- **Font weights**: Regular (400), Medium (500), Semibold (600), Bold (700)

Recommend font pairings:
- **System fonts**: Inter + system-ui stack (no external deps)
- **Google Fonts**: Suggested heading + body combinations

### Step 4: Spacing & Layout

Define a spacing scale based on a base unit (typically 4px):
- 0, 1 (4px), 2 (8px), 3 (12px), 4 (16px), 5 (20px), 6 (24px), 8 (32px), 10 (40px), 12 (48px), 16 (64px)

Layout tokens:
- Border radius: sm (4px), md (8px), lg (12px), xl (16px), full (9999px)
- Shadows: sm, md, lg, xl
- Breakpoints: sm (640px), md (768px), lg (1024px), xl (1280px)

### Step 5: Component Preview

Generate a sample composition showing the design system in action:
- A card component, button variants, form inputs, and a nav bar
- Use `image_generate` with specific color hex values from the palette
- Verify with `image_analyze` for visual coherence

### Step 6: Output

Deliver:
1. **Visual assets**: Color swatch SVG, typography specimen SVG, sample composition image
2. **Structured spec** (to blackboard):

```
## Design System: [Name]

### Colors
| Token | Hex | HSL | Use |
|-------|-----|-----|-----|
| primary-500 | #2563EB | 217 91% 53% | Buttons, links |
| primary-100 | #DBEAFE | 214 95% 93% | Light backgrounds |
...

### Typography
| Level | Size | Weight | Line Height | Use |
|-------|------|--------|-------------|-----|
| h1 | 36px / 2.25rem | 700 | 1.25 | Page titles |
| body | 16px / 1rem | 400 | 1.5 | Body text |
...

### Spacing
| Token | Value | Use |
|-------|-------|-----|
| space-1 | 4px | Tight gaps |
| space-4 | 16px | Standard padding |
...

### Assets
- Color palette: [file path]
- Typography specimen: [file path]
- Component preview: [file path]
```

## Guardrails

1. Always check contrast ratios — primary text must meet WCAG AA (4.5:1 for normal text, 3:1 for large).
2. Keep palette to 5-7 distinct hues max — more creates visual noise.
3. Generate SVG swatches for scalable palette cards; use image_generate for realistic component previews.
4. If the user has existing brand colors, build the system around those — do not replace them.
