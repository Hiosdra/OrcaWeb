#!/usr/bin/env node
import { program } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { existsSync, statSync, readFileSync } from 'fs'
import { resolve, basename } from 'path'
import { ensureWasmArtifacts, wasmArtifactsPresent } from './download.ts'
import { loadModule, sliceStl, writeGcode } from './slicer.ts'

const VERSION = '0.1.0'

program
  .name('orca-cli')
  .description('OrcaSlicer in your terminal — powered by WebAssembly')
  .version(VERSION)

// ─── setup command ──────────────────────────────────────────────────────────
program
  .command('setup')
  .description('Download WASM artifacts (~152 MB, one-time setup)')
  .action(async () => {
    console.log(chalk.bold('\n  OrcaWeb CLI — setup\n'))

    if (wasmArtifactsPresent()) {
      console.log(chalk.green('  ✓ WASM artifacts already present'))
      return
    }

    const spinner = ora('  Downloading WASM artifacts…').start()
    let lastName = ''

    try {
      await ensureWasmArtifacts((name, percent) => {
        if (name !== lastName) {
          lastName = name
        }
        spinner.text = `  Downloading ${chalk.cyan(name)} — ${percent}%`
      })

      spinner.succeed(chalk.green('  WASM artifacts ready'))
      console.log(chalk.dim('\n  Run orca-cli slice --help to get started\n'))
    } catch (err) {
      spinner.fail(chalk.red('  Download failed'))
      console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`))
      process.exit(1)
    }
  })

// ─── slice command ───────────────────────────────────────────────────────────
program
  .command('slice <file>')
  .description('Slice an STL file and produce G-code')
  .option('-o, --output <path>',          'Output G-code path (default: <input>.gcode)')
  .option('--preset <name>',              'Quality preset: draft | standard | fine', 'standard')
  .option('--printer <name>',             'Printer model name',            'Generic')
  .option('--filament <type>',            'Filament type: PLA | PETG | ABS | TPU', 'PLA')
  .option('--layer-height <mm>',          'Layer height in mm',            '0.2')
  .option('--infill <percent>',           'Infill density 0-100',          '15')
  .option('--walls <n>',                  'Number of wall loops',          '3')
  .option('--nozzle-temp <°C>',           'Nozzle temperature',            '220')
  .option('--bed-temp <°C>',              'Bed temperature',               '60')
  .option('--supports',                   'Enable supports')
  .option('--brim <mm>',                  'Brim width in mm',              '0')
  .option('--speed <mm/s>',               'Default print speed',           '100')
  .option('--profile <path>',             'Load settings from OrcaSlicer JSON profile')
  .option('--nozzle <mm>',                'Nozzle diameter',               '0.4')
  .action(async (filePath: string, opts) => {
    const stlPath = resolve(filePath)

    if (!existsSync(stlPath)) {
      console.error(chalk.red(`\n  Error: file not found: ${stlPath}\n`))
      process.exit(1)
    }

    if (!stlPath.toLowerCase().endsWith('.stl')) {
      console.error(chalk.red('\n  Error: only .stl files are supported\n'))
      process.exit(1)
    }

    const outputPath = opts.output
      ? resolve(opts.output as string)
      : stlPath.replace(/\.stl$/i, '.gcode')

    // Build config from CLI options + optional profile JSON
    let config: Record<string, unknown> = {}

    if (opts.profile) {
      const profilePath = resolve(opts.profile as string)
      if (!existsSync(profilePath)) {
        console.error(chalk.red(`\n  Error: profile not found: ${profilePath}\n`))
        process.exit(1)
      }
      try {
        config = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>
      } catch {
        console.error(chalk.red('\n  Error: failed to parse profile JSON\n'))
        process.exit(1)
      }
    }

    // Apply preset
    const presets: Record<string, Partial<Record<string, unknown>>> = {
      draft:    { layer_height: 0.3, wall_loops: 2, sparse_infill_density: 10, default_speed: 150 },
      standard: { layer_height: 0.2, wall_loops: 3, sparse_infill_density: 15, default_speed: 100 },
      fine:     { layer_height: 0.1, wall_loops: 4, sparse_infill_density: 20, default_speed: 60  },
    }
    const preset = presets[opts.preset as string] ?? presets.standard
    config = { ...preset, ...config }

    // Override with explicit CLI flags
    config.printer_model       = opts.printer
    config.nozzle_diameter     = parseFloat(opts.nozzle as string)
    config.filament_type       = opts.filament
    config.layer_height        = parseFloat(opts.layerHeight as string)
    config.sparse_infill_density = parseInt(opts.infill as string, 10)
    config.wall_loops          = parseInt(opts.walls as string, 10)
    config.nozzle_temperature  = parseInt(opts.nozzleTemp as string, 10)
    config.bed_temperature     = parseInt(opts.bedTemp as string, 10)
    config.enable_support      = opts.supports ?? false
    config.brim_width          = parseFloat(opts.brim as string)
    config.default_speed       = parseFloat(opts.speed as string)

    // Print summary
    const size = statSync(stlPath).size
    console.log(chalk.bold(`\n  OrcaWeb CLI v${VERSION}\n`))
    console.log(`  ${chalk.dim('Input:')}    ${basename(stlPath)} ${chalk.dim(`(${formatBytes(size)})` )}`)
    console.log(`  ${chalk.dim('Output:')}   ${basename(outputPath)}`)
    console.log(`  ${chalk.dim('Preset:')}   ${opts.preset}`)
    console.log(`  ${chalk.dim('Printer:')}  ${config.printer_model} / ${config.nozzle_diameter}mm nozzle`)
    console.log(`  ${chalk.dim('Filament:')} ${config.filament_type} @ ${config.nozzle_temperature}°C / ${config.bed_temperature}°C bed`)
    console.log(`  ${chalk.dim('Layers:')}   ${config.layer_height}mm · ${config.wall_loops} walls · ${config.sparse_infill_density}% infill\n`)

    // Ensure WASM artifacts
    if (!wasmArtifactsPresent()) {
      const spinner = ora('  Downloading WASM artifacts (first run)…').start()
      let lastName = ''
      try {
        await ensureWasmArtifacts((name, percent) => {
          if (name !== lastName) lastName = name
          spinner.text = `  Downloading ${name} — ${percent}%`
        })
        spinner.succeed('  WASM artifacts ready')
      } catch (err) {
        spinner.fail(chalk.red('  Failed to download WASM'))
        console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`))
        console.log(chalk.dim('  Run `orca-cli setup` to retry\n'))
        process.exit(1)
      }
    }

    // Load WASM module
    const loadSpinner = ora('  Loading slicer engine…').start()
    let module
    try {
      module = await loadModule()
      loadSpinner.succeed('  Slicer engine ready')
    } catch (err) {
      loadSpinner.fail(chalk.red('  Failed to load slicer'))
      console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`))
      process.exit(1)
    }

    // Slice
    const sliceSpinner = ora('  Slicing…').start()
    const t0 = Date.now()
    try {
      const gcode = sliceStl(module, { stlPath, outputPath, config })
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      sliceSpinner.succeed(`  Sliced in ${elapsed}s`)

      writeGcode(gcode, outputPath)

      const lines = gcode.split('\n').length
      const gcodeSize = Buffer.byteLength(gcode, 'utf8')
      const timeMatch = gcode.match(/; estimated printing time[^=]+=\s*(.+)/i)
      const printTime = timeMatch ? `  ${chalk.dim('Est. print time:')} ${timeMatch[1].trim()}\n` : ''

      console.log(`\n  ${chalk.green('✓')} ${chalk.bold(basename(outputPath))}`)
      console.log(`  ${chalk.dim('G-code lines:')} ${lines.toLocaleString()}`)
      console.log(`  ${chalk.dim('File size:')}    ${formatBytes(gcodeSize)}`)
      if (printTime) process.stdout.write(printTime)
      console.log()
    } catch (err) {
      sliceSpinner.fail(chalk.red('  Slicing failed'))
      console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`))
      process.exit(1)
    }
  })

