# User Guide

## Interface overview

OrcaWeb is a three-step workflow: **Model → Settings → Slice**.

### Model tab

Upload your model by dragging it onto the drop zone or clicking to browse. Supported formats: **STL** (ASCII and binary) and **3MF**.

- Rotate: left-drag
- Pan: right-drag / Ctrl+drag
- Zoom: scroll wheel

The 3D viewer shows the model on a virtual print bed sized to match the currently selected printer (e.g. 256×256 mm for Bambu Lab, 250×210 mm for Prusa MK4).

#### 3MF files

When you load a `.3mf` file, OrcaWeb automatically:

1. Extracts the mesh geometry and converts it to binary STL for the slicer
2. Reads any OrcaSlicer profile metadata bundled inside the archive (`Metadata/*.json` / `.config`)
3. Applies the embedded settings — printer model, nozzle diameter, bed size, filament temperatures, process parameters — as overrides on the Settings panel

If the 3MF contains a machine profile with a `printable_area` field the bed visualisation updates to match.

!!! note
    Loading a plain STL after a 3MF clears the extracted overrides so you start fresh.

### Settings tab

Configure the print before slicing.

#### Printer

Choose a preset printer or select **Generic 0.4** / **Generic 0.6** for a standard setup. The selected printer determines the bed size shown in the 3D viewer and used for model centring during slicing.

| Preset | Bed size |
|--------|----------|
| Generic 0.4 / 0.6 | 256 × 256 mm |
| Bambu Lab P1S | 256 × 256 mm |
| Bambu Lab X1C | 256 × 256 mm |
| Creality Ender 3 | 220 × 220 mm |
| Prusa MK4 | 250 × 210 mm |
| Voron 2.4 | 300 × 300 mm |

You can also load a 3MF file from OrcaSlicer to pull in the exact bed dimensions from your slicer project.

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

Alternatively, load a **3MF file** — profiles embedded in the archive are extracted automatically (see [Model tab](#model-tab) above).

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

#### G-code statistics

After slicing, a stats panel shows key metrics parsed from the G-code header comments:

| Stat | Source comment |
|------|---------------|
| Print time | `; estimated printing time` |
| Layers | `; total layers count` |
| Filament | `; total filament used [mm]` |
| Weight | `; total filament weight [g]` |
| G-code size | byte count of the output file |

#### Downloading G-code

Click **Download G-code** to save the output as `<filename>.gcode`.

## Performance notes

- WASM loads once per browser session (~10–30 s on first visit depending on connection, then cached)
- Slicing a small model (10 mm cube): ~150 ms
- Slicing a complex model (500k triangles): ~2–5 s
- All processing is single-threaded (no SharedArrayBuffer required)
