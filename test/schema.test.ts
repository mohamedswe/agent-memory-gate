import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Version-sensitive, non-exported Gbrain source API. Deliberately import only
// the pure parser/loader, never the registry, CLI, engine, or database setup.
const packageDir = process.env.GBRAIN_PACKAGE_DIR;
if (!packageDir || !isAbsolute(packageDir)) {
  throw new Error("Set GBRAIN_PACKAGE_DIR to an absolute installed Gbrain package directory");
}
const { parseSchemaPackManifest } = await import(pathToFileURL(join(packageDir, "src/core/schema-pack/manifest-v1.ts")).href);
const { loadPackFromString } = await import(pathToFileURL(join(packageDir, "src/core/schema-pack/loader.ts")).href);
const manifestPath = fileURLToPath(new URL("../schema/dual-brain.json", import.meta.url));
const readManifest = () => JSON.parse(readFileSync(manifestPath, "utf8"));
const loadManifest = () => loadPackFromString(readFileSync(manifestPath, "utf8"), manifestPath);

test("local manifest exists and is accepted by the real Gbrain JSON loader and parser", () => {
  expect(existsSync(manifestPath)).toBe(true);
  const manifest = loadManifest();
  expect(manifest.name).toBe("dual-brain");
  expect(manifest).toEqual(parseSchemaPackManifest(readManifest()));
});

test("declares exactly the seven graph page types", () => {
  expect(loadManifest().page_types.map((type: { name: string }) => type.name).sort()).toEqual(
    ["project", "goal", "decision", "attempt", "finding", "procedure", "evidence"].sort(),
  );
});

test("declares exactly the seven relationship verbs with inverses", () => {
  expect(loadManifest().link_types.map((type: { name: string }) => type.name).sort()).toEqual(
    ["belongs_to", "attempts", "produces", "supports", "contradicts", "supersedes", "depends_on"].sort(),
  );
});
