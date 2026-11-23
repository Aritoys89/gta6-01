// Port Solano: Sunset Takeover — hand-in program for the make.fun gta6-01
// bounty ("Make GTA 6").
//
// Running this file delivers the entry. It does three things, in order:
//
//   1. Copies the playable game (game/, plain static files) from this
//      repository into the output directory.
//   2. Copies the screenshots (screenshots/) alongside it.
//   3. Builds the entry dossier with the vendored make.fun library and
//      writes the exact bytes it returns to dossier.json in the output
//      directory. The dossier has to come out of buildDossier itself —
//      the scorer rebuilds it and compares byte for byte, so nothing here
//      re-implements or post-processes it.
//
// The output directory is /output, or the folder named by the
// MAKEFUN_OUTPUT_DIR environment variable when that is set.

import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// The gta6-01 gate limits, passed to buildDossier so the dossier is made
// under the same caps the scorer enforces: the dossier text at most
// 160 KiB, 3–4 screenshots of at most 256 KiB each, and the game tree at
// most 993 entries / 48 MiB with no path over 1,000 bytes.
const GATE_CAPS = {
  text_max_bytes: 163_840,
  screenshots: { max: 4, max_bytes: 256 * 1024 },
  game_max_files: 993,
  game_max_bytes: 48 * 1024 * 1024,
  game_path_max_bytes: 1_000,
};

// This file sits at the repository root, so its folder is the entry dir.
const ENTRY_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function note(message: string): void {
  console.log(`[main] ${message}`);
}

function fail(message: string): never {
  throw new Error(`[main] ${message}`);
}

// Copy one top-level folder of the entry into the output directory,
// refusing to go ahead when the folder is not there to copy.
function deliverFolder(name: string): void {
  const from = join(ENTRY_DIR, name);
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    fail(`expected a ${name}/ directory in ${ENTRY_DIR}`);
  }
  const to = join(OUTPUT_DIR, name);
  cpSync(from, to, { recursive: true, force: true });
  note(`copied ${name}/ -> ${to}`);
}

function main(): void {
  note(`entry:  ${ENTRY_DIR}`);
  note(`output: ${OUTPUT_DIR}`);
  mkdirSync(OUTPUT_DIR, { recursive: true });

  deliverFolder('game');
  deliverFolder('screenshots');

  // The dossier describes the entry as it lives in this repository; the
  // copies above are byte-identical, so building from here is building
  // from what was just delivered.
  const dossier = buildDossier(ENTRY_DIR, GATE_CAPS);
  const dossierPath = join(OUTPUT_DIR, 'dossier.json');
  writeFileSync(dossierPath, dossier);
  note(`wrote ${dossierPath} (${dossier.byteLength} bytes)`);
  note('done');
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
