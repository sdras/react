/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// react-webmcp/babel: the build-time opt-out from the proposal.
//
// Exposing a tool surface to agents should be a deliberate choice, so a
// project opts in with `"webmcp": {"enabled": true}` (or `"webmcp": true`) in
// its package.json. Until it does, this plugin points every import of
// 'react-webmcp' and 'react-webmcp/unstable_review' at
// 'react-webmcp/unstable_noop', whose exports do nothing, which keeps the
// registry, the renderer and the overlay out of the bundle. App code keeps
// compiling and running unchanged.
//
// Options: `enabled` (boolean) overrides package.json; `root` is the directory
// whose package.json to read instead of walking up from each file.

import * as fs from 'fs';
import * as path from 'path';

const REWRITTEN_SOURCES = ['react-webmcp', 'react-webmcp/unstable_review'];
const NOOP_SOURCE = 'react-webmcp/unstable_noop';

// The hook path ships in react-dom. Without the opt-in, named imports of
// these move to the no-op module too (the rest of the import stays on
// react-dom), so a tool declared through react-dom registers nothing either.
// A namespace import or a `require('react-dom')` member access is left alone.
const REACT_DOM_SOURCE = 'react-dom';
const REACT_DOM_WEBMCP_EXPORTS = [
  'unstable_useWebMCPTool',
  'unstable_WebMCPScope',
  'unstable_getWebMCPTools',
  'unstable_subscribeToWebMCPTools',
];

export type ReactWebMCPBabelPluginOptions = {
  enabled?: boolean,
  root?: string,
};

type BabelFile = {
  opts: {filename?: ?string, ...},
  ...
};

type PluginState = {
  filename?: ?string,
  file: BabelFile,
  ...
};

function readPackageFlag(packageJsonPath: string): boolean | null {
  let json: any;
  try {
    json = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    return null;
  }
  if (json == null || typeof json !== 'object') {
    return null;
  }
  const flag = json.webmcp;
  if (flag === undefined) {
    return null;
  }
  if (typeof flag === 'boolean') {
    return flag;
  }
  if (flag != null && typeof flag === 'object') {
    return flag.enabled === true;
  }
  return false;
}

