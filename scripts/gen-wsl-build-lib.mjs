// Pure parsing helpers for gen-wsl-build-script.mjs, split into their own
// module so they can be unit-tested (scripts/gen-wsl-build-lib.test.mjs)
// without running the generator — that script reads build-wasm.yml and writes
// build-local-wsl.sh as a side effect of being imported, so the functions
// couldn't be exercised in isolation while they lived inside it.

// Translate a step-level `if:` matrix guard into a bash test. Only the two
// shapes the workflow actually uses are recognized; anything else throws so a
// new guard shape can't be silently dropped from the generated script.
export function ifCondToBash(cond) {
  const m = cond.trim().match(/^matrix\.variant\s*(==|!=)\s*'(st|mt)'$/)
  if (!m) {
    throw new Error(
      `gen-wsl-build-script: unrecognized step 'if:' condition ${JSON.stringify(cond)} — ` +
        `teach ifCondToBash() how to translate it before regenerating.`,
    )
  }
  const [, op, val] = m
  return `[[ "$VARIANT" ${op} "${val}" ]]`
}

// Rewrites `${{ matrix.variant }}` and `${{ env.FOO }}` to shell references.
// Anything else under `${{ }}` (github.*, secrets.*, ternaries inline in a
// step body, etc.) has no local equivalent — fail loudly rather than emit
// broken-but-plausible bash, so a future workflow change that introduces a new
// expression shape can't silently slip through un-translated again.
export function substituteExpr(text, context) {
  const out = text
    .replace(/\$\{\{\s*matrix\.variant\s*\}\}/g, '${VARIANT}')
    .replace(/\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, '${$1}')
  if (out.includes('${{')) {
    const snippet = out.match(/.{0,40}\$\{\{.{0,40}/)[0]
    throw new Error(`gen-wsl-build-script: unhandled \${{ }} expression in ${context}: ${snippet}`)
  }
  return out
}

// Strip a trailing YAML line comment from a scalar value. In YAML a `#` only
// starts a comment when it's preceded by whitespace (or begins the value) and
// is not inside a quoted string — `KEY: "a#b"` and `KEY: a#b` keep the `#`,
// but `KEY: value  # note` does not. Without this, ENV_KEY_RE's greedy `(.+)`
// capture would fold ` # note` straight into the exported literal.
export function stripYamlComment(value) {
  let quote = null
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i)
    }
  }
  return value
}

// A per-variant value resolved by GitHub Actions from the build matrix, e.g.
//   ${{ matrix.variant == 'mt' && 'ON' || 'OFF' }}
// The local script builds one variant per run, so this becomes a $VARIANT if.
const TERNARY_RE = /^\$\{\{\s*matrix\.variant\s*==\s*'mt'\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'\s*\}\}$/

// A GitHub-context expression like ORCA_VERSION's
//   ${{ github.event.inputs.orca_version || (…github.ref…) || 'v2.4.2' }}
// has no local equivalent for the github.* terms — but its *trailing*
// `|| 'literal'` fallback is exactly the value CI resolves to when there's no
// dispatch input and no tag, i.e. the local-build case. Extract that literal
// as the local default so a workflow version bump flows into this script on
// the next regenerate instead of silently drifting from a hardcoded copy.
const GITHUB_EXPR_FALLBACK_RE = /\|\|\s*'([^']*)'\s*\}\}$/

// Turn one `jobs.build.env` entry into the bash that reproduces it in the
// generated header. GitHub Actions exposes every entry as a real shell env var
// to `run:` steps, so the header must export the same set with the same values
// or references like `${ONETBB_VERSION}` inside step bodies resolve to empty
// strings. `rawValue` is the unparsed text after `KEY:` (trailing comment and
// whitespace included); the returned line has no trailing newline.
export function envExportLine(key, rawValue) {
  const value = stripYamlComment(rawValue).trim()
  const ternary = value.match(TERNARY_RE)
  if (ternary) {
    const [, mtVal, stVal] = ternary
    return `if [[ "$VARIANT" == "mt" ]]; then\n  export ${key}="${mtVal}"\nelse\n  export ${key}="${stVal}"\nfi`
  }
  let literal
  if (/\$\{\{/.test(value)) {
    const fallback = value.match(GITHUB_EXPR_FALLBACK_RE)
    if (!fallback) {
      throw new Error(
        `gen-wsl-build-script: env.${key} = ${value} is a GitHub expression with no ` +
          `trailing \`|| 'literal'\` fallback to use as the local default — teach the parser about it.`,
      )
    }
    literal = fallback[1]
  } else {
    // `${KEY:-default}` — every env var doubles as a local override point
    // (e.g. EMSDK=/opt/emsdk in CI, but a userspace emsdk install elsewhere
    // locally), without needing a one-off special case.
    literal = value.replace(/^"(.*)"$/, '$1')
  }
  return `export ${key}="\${${key}:-${literal}}"`
}