// ─── profiles command ────────────────────────────────────────────────────────
program
  .command('profiles')
  .description('List built-in printer, filament, and quality presets')
  .action(() => {
    console.log(chalk.bold('\n  Quality presets\n'))
    const quality = [
      ['draft',    '0.3mm layers · 2 walls · 10% infill · 150 mm/s'],
      ['standard', '0.2mm layers · 3 walls · 15% infill · 100 mm/s'],
      ['fine',     '0.1mm layers · 4 walls · 20% infill · 60 mm/s'],
    ]
    for (const [name, desc] of quality) {
      console.log(`  ${chalk.cyan(name.padEnd(12))} ${chalk.dim(desc)}`)
    }

    console.log(chalk.bold('\n  Filament types\n'))
    const filaments = [
      ['PLA',  '220°C nozzle · 60°C bed'],
      ['PETG', '240°C nozzle · 80°C bed'],
      ['ABS',  '255°C nozzle · 100°C bed'],
      ['TPU',  '230°C nozzle · 50°C bed'],
    ]
    for (const [name, desc] of filaments) {
      console.log(`  ${chalk.cyan(name.padEnd(12))} ${chalk.dim(desc)}`)
    }

    console.log(chalk.bold('\n  Printer presets\n'))
    const printers = [
      ['Generic',        'Any FDM printer · 0.4mm nozzle · 100 mm/s'],
      ['BambuLab P1S',   '0.4mm · 300 mm/s default'],
      ['BambuLab X1C',   '0.4mm · 350 mm/s default'],
      ['Creality Ender-3', '0.4mm · 60 mm/s default'],
      ['Prusa MK4',      '0.4mm · 120 mm/s default'],
      ['Voron 2.4',      '0.4mm · 200 mm/s default'],
    ]
    for (const [name, desc] of printers) {
      console.log(`  ${chalk.cyan(name.padEnd(20))} ${chalk.dim(desc)}`)
    }
    console.log()
  })

program.parse()

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