// Walks up from `startDir` to the nearest package.json that mentions webmcp.
// A package.json without the field does not end the walk, so a workspace can
// opt in once at its root. Defaults to false: WebMCP is opt-in.
export function isWebMCPEnabledFor(
  startDir: string,
  cache: Map<string, boolean>,
): boolean {
  const cached = cache.get(startDir);
  if (cached !== undefined) {
    return cached;
  }
  let dir = startDir;
  let result = false;
  while (true) {
    const flag = readPackageFlag(path.join(dir, 'package.json'));
    if (flag !== null) {
      result = flag;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  cache.set(startDir, result);
  return result;
}

export default function ReactWebMCPBabelPlugin(
  babel: any,
  options?: ReactWebMCPBabelPluginOptions,
): any {
  const t = babel.types;
  const pluginOptions: ReactWebMCPBabelPluginOptions =
    options != null ? options : {};
  // Babel keeps one plugin instance for a whole build, so the package.json
  // lookup is cached per file (see `pre`), not for the life of the process:
  // a file sees the flag as it is when that file compiles.
  let cache: Map<string, boolean> = new Map();

  function isEnabled(state: PluginState): boolean {
    if (typeof pluginOptions.enabled === 'boolean') {
      return pluginOptions.enabled;
    }
    const filename =
      state.filename != null ? state.filename : state.file.opts.filename;
    const startDir =
      pluginOptions.root != null
        ? pluginOptions.root
        : filename != null && filename !== ''
          ? path.dirname(path.resolve(filename))
          : process.cwd();
    return isWebMCPEnabledFor(startDir, cache);
  }

  function shouldRewrite(source: mixed): boolean {
    return (
      typeof source === 'string' && REWRITTEN_SOURCES.indexOf(source) !== -1
    );
  }

  // The name a specifier takes from the module: `imported` for an import,
  // `local` for a re-export. Type-only specifiers are left where they are.
  function webMCPNameOf(specifier: any): string | null {
    if (specifier.importKind === 'type' || specifier.exportKind === 'type') {
      return null;
    }
    let node;
    if (specifier.type === 'ImportSpecifier') {
      node = specifier.imported;
    } else if (specifier.type === 'ExportSpecifier') {
      node = specifier.local;
    } else {
      return null;
    }
    const name = node.type === 'StringLiteral' ? node.value : node.name;
    return REACT_DOM_WEBMCP_EXPORTS.indexOf(name) !== -1 ? name : null;
  }

  // Splits the WebMCP names out of a react-dom import or re-export into a
  // sibling declaration from the no-op module. Returns false when there is
  // nothing to move.
  function splitReactDOMDeclaration(
    nodePath: any,
    build: (specifiers: Array<any>) => any,
  ): boolean {
    const node = nodePath.node;
    const moved = [];
    const kept = [];
    for (let i = 0; i < node.specifiers.length; i++) {
      const specifier = node.specifiers[i];
      if (webMCPNameOf(specifier) !== null) {
        moved.push(specifier);
      } else {
        kept.push(specifier);
      }
    }
    if (moved.length === 0) {
      return false;
    }
    const replacement = build(moved);
    if (kept.length === 0) {
      nodePath.replaceWith(replacement);
    } else {
      node.specifiers = kept;
      nodePath.insertAfter(replacement);
    }
    return true;
  }

  return {
    name: 'react-webmcp',
    pre() {
      cache = new Map();
    },
    visitor: {
      ImportDeclaration(nodePath: any, state: PluginState) {
        const node = nodePath.node;
        if (shouldRewrite(node.source.value)) {
          if (!isEnabled(state)) {
            node.source = t.stringLiteral(NOOP_SOURCE);
          }
          return;
        }
        if (
          node.source.value === REACT_DOM_SOURCE &&
          node.importKind !== 'type' &&
          node.importKind !== 'typeof' &&
          !isEnabled(state)
        ) {
          splitReactDOMDeclaration(nodePath, specifiers =>
            t.importDeclaration(specifiers, t.stringLiteral(NOOP_SOURCE)),
          );
        }
      },
      ExportNamedDeclaration(nodePath: any, state: PluginState) {
        const node = nodePath.node;
        const source = node.source;
        if (source == null) {
          return;
        }
        if (shouldRewrite(source.value)) {
          if (!isEnabled(state)) {
            node.source = t.stringLiteral(NOOP_SOURCE);
          }
          return;
        }
        if (
          source.value === REACT_DOM_SOURCE &&
          node.exportKind !== 'type' &&
          !isEnabled(state)
        ) {
          splitReactDOMDeclaration(nodePath, specifiers =>
            t.exportNamedDeclaration(
              null,
              specifiers,
              t.stringLiteral(NOOP_SOURCE),
            ),
          );
        }
      },
      ExportAllDeclaration(nodePath: any, state: PluginState) {
        if (shouldRewrite(nodePath.node.source.value) && !isEnabled(state)) {
          nodePath.node.source = t.stringLiteral(NOOP_SOURCE);
        }
      },
      CallExpression(nodePath: any, state: PluginState) {
        const node = nodePath.node;
        const callee = node.callee;
        const isRequire =
          callee.type === 'Identifier' &&
          callee.name === 'require' &&
          nodePath.scope.getBinding('require') == null;
        const isDynamicImport = callee.type === 'Import';
        if (!isRequire && !isDynamicImport) {
          return;
        }
        const argument = node.arguments[0];
        if (
          argument != null &&
          argument.type === 'StringLiteral' &&
          shouldRewrite(argument.value) &&
          !isEnabled(state)
        ) {
          node.arguments[0] = t.stringLiteral(NOOP_SOURCE);
        }
      },
    },
  };
}
