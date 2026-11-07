/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {extractFromDirectory} = require('react-webmcp/infer/extract.flow');
const {synthesizeProposals} = require('react-webmcp/infer/synthesize.flow');
const {
  createFixtureProvider,
} = require('react-webmcp/infer/providers/fixture.flow');

// The committed fixtures/webmcp/tools.proposals.json and tools.manifest.json
// are generated from fixtures/webmcp/src/App.js, and the review overlay, the
// README walkthrough and the contract check all read them. Nothing else
// notices when App.js changes under them (an added import shifts every
// line-keyed binding; a reworded description makes the manifest stale), so
// this suite regenerates what can be regenerated without a browser and
// compares.
//
// When it fails, regenerate the proposals (see fixtures/webmcp/README.md):
//
//   yarn infer-tools extract --src fixtures/webmcp/src --out fixtures/webmcp/tools.proposals.json
//   yarn infer-tools synthesize --in fixtures/webmcp/tools.proposals.json
//   yarn infer-tools trace --in fixtures/webmcp/tools.proposals.json --journey fixtures/webmcp/journeys/shop.json
//
// and the manifest with `yarn validate-tools --update` (needs a build and
// Chrome; the manifest checks below say which field moved).

const FIXED = '2026-11-01T00:00:00.000Z';
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'webmcp');
const SOURCE_DIR = path.join(FIXTURE_DIR, 'src');

const ANNOTATIONS_BY_SAFETY = {
  read: {readOnlyHint: true},
  mutate: {},
  irreversible: {consequentialHint: true},
};

const SOURCE_BY_BINDING_KIND = {
  'existing-hook': 'hook',
  'existing-tool-element': 'tree',
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Everything the page's trace step does not write.
function comparable(proposal) {
  const {inferredAt, evidence, ...rest} = proposal;
  return rest;
}

describe('the committed webmcp fixture files', () => {
  let committed;
  let fresh;

  beforeAll(async () => {
    committed = readJson(path.join(FIXTURE_DIR, 'tools.proposals.json'));
    const extracted = extractFromDirectory(SOURCE_DIR, {now: FIXED});
    fresh = (
      await synthesizeProposals(extracted, createFixtureProvider(), {
        now: FIXED,
      })
    ).file;
  });

  it('tools.proposals.json was generated from the current source tree', () => {
    expect(committed.version).toBe(1);
    expect(fresh.version).toBe(1);
    expect(path.resolve(REPO_ROOT, committed.source.dir)).toBe(
      path.resolve(process.cwd(), fresh.source.dir),
    );
    expect(committed.source.files).toEqual(fresh.source.files);
    expect(committed.proposals.map(proposal => proposal.id)).toEqual(
      fresh.proposals.map(proposal => proposal.id),
    );
    for (let i = 0; i < fresh.proposals.length; i++) {
      const id = fresh.proposals[i].id;
      // The id in the pair makes a failure name the proposal that drifted.
      expect([id, comparable(committed.proposals[i])]).toEqual([
        id,
        comparable(fresh.proposals[i]),
      ]);
    }
  });

  it('tools.proposals.json keeps the evidence the trace step added', () => {
    for (let i = 0; i < fresh.proposals.length; i++) {
      const id = fresh.proposals[i].id;
      const committedChecks = committed.proposals[i].evidence.map(
        item => item.check,
      );
      const freshChecks = fresh.proposals[i].evidence.map(item => item.check);
      for (let j = 0; j < freshChecks.length; j++) {
        expect([id, committedChecks]).toEqual([
          id,
          expect.arrayContaining([freshChecks[j]]),
        ]);
      }
      // Every entry is a well-formed evidence row.
      for (let j = 0; j < committed.proposals[i].evidence.length; j++) {
        const row = committed.proposals[i].evidence[j];
        expect(typeof row.check).toBe('string');
        expect(['ok', 'warn', 'bad', 'pending']).toContain(row.level);
        expect(typeof row.summary).toBe('string');
      }
    }
  });

  it('tools.manifest.json agrees with the tools the source declares', () => {
    const manifest = readJson(path.join(FIXTURE_DIR, 'tools.manifest.json'));
    expect(manifest.version).toBe(1);
    const exported = fresh.proposals.filter(
      proposal => proposal.status === 'exported',
    );
    expect(exported.length).toBeGreaterThan(0);

    // Every tool the page registers is declared in the source, by the
    // component the page attributes it to.
    for (let i = 0; i < manifest.tools.length; i++) {
      const entry = manifest.tools[i];
      const candidates = exported.filter(
        proposal => proposal.qualifiedName === entry.qualifiedName,
      );
      const proposal = candidates.find(
        candidate =>
          entry.owner != null &&
          candidate.binding.component === entry.owner.name,
      );
      expect([
        entry.qualifiedName,
        proposal == null ? null : proposal.id,
      ]).toEqual([entry.qualifiedName, expect.any(String)]);
      expect([entry.qualifiedName, entry]).toEqual([
        entry.qualifiedName,
        {
          qualifiedName: proposal.qualifiedName,
          name: proposal.name,
          scopePath: proposal.scopePath,
          description: proposal.description,
          inputSchema: proposal.inputSchema,
          annotations: ANNOTATIONS_BY_SAFETY[proposal.safety],
          safety: proposal.safety,
          lifetime: proposal.lifetime,
          source: SOURCE_BY_BINDING_KIND[proposal.binding.kind],
          owner: {name: proposal.binding.component},
        },
      ]);
    }

    // Every tool the source declares reaches the page. Two components
    // declare `todos_add_todo` on purpose (the registry keeps one record per
    // key), so names are compared as sets.
    const declared = Array.from(
      new Set(exported.map(proposal => proposal.qualifiedName)),
    ).sort();
    const registered = manifest.tools.map(entry => entry.qualifiedName);
    expect(registered).toEqual(declared);
    // The manifest is sorted, the way `yarn validate-tools --update` writes it.
    expect(registered).toEqual(registered.slice().sort());
  });
});
