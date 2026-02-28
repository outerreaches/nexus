# Excalidraw Element Requirements

Use this checklist when creating or editing scene elements manually.

## Top-Level Scene Keys

Keep all of these keys present:

- `type` (must be `"excalidraw"`)
- `version` (must be `2`)
- `source` (usually `https://excalidraw.com`)
- `elements` (array)
- `appState` (object)
- `files` (object)

## Required Fields Per Element

Every element should include:

- `id`
- `type`
- `x`
- `y`
- `width`
- `height`
- `angle`
- `strokeColor`
- `backgroundColor`
- `fillStyle`
- `strokeWidth`
- `strokeStyle`
- `roughness`
- `opacity`
- `groupIds`
- `frameId`
- `roundness`
- `seed`
- `version`
- `versionNonce`
- `isDeleted`
- `boundElements`
- `updated`
- `link`
- `locked`

## Validation Commands

```bash
jq empty /abs/path/diagram.excalidraw.json
node skills/creative/excalidraw/scripts/validate-scene.js /abs/path/diagram.excalidraw.json
```
