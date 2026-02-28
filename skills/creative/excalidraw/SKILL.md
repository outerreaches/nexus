---
name: excalidraw
description: Create, edit, validate, and export Excalidraw diagrams (.excalidraw / .excalidraw.json) with deterministic CLI tooling. Use when users want hand-drawn style architecture or flow diagrams, need Excalidraw-compatible source files, or request Excalidraw-to-SVG/PDF exports.
triggers: excalidraw, whiteboard diagram, sketch diagram, hand-drawn diagram, excalidraw json, .excalidraw, export excalidraw
---

# Excalidraw Diagram Workflow

Use this skill for Excalidraw-native diagram work where source scene JSON must remain editable.

## Preflight (always do first)

1. Confirm required tools are available.
   - `command -v excalidraw-to-svg`
   - `command -v node`
   - `command -v jq`
2. Confirm helper scripts exist.
   - `skills/creative/excalidraw/scripts/new-scene.js`
   - `skills/creative/excalidraw/scripts/validate-scene.js`
3. Confirm optional conversion tool.
   - `command -v cairosvg`
4. Confirm source file path.
   - existing: `<path>.excalidraw` or `<path>.excalidraw.json`
   - new: create under an explicit workspace path

## Recommended Workflow

### 1) Create or update scene JSON

1. For a new scene, scaffold from template:
   - `node skills/creative/excalidraw/scripts/new-scene.js /abs/path/diagram.excalidraw.json`
2. For existing scenes, edit `elements` while keeping top-level keys intact.
3. Use `reference/element-requirements.md` when adding new elements to ensure required fields are present.
4. Run JSON parse validation:
   - `jq empty /abs/path/diagram.excalidraw.json`
5. Run semantic validation:
   - `node skills/creative/excalidraw/scripts/validate-scene.js /abs/path/diagram.excalidraw.json`

### 2) Export to SVG

- `excalidraw-to-svg /abs/path/diagram.excalidraw.json /abs/path/diagram.svg`

### 3) Optional export to PNG/PDF

- PNG: `cairosvg /abs/path/diagram.svg -o /abs/path/diagram.png`
- PDF: `cairosvg /abs/path/diagram.svg -o /abs/path/diagram.pdf`

## References

- Scene template: `reference/scene-template.excalidraw.json`
- Element schema checklist: `reference/element-requirements.md`

## Editing Guardrails

1. Preserve source of truth: keep the `.excalidraw(.json)` file and generate exports as separate artifacts.
2. Keep element IDs unique and element `version` monotonic on edits.
3. Use absolute output paths for all exported files.
4. If an export fails, report the exact tool error and keep the source scene file unchanged.

## Completion Protocol

1. Report source scene path and exported artifact paths.
2. Report whether JSON validation passed.
3. Call out any unsupported rendering behavior or font-related caveats in exports.
