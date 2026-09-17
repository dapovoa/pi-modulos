#!/usr/bin/env node
import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs"
import { join, extname, relative, resolve } from "node:path"
import { createRequire } from "node:module"

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
])

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
  ".astro",
  ".wrangler",
  ".next",
  ".firecrawl",
  ".svelte-kit",
  "vendor",
])

const GENERATED_MARKERS = [/@generated\b/, /auto-?generated/i, /do not edit/i]

const KEEP_RULES = [
  { id: "shebang", pattern: /^#!/ },
  { id: "ts-directive", pattern: /^\/\/\/\s*</ },
  { id: "ts-pragma", pattern: /@ts-(ignore|expect-error|nocheck|check)\b/ },
  { id: "jsx-pragma", pattern: /@jsx(ImportSource|Runtime|Frag)?\b/ },
  { id: "linter", pattern: /\b(eslint|stylelint|oxlint|biome|dprint|prettier)-(disable|enable|ignore)/ },
  { id: "linter", pattern: /\beslint-env\b/ },
  { id: "coverage", pattern: /\b(istanbul|c8|v8)\s+ignore\b/ },
  { id: "dead-code-tool", pattern: /\bts-prune-ignore\b/ },
  { id: "deno", pattern: /\b(deno-lint-ignore|@deno-types)\b/ },
  { id: "bundler", pattern: /(@|#)__PURE__/ },
  { id: "bundler", pattern: /@(preserve|license|vite-ignore)\b/ },
  { id: "bundler", pattern: /\bwebpack(Ignore|ChunkName|Preload|Prefetch|Mode|Exports)\b/ },
  { id: "sourcemap", pattern: /\bsource(MappingURL|URL)=/ },
  { id: "license", pattern: /\bSPDX-License-Identifier\b/ },
  { id: "license", pattern: /\bCopyright\b/i },
  { id: "license", pattern: /^\/\*!/ },
]

const SENTINEL = "\u0000"

function parseArguments(argv) {
  const options = { write: false, json: false, paths: [] }
  for (const arg of argv) {
    if (arg === "--write") {
      options.write = true
      continue
    }
    if (arg === "--json") {
      options.json = true
      continue
    }
    if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`)
    }
    options.paths.push(arg)
  }
  if (options.paths.length === 0) {
    options.paths.push(".")
  }
  return options
}

async function loadTypeScript(projectDir) {
  const require = createRequire(join(projectDir, "package.json"))
  try {
    const entry = require.resolve("typescript")
    const module = await import(`file://${entry}`)
    return module.default ?? module
  } catch {
    throw new Error(
      "typescript is not resolvable from this project. " +
        "Install it (npm i -D typescript) or handle these files with the model pass.",
    )
  }
}

function isGenerated(text) {
  const head = text.slice(0, 2000)
  return GENERATED_MARKERS.some((marker) => marker.test(head))
}

function collectFiles(target, collected) {
  const stats = statSync(target)
  if (stats.isFile()) {
    if (SOURCE_EXTENSIONS.has(extname(target))) {
      collected.push(target)
    }
    return
  }
  if (!stats.isDirectory()) return

  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      collectFiles(join(target, entry.name), collected)
      continue
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      collected.push(join(target, entry.name))
    }
  }
}

function matchKeepRule(commentText) {
  const trimmed = commentText.trim()
  for (const rule of KEEP_RULES) {
    if (rule.pattern.test(trimmed)) return rule.id
  }
  return null
}

function collectCommentRanges(ts, sourceFile, text) {
  const ranges = new Map()

  const add = (candidates) => {
    if (!candidates) return
    for (const range of candidates) {
      ranges.set(`${range.pos}:${range.end}`, range)
    }
  }

  const isCommentOnlyJsxExpression = (node) =>
    node.kind === ts.SyntaxKind.JsxExpression && !node.expression

  const visit = (node) => {
    add(ts.getLeadingCommentRanges(text, node.pos))
    add(ts.getTrailingCommentRanges(text, node.end))
    if (isCommentOnlyJsxExpression(node)) {
      const start = node.getStart(sourceFile)
      ranges.set(`${start}:${node.end}`, {
        pos: start,
        end: node.end,
        kind: ts.SyntaxKind.MultiLineCommentTrivia,
      })
    }
    for (const child of node.getChildren(sourceFile)) {
      visit(child)
    }
  }

  add(ts.getLeadingCommentRanges(text, 0))
  visit(sourceFile)

  return dropContainedRanges([...ranges.values()])
}

function dropContainedRanges(ranges) {
  const ordered = [...ranges].sort((a, b) => a.pos - b.pos || b.end - a.end)
  const result = []
  let lastEnd = -1
  for (const range of ordered) {
    if (range.pos < lastEnd) continue
    result.push(range)
    lastEnd = range.end
  }
  return result
}

function lineNumberAt(text, position) {
  let line = 1
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === "\n") line++
  }
  return line
}

