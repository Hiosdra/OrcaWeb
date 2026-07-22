# Profiles

## OrcaSlicer profile format

OrcaSlicer stores print profiles as JSON files with a `type` field indicating whether the file describes a **machine**, **filament**, or **process** (print settings).

```json
{
  "type": "process",
  "name": "0.20mm Standard @BBL X1C",
  "inherits": "fdm_process_common",
  "layer_height": "0.2",
  "wall_loops": "3",
  "sparse_infill_density": "15%",
  "sparse_infill_pattern": "gyroid",
  "outer_wall_speed": "150",
  "enable_support": "0"
}
```

!!! note "String encoding"
    OrcaSlicer encodes all values as strings, even numbers (`"0.2"` not `0.2`) and booleans (`"1"` not `true`). Percentages use the `%` suffix (`"15%"`). OrcaWeb's parser handles all of these automatically.

## Where to find profile files

=== "Windows"
    ```
    %APPDATA%\OrcaSlicer\user\default\machine\
    %APPDATA%\OrcaSlicer\user\default\filament\
    %APPDATA%\OrcaSlicer\user\default\process\
    ```

=== "macOS"
    ```
    ~/Library/Application Support/OrcaSlicer/user/default/machine/
    ~/Library/Application Support/OrcaSlicer/user/default/filament/
    ~/Library/Application Support/OrcaSlicer/user/default/process/
    ```

=== "Linux"
    ```
    ~/.config/OrcaSlicer/user/default/machine/
    ~/.config/OrcaSlicer/user/default/filament/
    ~/.config/OrcaSlicer/user/default/process/
    ```

## Field mapping

OrcaWeb maps OrcaSlicer profile fields to its internal `OrcaConfig`. Aliases from different OrcaSlicer versions are handled.

| OrcaSlicer field | OrcaConfig key | Notes |
|-----------------|---------------|-------|
| `layer_height` | `layer_height` | mm |
| `initial_layer_height` | `initial_layer_height` | mm |
| `wall_loops` / `perimeters` | `wall_loops` | |
| `top_shell_layers` | `top_shell_layers` | |
| `bottom_shell_layers` | `bottom_shell_layers` | |
| `sparse_infill_density` / `fill_density` | `sparse_infill_density` | `%` stripped |
| `sparse_infill_pattern` / `fill_pattern` | `sparse_infill_pattern` | |
| `outer_wall_speed` / `external_perimeter_speed` | `outer_wall_speed` | mm/s |
| `default_speed` / `inner_wall_speed` | `default_speed` | mm/s |
| `travel_speed` | `travel_speed` | mm/s |
| `initial_layer_speed` / `first_layer_speed` | `initial_layer_speed` | mm/s |
| `brim_width` | `brim_width` | mm |
| `seam_position` | `seam_position` | |
| `enable_support` | `enable_support` | `"1"` → true |
| `support_type` | `support_type` | |
| `fuzzy_skin` | `fuzzy_skin` | `"none"` / `"external"` / `"all"` |
| `fuzzy_skin_thickness` | `fuzzy_skin_thickness` | mm |
| `fuzzy_skin_point_dist` | `fuzzy_skin_point_dist` | mm |
| `enable_ironing` / `ironing` | `enable_ironing` | |
| `filament_type` | `filament_type` | filament profiles |
| `nozzle_temperature` / `temperature` | `nozzle_temperature` | °C |
| `bed_temperature` / `hot_plate_temp` | `bed_temperature` | °C |
| `fan_min_speed` | `fan_min_speed` | 0–100 |
| `printer_model` | `printer_model` | machine profiles |
| `nozzle_diameter` | `nozzle_diameter` | mm |
| `printable_area` | `bed_size_x` + `bed_size_y` | array of `"XxY"` corner strings; max X/Y taken as bed dimensions |
| `bed_size` | `bed_size_x` + `bed_size_y` | legacy format: `["W","H"]` or `"WxH"` |
| `printable_height` / `max_print_height` | `printable_height` | max Z height in mm |

Fields not in this table are **forwarded verbatim to the WASM slicer** (passthrough) rather than silently ignored. This means all machine-profile fields recognised by OrcaSlicer — `gcode_flavor`, `retract_length`, `retract_speed`, `lift_z`, `machine_start_gcode`, `machine_end_gcode`, `layer_change_gcode`, `machine_max_speed_*`, and more — reach the engine automatically when importing a machine profile JSON.

## 3MF profile extraction

OrcaSlicer saves complete project files as `.3mf` archives. When you load a 3MF in OrcaWeb, the profile extraction pipeline:

1. Unpacks the ZIP archive using [fflate](https://github.com/101arrowz/fflate)
2. Finds all files under `Metadata/` matching `*.json` or `*.config` (case-insensitive)
3. Sorts them by specificity: machine → filament → process → project (later wins on conflicts)
4. Parses each through the same `parseOrcaProfileJson` pipeline as manual imports
5. Merges into a single `Partial<OrcaConfig>` applied as overrides

The mesh geometry (`3D/3dmodel.model`) is converted from the 3MF XML format to binary STL transparently — the WASM slicer receives a standard STL.

## Settings precedence

Every value OrcaWeb slices with comes from one of three layers. Later layers win, field by field:

| # | Layer | Where it comes from | Replaced when |
|---|-------|--------------------|---------------|
| 1 | **Preset** | The selected printer + filament + quality preset | You pick a different printer, filament or quality preset |
| 2 | **Imported file** | Settings embedded in a `.3mf`, or an imported `.json` OrcaSlicer preset | You import another file, or remove the active import |
| 3 | **Your edits** | Any field you changed by hand in the settings panel | Only by you — per-field **reset**, **Reset all**, or loading a saved preset |

The rule that matters in daily use is the third row: **a setting you changed by hand survives everything underneath it.** Switch printer, switch filament, switch quality preset, load a different 3MF — your edited fields stay exactly as you left them, and only the fields you never touched follow the new profile. This matches desktop OrcaSlicer, where a modified setting stays modified (and stays flagged) as you switch presets around it.

Edited fields are marked in the panel with an amber outline and a **reset** button that drops that one override and reveals the profile's own value again. A summary at the top of the panel counts them and offers **Reset all**.

!!! warning "Loading a saved preset is the one exception"
    "My presets" stores a complete selection — printer, filament, quality preset *and* the manual edits that were active when you saved it. Loading one therefore replaces all three layers, including your current edits.

A field left unset in all three layers is not sent to the engine at all; OrcaSlicer then resolves it from its own built-in default. The number shown in the panel for such a field is a display-only default that deliberately matches that engine default — see `DISPLAY_DEFAULTS` in `src/lib/profiles.ts`.

The layer model itself lives in [`src/lib/config-layers.ts`](https://github.com/Hiosdra/OrcaWeb/blob/master/src/lib/config-layers.ts), which is the single place this order is defined and the only thing that may change it.

## Import behaviour

When you import a profile:

1. OrcaWeb reads the JSON and extracts all recognised fields into the UI model
2. Any remaining OrcaSlicer fields are collected and forwarded verbatim to the WASM slicer
3. The extracted settings become the **imported** layer — above the preset selection, below your own edits
4. A confirmation message shows the profile name and type (e.g. `Imported "Bambu Lab P1S 0.4 nozzle" · machine profile · 42 settings`)
5. You can still manually adjust individual settings after importing, and those adjustments outrank the file

Importing a second profile replaces the first one's layer. It does not touch settings you edited by hand.

!!! tip "Machine profiles"
    Import a machine profile JSON from your OrcaSlicer installation (`%APPDATA%\OrcaSlicer\user\default\machine\` on Windows) to transfer the full printer configuration — G-code dialect, retraction, Z-hop, start/end G-code scripts, and kinematics limits — to the browser slicer.

## Built-in presets

OrcaWeb ships with minimal built-in presets for common printers and materials.

### Printer presets

| Preset | Model | Nozzle | Bed (X × Y) |
|--------|-------|--------|-------------|
| Generic 0.4 | Generic | 0.4 mm | 256 × 256 mm |
| Generic 0.6 | Generic | 0.6 mm | 256 × 256 mm |
| Bambu Lab P1S | BambuLab P1S | 0.4 mm | 256 × 256 mm |
| Bambu Lab X1C | BambuLab X1C | 0.4 mm | 256 × 256 mm |
| Creality Ender 3 | Creality Ender-3 | 0.4 mm | 220 × 220 mm |
| Prusa MK4 | Prusa MK4 | 0.4 mm | 250 × 210 mm |
| Voron 2.4 | Voron 2.4 | 0.4 mm | 300 × 300 mm |

Bed dimensions are also read from the `printable_area` field of an imported profile (or 3MF machine metadata), overriding the preset values.

### Quality presets

| Preset | Layer height | Walls | Infill |
|--------|-------------|-------|--------|
| Draft | 0.3 mm | 2 | 10% |
| Standard | 0.2 mm | 3 | 15% |
| Fine | 0.1 mm | 4 | 20% |
