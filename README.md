# 3JsBildr

A terrain editor for building low-poly dioramas in the browser. So far: sculpting, the table-to-ground camera, foliage, creatures, time of day and a miniature blur.

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
| Add land | Click an empty space beside the slab |
| Reverse (raise/lower, plant/clear, place/remove creatures) | Hold Shift |
| Tool | 1 Raise, 2 Lower, 3 Smooth, 4 Flatten, 5 Plant, 6 Clear plants, 7 Creature |
| Brush size / strength | `[` `]` / `-` `=` |
| Zoom (towards the cursor) | Scroll or pinch |
| Orbit / look around | Right-drag, or Alt-drag |
| Pan | Space-drag, or middle-drag |
| Move / turn | WASD or arrows (Shift = faster) / Q E |
| Time of day | `,` `.` or the slider |
| Miniature blur on/off | B |
| Frame-time readout and performance settings | P |
| Reset view | 0 |
| Explore mode (no tools, drag to look) | V |
| Undo / redo | Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z |
| Hide the hint bar | H |

The Plant tool scatters whatever is picked beside the rail. "Forest mix" chooses species by height: horsetails at the shore, tree ferns and cycads low down, conifers higher up, ferns everywhere. Plants only take root where their species can live, and they ride the ground when you sculpt under them.

The Creature tool places whichever animal is picked beside the rail: click for one, hold to gather a herd (some of them young, who follow an adult). Long-necks, plated ones and runners walk with their feet planted on the ground, avoid water, cliffs and the slab edge, and roam around where you put them; flyers circle overhead. Down at ground level they turn to look at you, and runners bolt. "Reroll looks" gives every creature new colours and proportions.

Hover just off the edge of the slab and an outline appears in the empty space; click it to add a tile of fresh land joined to its neighbours (up to 12 tiles). Sculpting, water and planting run across the seams, and Undo removes the tile.

The world (terrain, plants, time of day) autosaves to the browser after every stroke. Export and Import move it in and out as a JSON file.

## Performance panel

Press P. The readout shows frames per second, the average and worst gap between frames, script time (cpu), graphics-card time (gpu, where the browser exposes it), draw calls, triangles, and how many plants were drawn out of the total. Frame time can't drop below the display's refresh interval, so use cpu, gpu and the counts to see headroom.

- **Cached shadows:** the shadow map is redrawn only when the sun, land or plants change.
- **Region culling:** plants are drawn in a 6 by 6 grid of regions, and regions outside the view are skipped.
- **Thinning from / amount:** beyond the "from" distance, ferns and horsetails shrink away until only the remaining share is left at twice that distance. Amount 0 turns it off.

## Layout

- `src/terrain.ts`: the tiles, their shared heightfield and flat-shaded meshes, slab sides, water, picking, save/load
- `src/ghost.ts`: the outline that offers a new tile
- `src/brushes.ts`: the four sculpting brushes
- `src/foliage.ts`: plant models, habitat rules, scattering, instanced rendering and wind
- `src/creatures.ts`: body plans, walking, wandering and the instanced shapes creatures are built from
- `src/atmosphere.ts`: sky, sun, fill light and haze for each time of day
- `src/post.ts`: the miniature (tilt-shift) blur
- `src/perf.ts`: the frame-time readout
- `src/camera.ts`: the continuous table-to-ground camera (tuning constants at the top)
- `src/palette.ts`: every colour and the height bands that pick them
- `src/scenery.ts`: clouds
- `src/cursor.ts`: the brush ring
- `src/main.ts`: input, history, HUD wiring, frame loop

In the browser console, `bildr` exposes the camera rig, terrain, foliage, creatures, atmosphere and brush, e.g. `bildr.rig.goTo({ zoom: 1, x: 10, z: -5 })`.