function cutRanges(text, ranges) {
  let result = ""
  let cursor = 0
  for (const range of ranges) {
    result += text.slice(cursor, range.pos) + SENTINEL
    cursor = range.end
  }
  return result + text.slice(cursor)
}

function tidyLines(text) {
  const kept = []
  for (const line of text.split("\n")) {
    if (!line.includes(SENTINEL)) {
      kept.push(line)
      continue
    }
    const collapsed = line
      .replace(/([ \t]*)\u0000([ \t]*)/g, (_match, before, after) =>
        before.length > 0 || after.length > 0 ? " " : "",
      )
      .trimEnd()
    if (collapsed.trim().length === 0) continue
    kept.push(collapsed)
  }
  return kept.join("\n")
}

function processFile(ts, path, text) {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const comments = collectCommentRanges(ts, sourceFile, text)

  const removals = []
  const kept = []
  for (const range of comments) {
    const commentText = text.slice(range.pos, range.end)
    const keepRule = matchKeepRule(commentText)
    const line = lineNumberAt(text, range.pos)
    if (keepRule) {
      kept.push({ line, rule: keepRule, text: commentText.split("\n")[0].trim() })
      continue
    }
    removals.push({ line, range, text: commentText.split("\n")[0].trim() })
  }

  if (removals.length === 0) {
    return { removals, kept, output: null }
  }

  const output = tidyLines(cutRanges(text, removals.map((item) => item.range)))
  return { removals, kept, output }
}

function reportHuman(results, options, projectDir) {
  let removedTotal = 0
  let keptTotal = 0

  for (const result of results) {
    removedTotal += result.removals.length
    keptTotal += result.kept.length
    if (result.removals.length === 0 && result.kept.length === 0) continue

    const label = relative(projectDir, result.path) || result.path
    console.log(`\n${label}`)
    for (const removal of result.removals) {
      const verb = options.write ? "removed" : "would remove"
      console.log(`  ${verb} | line ${removal.line} | ${removal.text}`)
    }
    for (const item of result.kept) {
      console.log(`  kept (${item.rule}) | line ${item.line} | ${item.text}`)
    }
  }

  const files = results.filter((result) => result.removals.length > 0).length
  console.log(
    `\n${options.write ? "removed" : "removable"}: ${removedTotal} comment(s) in ${files} file(s); ` +
      `kept by rule: ${keptTotal}`,
  )
  if (!options.write && removedTotal > 0) {
    console.log("re-run with --write to apply")
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const projectDir = process.cwd()
  const ts = await loadTypeScript(projectDir)

  const files = []
  for (const path of options.paths) {
    collectFiles(resolve(projectDir, path), files)
  }

  const results = []
  for (const path of files) {
    const text = readFileSync(path, "utf-8")
    if (isGenerated(text)) continue

    const result = processFile(ts, path, text)
    if (options.write && result.output !== null) {
      writeFileSync(path, result.output, "utf-8")
    }
    results.push({ path, ...result })
  }

  if (options.json) {
    const payload = results.map((result) => ({
      path: relative(projectDir, result.path) || result.path,
      removed: result.removals.map((item) => ({ line: item.line, text: item.text })),
      kept: result.kept,
    }))
    console.log(JSON.stringify({ write: options.write, files: payload }, null, 2))
    return
  }

  reportHuman(results, options, projectDir)
}

main().catch((error) => {
  console.error(`strip-comments: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
