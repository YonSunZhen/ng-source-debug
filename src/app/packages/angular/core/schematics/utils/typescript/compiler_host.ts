/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {Tree} from '@angular-devkit/schematics';
import {relative} from 'path';
import * as ts from 'typescript';

export function createMigrationCompilerHost(
    tree: Tree, options: ts.CompilerOptions, basePath: string,
    fakeRead?: (fileName: string) => string | null): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);

  // We need to overwrite the host "readFile" method, as we want the TypeScript
  // program to be based on the file contents in the virtual file tree. Otherwise
  // if we run multiple migrations we might have intersecting changes and
  // source files.
  host.readFile = fileName => {
    const treeRelativePath = relative(basePath, fileName);
    const fakeOutput = fakeRead ? fakeRead(treeRelativePath) : null;
    const buffer = fakeOutput === null ? tree.read(treeRelativePath) : fakeOutput;
    // Strip BOM as otherwise TSC methods (Ex: getWidth) will return an offset,
    // which breaks the CLI UpdateRecorder.
    // See: https://github.com/angular/angular/pull/30719
    return buffer ? buffer.toString().replace(/^\uFEFF/, '') : undefined;
  };

  return host;
}
