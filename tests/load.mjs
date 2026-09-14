// Load a TypeScript module under test with injectable dependencies.
// Relative imports resolve to sibling .ts/.json files unless `mocks` overrides them,
// so a test can replace the database, the clock, or fetch without touching the source.
//
// Modules run in the host realm (a wrapper function, the way Node's own CommonJS
// loader works) so values they return share prototypes with the test's own objects
// and `assert.deepStrictEqual` behaves normally.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

function transpile(file) {
  return ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
}

function resolve(specifier, fromDirectory) {
  const base = path.resolve(fromDirectory, specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.json`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * @param {string} entry  Path of the module under test, relative to the repository root.
 * @param {object} [options]
 * @param {Record<string,unknown>} [options.mocks]     Specifier (or specifier suffix) -> module exports.
 * @param {Record<string,string|undefined>} [options.env]  process.env for the module.
 * @param {object} [options.globals]                   Globals to override, e.g. `fetch`.
 * @param {Record<string,unknown>} [options.builtins]  node: builtins to replace, e.g. `node:crypto`.
 * @returns {Record<string, any>} the module's exports
 */
export function load(entry, { mocks = {}, env = {}, globals = {}, builtins = {} } = {}) {
  const cache = new Map();

  function loadFile(file) {
    if (cache.has(file)) return cache.get(file);
    if (file.endsWith(".json")) {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      cache.set(file, value);
      return value;
    }
    const commonjs = { exports: {} };
    cache.set(file, commonjs.exports);
    const directory = path.dirname(file);

    function require(specifier) {
      for (const [key, value] of Object.entries(mocks)) {
        if (specifier === key || specifier.endsWith(key)) return value;
      }
      if (specifier.startsWith(".")) {
        const target = resolve(specifier, directory);
        if (!target)
          throw new Error(`Cannot resolve ${specifier} from ${path.relative(root, file)}`);
        return loadFile(target);
      }
      if (specifier.startsWith("node:") || !specifier.includes("/")) {
        return builtins[specifier] ?? nodeRequire(specifier);
      }
      throw new Error(`Unmocked import: ${specifier} (from ${path.relative(root, file)})`);
    }

    const names = ["exports", "module", "require", "process", ...Object.keys(globals)];
    const values = [
      commonjs.exports,
      commonjs,
      require,
      { ...process, env },
      ...Object.values(globals),
    ];
    // runInThisContext keeps the host realm; the wrapper supplies CommonJS locals.
    const factory = vm.runInThisContext(
      `(function (${names.join(", ")}) {\n${transpile(file)}\n})`,
      { filename: file },
    );
    factory(...values);

    cache.set(file, commonjs.exports);
    return commonjs.exports;
  }

  return loadFile(path.resolve(root, entry));
}
