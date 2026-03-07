---
name: svg-diagrams
description: Generate technical diagrams, flowcharts, and visual explanations as SVG using the Quiver API.
triggers: diagram, flowchart, architecture diagram, svg, sequence diagram, er diagram, network diagram, draw diagram, create diagram, visual explanation
---

# SVG Diagram Generation

Use this skill to create technical diagrams, flowcharts, architecture visuals, and explanatory illustrations as scalable SVG files.

## Tools Required

- `generate_svg` — create SVGs from text descriptions (Quiver API, model: arrow-preview)
- `image_analyze` — verify generated diagram visually
- `vectorize` — convert raster images to SVG (for reference image conversion)
- `write_to_blackboard` — store results with metadata

## When to Use generate_svg vs image_generate

| Need | Tool | Why |
|------|------|-----|
| Technical diagram, flowchart, architecture | `generate_svg` | Scalable, editable, clean lines |
| Artistic illustration, photorealistic | `image_generate` | Raster is better for complex imagery |
| Convert existing image to vector | `vectorize` | Traces raster to SVG |
| Diagram with embedded photos | Both | SVG for structure, raster for photos |

## Workflow

### Step 1: Clarify Requirements

Before generating, determine:
- **Diagram type**: flowchart, architecture, sequence, ER, network, mind map, org chart, timeline.
- **Content**: nodes/entities, relationships, labels, directional flow.
- **Style**: minimal/corporate/technical/playful, color scheme, light/dark background.
- **Scale**: simple (3-8 elements) or complex (10+ elements).

### Step 2: Compose the Prompt

Write a detailed, structured prompt for `generate_svg`. The Quiver model responds best to:

**Explicit layout instructions:**
```
"Create a left-to-right flowchart with 5 steps:
1. 'User Request' (rounded rectangle, blue)
2. 'API Gateway' (rectangle, gray)
3. 'Auth Service' (rectangle, orange)
4. 'Database' (cylinder, green)
5. 'Response' (rounded rectangle, blue)
Connect them with labeled arrows: 'HTTP POST', 'validate token', 'query', 'result'.
Use a white background, dark gray text, 2px stroke lines."
```

**Style anchors that work well:**
- "clean technical diagram", "minimal corporate style", "blueprint style on dark background"
- "hand-drawn sketch style", "flat design with rounded corners"
- "monochrome with accent color #2563EB"

**Layout hints:**
- "left-to-right flow", "top-to-bottom hierarchy", "radial/hub-and-spoke layout"
- "grid layout, 3 columns × 2 rows"
- "layered architecture: top layer = frontend, middle = API, bottom = data"

### Step 3: Generate

Call `generate_svg` with:
- `instructions`: the detailed prompt from step 2.
- `saveTo`: absolute path, e.g., `/data/workspace/diagrams/architecture-v1.svg`.
- `maxTokens`: increase for complex diagrams (default is usually fine for simple ones).

### Step 4: Verify

Use `image_analyze` on the generated SVG to check:
- All elements/nodes are present and labeled.
- Connections/arrows are correct.
- Text is readable and not overlapping.
- Layout matches the intended structure.

Verification prompt:
```
"This SVG diagram should show [EXPECTED CONTENT]. Verify: are all [N] elements present?
Are connections correct? Is text readable? Note any missing or misplaced elements."
```

### Step 5: Iterate

If the diagram needs corrections:
- Refine the prompt with more specific positioning/sizing instructions.
- For small fixes, consider generating a corrected version rather than editing SVG source.
- Maximum 3 generation attempts per diagram — if the layout is fundamentally wrong, simplify the diagram or split into multiple smaller ones.

**Simplification strategies when generation struggles:**
- Reduce element count (split into sub-diagrams).
- Use simpler shapes (rectangles instead of custom icons).
- Remove decorative elements, focus on structure.
- Break complex flows into phases/layers.

### Step 6: Deliver

- Save final SVG to workspace.
- Write to blackboard with diagram type, element count, and description.
- Report the file path and a text summary of what the diagram shows.

## Diagram Type Cheat Sheet

### Flowchart
```
"Flowchart with decision diamonds. Start → Process A → Decision (yes/no) → Process B or Process C → End.
Use rounded rectangles for start/end, rectangles for processes, diamonds for decisions.
Color: blue for start/end, white for processes, yellow for decisions."
```

### Architecture Diagram
```
"3-tier architecture diagram. Top: 'Client' (browser icon). Middle: 'API Server' and 'Worker Queue' side by side.
Bottom: 'PostgreSQL' and 'Redis' side by side. Arrows show request flow downward, responses upward.
Use boxes with subtle shadows, light gray background, section labels."
```

### Sequence Diagram
```
"Sequence diagram with 3 participants: Client, Server, Database.
Client sends 'POST /login' to Server. Server sends 'SELECT user' to Database.
Database returns 'user record'. Server returns '200 OK + token' to Client.
Vertical lifelines, horizontal arrows with labels, time flows downward."
```

### Entity-Relationship
```
"ER diagram with entities: User (id, name, email), Post (id, title, body, user_id), Comment (id, text, post_id, user_id).
User has-many Posts (1:N). Post has-many Comments (1:N). User has-many Comments (1:N).
Rectangles for entities, ovals for attributes, diamond for relationships, crow's foot notation."
```

## Guardrails

1. Always use absolute paths under `/data/workspace/` or `/data/nexus/`.
2. Keep diagrams under 15 elements for best results — split complex systems into sub-diagrams.
3. Do not embed large text blocks in diagrams — use short labels and a legend.
4. If generate_svg fails, do not fall back to writing raw SVG code — the output is rarely correct. Report the failure.
5. SVGs can be large (up to 2MB) — for very complex diagrams, verify file size.

## Completion Protocol

1. Report: diagram type, element count, file path, file size.
2. Provide a text description of the diagram content.
3. Note any elements that were simplified or omitted.
