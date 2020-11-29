/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import * as ts from 'typescript';
import {AbsoluteFsPath} from '../../../src/ngtsc/file_system';
import {DependencyHostBase} from './dependency_host';
import {ResolvedDeepImport, ResolvedRelativeModule} from './module_resolver';

/**
 * Helper functions for computing dependencies.
 */
export class EsmDependencyHost extends DependencyHostBase {
  /**
   * Compute the dependencies of the given file.
   *
   * @param file An absolute path to the file whose dependencies we want to get.
   * @param dependencies A set that will have the absolute paths of resolved entry points added to
   * it.
   * @param missing A set that will have the dependencies that could not be found added to it.
   * @param deepImports A set that will have the import paths that exist but cannot be mapped to
   * entry-points, i.e. deep-imports.
   * @param alreadySeen A set that is used to track internal dependencies to prevent getting stuck
   * in a circular dependency loop.
   */
  protected recursivelyCollectDependencies(
      file: AbsoluteFsPath, dependencies: Set<AbsoluteFsPath>, missing: Set<string>,
      deepImports: Set<string>, alreadySeen: Set<AbsoluteFsPath>): void {
    const fromContents = this.fs.readFile(file);

    if (!hasImportOrReexportStatements(fromContents)) {
      // Avoid parsing the source file as there are no imports.
      return;
    }

    // Parse the source into a TypeScript AST and then walk it looking for imports and re-exports.
    const sf =
        ts.createSourceFile(file, fromContents, ts.ScriptTarget.ES2015, false, ts.ScriptKind.JS);
    sf.statements
        // filter out statements that are not imports or reexports
        .filter(isStringImportOrReexport)
        // Grab the id of the module that is being imported
        .map(stmt => stmt.moduleSpecifier.text)
        .forEach(importPath => {
          const resolved =
              this.processImport(importPath, file, dependencies, missing, deepImports, alreadySeen);
          if (!resolved) {
            missing.add(importPath);
          }
        });
  }

  /**
   * Resolve the given `importPath` from `file` and add it to the appropriate set.
   *
   * @returns `true` if the import was resolved (to an entry-point, a local import, or a
   * deep-import).
   */
  protected processImport(
      importPath: string, file: AbsoluteFsPath, dependencies: Set<AbsoluteFsPath>,
      missing: Set<string>, deepImports: Set<string>, alreadySeen: Set<AbsoluteFsPath>): boolean {
    const resolvedModule = this.moduleResolver.resolveModuleImport(importPath, file);
    if (resolvedModule === null) {
      return false;
    }
    if (resolvedModule instanceof ResolvedRelativeModule) {
      const internalDependency = resolvedModule.modulePath;
      if (!alreadySeen.has(internalDependency)) {
        alreadySeen.add(internalDependency);
        this.recursivelyCollectDependencies(
            internalDependency, dependencies, missing, deepImports, alreadySeen);
      }
    } else if (resolvedModule instanceof ResolvedDeepImport) {
      deepImports.add(resolvedModule.importPath);
    } else {
      dependencies.add(resolvedModule.entryPointPath);
    }
    return true;
  }
}

/**
 * Check whether a source file needs to be parsed for imports.
 * This is a performance short-circuit, which saves us from creating
 * a TypeScript AST unnecessarily.
 *
 * @param source The content of the source file to check.
 *
 * @returns false if there are definitely no import or re-export statements
 * in this file, true otherwise.
 */
export function hasImportOrReexportStatements(source: string): boolean {
  return /(import|export)\s.+from/.test(source);
}


/**
 * Check whether the given statement is an import with a string literal module specifier.
 * @param stmt the statement node to check.
 * @returns true if the statement is an import with a string literal module specifier.
 */
export function isStringImportOrReexport(stmt: ts.Statement): stmt is ts.ImportDeclaration&
    {moduleSpecifier: ts.StringLiteral} {
  return ts.isImportDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) && !!stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier);
}
