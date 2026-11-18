# 3JsBildr

A terrain editor for building low-poly dioramas in the browser. Step 1: sculpting and the table-to-ground camera.

## Run

```sh
npm install
npm run dev
```

Then open the address Vite prints (usually http://localhost:5173).

## Controls

| Action | Input |
| --- | --- |
| Sculpt | Left-drag |
| Reverse raise/lower | Hold Shift |
| Brush | 1 Raise, 2 Lower, 3 Smooth, 4 Flatten |
| Brush size / strength | `[` `]` / `-` `=` |
| Zoom (towards the cursor) | Scroll or pinch |
| Orbit / look around | Right-drag, or Alt-drag |
| Pan | Space-drag, or middle-drag |
| Move / turn | WASD or arrows (Shift = faster) / Q E |
| Reset view | 0 |
| Explore mode (no tools, drag to look) | V |
| Undo / redo | Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z |
| Hide the hint bar | H |

The terrain autosaves to the browser after every stroke. Export and Import move it in and out as a JSON file.

## Layout

- `src/terrain.ts`: the heightfield, its flat-shaded mesh, picking, save/load
- `src/brushes.ts`: the four brushes
- `src/camera.ts`: the continuous table-to-ground camera (tuning constants at the top)
- `src/palette.ts`: every colour and the height bands that pick them
- `src/scenery.ts`: sky, sun, water, clouds
- `src/cursor.ts`: the brush ring
- `src/main.ts`: input, history, HUD wiring, frame loop

In the browser console, `bildr` exposes the camera rig, terrain and brush, e.g. `bildr.rig.goTo({ zoom: 1, x: 10, z: -5 })`.
