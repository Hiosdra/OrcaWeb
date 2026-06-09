# User Guide

## Interface overview

OrcaWeb is a three-step workflow: **Model → Settings → Slice**.

### Model tab

Upload your STL file by dragging it onto the drop zone or clicking to browse. The 3D viewer shows the model sitting on a virtual print bed at the correct scale in millimetres.

- Rotate: left-drag
- Pan: right-drag / Ctrl+drag
- Zoom: scroll wheel

### Settings tab

Configure the print before slicing.

#### Printer

Choose a preset printer or select **Generic 0.4** / **Generic 0.6** for a standard setup.

Built-in printers: Bambu Lab P1S, Bambu Lab X1C, Creality Ender 3, Prusa MK4, Voron 2.4.

#### Filament

Select the material type; nozzle and bed temperatures update automatically.

| Material | Nozzle | Bed |
|----------|--------|-----|
| PLA | 220°C | 60°C |
| PETG | 240°C | 80°C |
| ABS | 255°C | 100°C |
| TPU | 230°C | 50°C |

#### Quality preset

| Preset | Layer height | Use case |
|--------|-------------|----------|
| Draft | 0.3 mm | Fast prototypes |
| Standard | 0.2 mm | Everyday prints |
| Fine | 0.1 mm | Detail parts |

#### Infill

Adjust density (0–100%) and pattern. Available patterns: grid, gyroid, honeycomb, triangles, cubic, lightning, rectilinear.

#### Supports

Enable auto supports. Supported types: `normal(auto)`, `normal(manual)`, `tree(auto)`, `tree(manual)`.

#### Advanced settings

Click **Show advanced settings** for:

- Speed overrides (default, outer wall, first layer, travel)
- Seam position
- Ironing (top surface)

#### Importing an OrcaSlicer profile

Click **Import OrcaSlicer profile (.json)** to load settings from any desktop OrcaSlicer profile file. The app shows how many settings were imported and applies them as overrides on top of the current preset.

→ [Profile format details](profiles.md)

### Slice tab

After clicking **Slice model**:

1. The STL is passed to the Web Worker running OrcaSlicer WASM
2. Slicing takes ~50–500 ms depending on model complexity
3. On completion, two panels appear side-by-side:
   - **Model** — your original STL on the print bed
   - **G-code** — rendered toolpaths with a layer slider

#### G-code viewer

- Layers are coloured in rotation for easy visual separation
- Use the **Layer** slider to scroll through from bottom to top
- The layer counter shows current layer / total layers and the Z height

#### Downloading G-code

Click **Download G-code** to save the output as `<filename>.gcode`.

## Performance notes

- WASM loads once per browser session (~10–30 s on first visit depending on connection, then cached)
- Slicing a small model (10 mm cube): ~150 ms
- Slicing a complex model (500k triangles): ~2–5 s
- All processing is single-threaded (no SharedArrayBuffer required)
