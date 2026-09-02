# ADR-012: Atomic Local OrcaSlicer Profile Sets

**Status:** Accepted
**Date:** 2026-09-02

## Context

Desktop OrcaSlicer stores a printer selection as separate machine, process,
and filament JSON files. A dual-nozzle Voron setup therefore cannot be
represented faithfully by importing only one flat JSON file: the machine file
contains a nozzle vector, while each filament leaf can contain a different
temperature, flow, or G-code hook and may omit inherited fields such as
`filament_type`.

The browser app is intentionally local-first. The user's profile backup may be
private, so the app must not require GitHub credentials or silently download
remote files. The current product boundary is slicing and downloading G-code;
printer upload is a separate workflow.

## Decision

The profile picker accepts one or more local `.json` files and applies them as
one imported layer:

- at most one machine/process/print file is allowed;
- every filament file represents one material slot;
- duplicate categories and malformed/empty files are rejected before React state
  changes;
- known materials are ordered like the built-in presets (PLA, PETG, ABS, TPU),
  independent of browser file-list order;
- leaf `filament_type` values are inferred from the name or `inherits` when
  absent, and per-slot vectors are preserved in `_passthrough`;
- the imported machine's `nozzle_diameter` vector determines the physical nozzle
  count used by `filament_map`.

Once a set contains filament files, changing its slot list clears the complete
import before the new list is resolved. This covers adding/removing slots and
choosing a different material; it prevents fixed-length imported vectors from
being paired with a different material.

`mergeImportedProfileFiles()` is pure and covered by unit tests. The browser
handler parses all files first, then sends one `profile set` to `App`; a failed
parse or merge leaves the prior import active. `withFilamentSlots()` supplies
engine-required vectors and maps two slots to `1,2` for a two-nozzle machine.

No GitHub authentication, remote profile resolution, model hosting, or printer
upload is part of this decision. The app downloads the resulting G-code locally.

## Consequences

Positive:

- a real machine/process/PLA/PETG selection can reach the slicer as one coherent
  configuration;
- imported temperatures, flow, filament IDs, and material-specific G-code are
  not replaced by stock UI presets when the slot names agree;
- imports are atomic and deterministic, which makes the workflow reproducible.

Trade-offs:

- `inherits` parents are not fetched or recursively resolved. Fields absent from
  selected leaf files come from the selected built-in preset or engine defaults;
  production users must verify those effective values against desktop OrcaSlicer;
- arbitrary custom-material ordering after known materials follows selection
  order, because the app cannot infer a user's intended slot order from names;
- the model must be downloaded by the user and selected locally, and the G-code
  must be transferred to the printer separately.
