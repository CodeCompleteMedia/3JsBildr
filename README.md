# 3JsBildr

A terrain editor for building low-poly dioramas in the browser. So far: sculpting, the table-to-ground camera, foliage, time of day and a miniature blur.

## Run

```sh
npm install
npm run dev
```

Then open the address Vite prints (usually http://localhost:5173).

## Controls

| Action | Input |
| --- | --- |
| Sculpt or plant | Left-drag |
| Reverse (raise/lower, plant/clear) | Hold Shift |
| Tool | 1 Raise, 2 Lower, 3 Smooth, 4 Flatten, 5 Plant, 6 Clear plants |
| Brush size / strength | `[` `]` / `-` `=` |
| Zoom (towards the cursor) | Scroll or pinch |
| Orbit / look around | Right-drag, or Alt-drag |
| Pan | Space-drag, or middle-drag |
| Move / turn | WASD or arrows (Shift = faster) / Q E |
| Time of day | `,` `.` or the slider |
| Miniature blur on/off | B |
| Reset view | 0 |
| Explore mode (no tools, drag to look) | V |
| Undo / redo | Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z |
| Hide the hint bar | H |

The Plant tool scatters whatever is picked beside the rail. "Forest mix" chooses species by height: horsetails at the shore, tree ferns and cycads low down, conifers higher up, ferns everywhere. Plants only take root where their species can live, and they ride the ground when you sculpt under them.

The world (terrain, plants, time of day) autosaves to the browser after every stroke. Export and Import move it in and out as a JSON file.

## Layout

- `src/terrain.ts`: the heightfield, its flat-shaded mesh, picking, save/load
- `src/brushes.ts`: the four sculpting brushes
- `src/foliage.ts`: plant models, habitat rules, scattering, instanced rendering and wind
- `src/atmosphere.ts`: sky, sun, fill light and haze for each time of day
- `src/post.ts`: the miniature (tilt-shift) blur
- `src/camera.ts`: the continuous table-to-ground camera (tuning constants at the top)
- `src/palette.ts`: every colour and the height bands that pick them
- `src/scenery.ts`: water and clouds
- `src/cursor.ts`: the brush ring
- `src/main.ts`: input, history, HUD wiring, frame loop

In the browser console, `bildr` exposes the camera rig, terrain, foliage, atmosphere and brush, e.g. `bildr.rig.goTo({ zoom: 1, x: 10, z: -5 })`.
