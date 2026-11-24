// Full-window dataset loader for the kit's dev data. Dev tooling only; the
// grader never runs it.
//
// WHY THIS FILE EXISTS: the kit sim's loadDataset reads ONLY
// dataset/events/part-00000.ndjson.gz — 50,000 of the 128,058 events, the
// first ~40% of the window. v1 was tuned against that partial loader and its
// sweep reported +0.172 SOL while the real grader scored -1.138 SOL. This
// loader reads EVERY part listed in dataset/manifest.json and applies the
// manifest's universe filter (sha256 sample, SOL quote mint, no mayhem /
// cashback, minus excluded mints), so the local numbers reproduce grade-local
// to the lamport. Never tune against the kit's loadDataset again.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Dataset } from '../../new6-20261124/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-kit/baselines/pilot/momentum/tools/sim.ts';

interface ManifestFile {
  path: string;
}

interface Manifest {
  files: ManifestFile[];
  universe: { sample: { modulus: number; residue: number } };
  excluded_mints?: string[];
  window?: { end_slot?: number };
}

export function loadFullDataset(kit: string): Dataset {
  const kitJson = JSON.parse(readFileSync(`${kit}/kit.json`, 'utf8')) as { dataset_sha256: string };
  const manifest = JSON.parse(readFileSync(`${kit}/dataset/manifest.json`, 'utf8')) as Manifest;
  const { modulus, residue } = manifest.universe.sample;
  const excluded = new Set(manifest.excluded_mints ?? []);
  const members = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: any[] = [];
  for (const f of manifest.files) {
    const raw = gunzipSync(readFileSync(`${kit}/dataset/${f.path}`)).toString('utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e: any = JSON.parse(line);
      if (e.event === 'CreateEvent' && !members.has(e.mint)) {
        const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
        if (
          e.quote_mint === '11111111111111111111111111111111' &&
          !e.is_mayhem_mode &&
          !e.is_cashback_enabled &&
          !excluded.has(e.mint) &&
          h % BigInt(modulus) === BigInt(residue)
        ) {
          members.add(e.mint);
        }
      }
      if (members.has(e.mint)) events.push(e);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const batches: Array<{ slot: number; events: any[] }> = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  return {
    sha256: kitJson.dataset_sha256,
    events,
    endSlot: manifest.window?.end_slot ?? batches[batches.length - 1]!.slot,
    batches,
  } as unknown as Dataset;
}
