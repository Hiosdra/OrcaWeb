import type { OrcaConfig } from '../types'

/**
 * How a resolved OrcaConfig is assembled, lowest priority first.
 *
 *   1. `preset`   — the selected printer + filament + quality preset
 *                   (buildConfig). What the UI shows when nothing else has
 *                   spoken for a field.
 *   2. `imported` — settings carried by an imported file: the config embedded
 *                   in a .3mf, or a .json OrcaSlicer preset. Outranks the
 *                   preset selection, because the file is a deliberate,
 *                   more specific statement about this print.
 *   3. `manual`   — fields the user edited by hand in the settings panel.
 *                   Always wins, and — this is the part that is easy to break
 *                   — SURVIVES every change to the layers underneath it:
 *                   switching printer/filament/quality preset, importing a
 *                   profile, loading another .3mf.
 *
 * This mirrors desktop OrcaSlicer, where a setting you have modified stays
 * modified (and stays flagged as such) as you switch presets around it —
 * it is not silently reverted to the new preset's value.
 *
 * The rule that makes or breaks it: **changing a lower layer must never
 * clear a higher one.** Every one of the four handlers in App.tsx that swaps
 * a preset or an import used to call `setManualOverrides({})`, which threw
 * the user's edits away — including, since the quality chips fire even when
 * you click the already-selected one, with no visible change to point at
 * afterwards. Overrides are dropped only when the user says so: the per-field
 * revert, "Reset all", or loading a saved user preset (which replaces the
 * whole selection by definition).
 *
 * One asymmetry lives downstream, in the worker: `_passthrough` (unmapped
 * fields from an imported profile) is applied *after* the mapped config on
 * its way to the engine. That does not break this order, because
 * parseOrcaProfileJson only ever puts a field in `_passthrough` when it is
 * NOT one of the mapped fields the panel can edit — the two sets are
 * disjoint, so a manual override can never be shadowed by a passthrough one.
 * Adding a panel control for a field that arrives via passthrough would
 * change that, and would need the worker's merge order revisited.
 */
export type ConfigLayer = 'preset' | 'imported' | 'manual'

/** Config keys that may be represented by a manual override. */
export type ConfigField = Exclude<keyof OrcaConfig, '_passthrough'>

/**
 * Merge config layers left-to-right, later layers winning — with
 * `_passthrough` merged field-by-field rather than replaced wholesale, so an
 * imported profile's unmapped fields don't discard the printer preset's
 * (machine_start_gcode and friends).
 */
export function mergeConfigLayers(...layers: Partial<OrcaConfig>[]): OrcaConfig {
  const passthrough = Object.assign({}, ...layers.map((layer) => layer._passthrough ?? {}))
  return {
    ...Object.assign({}, ...layers),
    ...(Object.keys(passthrough).length > 0 ? { _passthrough: passthrough } : {}),
  } as OrcaConfig
}

/** The single config the rest of the app slices with, per the order above. */
export function resolveConfig(layers: {
  preset: Partial<OrcaConfig>
  imported?: Partial<OrcaConfig>
  manual?: Partial<OrcaConfig>
}): OrcaConfig {
  return mergeConfigLayers(layers.preset, layers.imported ?? {}, layers.manual ?? {})
}

/**
 * The fields the user has overridden by hand — what the panel marks as
 * modified and offers a revert for.
 *
 * `_passthrough` is not a field: it's the bag of unmapped values, has no
 * control of its own, and is never written by the panel.
 */
export function overriddenFields(manual: Partial<OrcaConfig>): ConfigField[] {
  return Object.keys(manual).filter((key): key is ConfigField => key !== '_passthrough')
}

/** Drop a single manual override, revealing whatever the layers below say. */
export function revertField(manual: Partial<OrcaConfig>, key: ConfigField): Partial<OrcaConfig> {
  const { [key]: _dropped, ...rest } = manual
  return rest
}
