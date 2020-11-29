/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Rule, SchematicContext, SchematicsException, Tree} from '@angular-devkit/schematics';
import {dirname, relative} from 'path';
import * as ts from 'typescript';
import {getProjectTsConfigPaths} from '../../utils/project_tsconfig_paths';
import {createMigrationCompilerHost} from '../../utils/typescript/compiler_host';
import {parseTsconfigFile} from '../../utils/typescript/parse_tsconfig';
import {FALLBACK_DECORATOR, addImport, getNamedImports, getUndecoratedClassesWithDecoratedFields, hasNamedImport} from './utils';


/**
 * Migration that adds an Angular decorator to classes that have Angular field decorators.
 * https://hackmd.io/vuQfavzfRG6KUCtU7oK_EA
 */
export default function(): Rule {
  return (tree: Tree, context: SchematicContext) => {
    const {buildPaths, testPaths} = getProjectTsConfigPaths(tree);
    const basePath = process.cwd();
    const allPaths = [...buildPaths, ...testPaths];

    if (!allPaths.length) {
      throw new SchematicsException(
          'Could not find any tsconfig file. Cannot add an Angular decorator to undecorated classes.');
    }

    for (const tsconfigPath of allPaths) {
      runUndecoratedClassesMigration(tree, tsconfigPath, basePath);
    }
  };
}

function runUndecoratedClassesMigration(tree: Tree, tsconfigPath: string, basePath: string) {
  const parsed = parseTsconfigFile(tsconfigPath, dirname(tsconfigPath));
  const host = createMigrationCompilerHost(tree, parsed.options, basePath);
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const typeChecker = program.getTypeChecker();
  const printer = ts.createPrinter();
  const sourceFiles = program.getSourceFiles().filter(
      file => !file.isDeclarationFile && !program.isSourceFileFromExternalLibrary(file));

  sourceFiles.forEach(sourceFile => {
    const classes = getUndecoratedClassesWithDecoratedFields(sourceFile, typeChecker);

    if (classes.length === 0) {
      return;
    }

    const update = tree.beginUpdate(relative(basePath, sourceFile.fileName));

    classes.forEach((current, index) => {
      // If it's the first class that we're processing in this file, add `Directive` to the imports.
      if (index === 0 && !hasNamedImport(current.importDeclaration, FALLBACK_DECORATOR)) {
        const namedImports = getNamedImports(current.importDeclaration);

        if (namedImports) {
          update.remove(namedImports.getStart(), namedImports.getWidth());
          update.insertRight(
              namedImports.getStart(),
              printer.printNode(
                  ts.EmitHint.Unspecified, addImport(namedImports, FALLBACK_DECORATOR),
                  sourceFile));
        }
      }

      // We don't need to go through the AST to insert the decorator, because the change
      // is pretty basic. Also this has a better chance of preserving the user's formatting.
      update.insertLeft(current.classDeclaration.getStart(), `@${FALLBACK_DECORATOR}()\n`);
    });

    tree.commitUpdate(update);
  });
}
