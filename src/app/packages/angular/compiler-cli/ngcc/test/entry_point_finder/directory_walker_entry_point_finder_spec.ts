/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {AbsoluteFsPath, FileSystem, absoluteFrom, getFileSystem, relative} from '../../../src/ngtsc/file_system';
import {TestFile, runInEachFileSystem} from '../../../src/ngtsc/file_system/testing';
import {loadTestFiles} from '../../../test/helpers';
import {DependencyResolver} from '../../src/dependencies/dependency_resolver';
import {DtsDependencyHost} from '../../src/dependencies/dts_dependency_host';
import {EsmDependencyHost} from '../../src/dependencies/esm_dependency_host';
import {ModuleResolver} from '../../src/dependencies/module_resolver';
import {DirectoryWalkerEntryPointFinder} from '../../src/entry_point_finder/directory_walker_entry_point_finder';
import {NgccConfiguration} from '../../src/packages/configuration';
import {EntryPoint} from '../../src/packages/entry_point';
import {EntryPointManifest, EntryPointManifestFile} from '../../src/packages/entry_point_manifest';
import {PathMappings} from '../../src/utils';
import {MockLogger} from '../helpers/mock_logger';

runInEachFileSystem(() => {
  describe('DirectoryWalkerEntryPointFinder', () => {
    let fs: FileSystem;
    let resolver: DependencyResolver;
    let logger: MockLogger;
    let config: NgccConfiguration;
    let manifest: EntryPointManifest;
    let _Abs: typeof absoluteFrom;

    beforeEach(() => {
      fs = getFileSystem();
      _Abs = absoluteFrom;
      logger = new MockLogger();
      const srcHost = new EsmDependencyHost(fs, new ModuleResolver(fs));
      const dtsHost = new DtsDependencyHost(fs);
      config = new NgccConfiguration(fs, _Abs('/'));
      resolver = new DependencyResolver(fs, logger, config, {esm2015: srcHost}, dtsHost);
      manifest = new EntryPointManifest(fs, config, logger);
    });

    describe('findEntryPoints()', () => {
      it('should find sub-entry-points within a package', () => {
        const basePath = _Abs('/sub_entry_points/node_modules');
        loadTestFiles([
          ...createPackage(basePath, 'common'),
          ...createPackage(fs.resolve(basePath, 'common'), 'http', ['common']),
          ...createPackage(
              fs.resolve(basePath, 'common/http'), 'testing', ['common/http', 'common/testing']),
          ...createPackage(fs.resolve(basePath, 'common'), 'testing', ['common']),
        ]);
        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, basePath, undefined);
        const {entryPoints} = finder.findEntryPoints();
        expect(dumpEntryPointPaths(basePath, entryPoints)).toEqual([
          ['common', 'common'],
          ['common', 'common/http'],
          ['common', 'common/testing'],
          ['common', 'common/http/testing'],
        ]);
      });

      it('should find packages inside a namespace', () => {
        const basePath = _Abs('/namespaced/node_modules');
        loadTestFiles([
          ...createPackage(fs.resolve(basePath, '@angular'), 'common'),
          ...createPackage(fs.resolve(basePath, '@angular/common'), 'http', ['@angular/common']),
          ...createPackage(
              fs.resolve(basePath, '@angular/common/http'), 'testing',
              ['@angular/common/http', '@angular/common/testing']),
          ...createPackage(fs.resolve(basePath, '@angular/common'), 'testing', ['@angular/common']),
        ]);
        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, basePath, undefined);
        const {entryPoints} = finder.findEntryPoints();
        expect(dumpEntryPointPaths(basePath, entryPoints)).toEqual([
          ['@angular/common', '@angular/common'],
          ['@angular/common', '@angular/common/http'],
          ['@angular/common', '@angular/common/testing'],
          ['@angular/common', '@angular/common/http/testing'],
        ]);
      });

      it('should return an empty array if there are no packages', () => {
        fs.ensureDir(_Abs('/no_packages/node_modules/should_not_be_found'));
        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, _Abs('/no_packages/node_modules'), undefined);
        const {entryPoints} = finder.findEntryPoints();
        expect(entryPoints).toEqual([]);
      });

      it('should return an empty array if there are no valid entry-points', () => {
        loadTestFiles([
          {
            name: _Abs('/no_valid_entry_points/node_modules/some_package/package.json'),
            contents: '{}'
          },
        ]);
        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, _Abs('/no_valid_entry_points/node_modules'),
            undefined);
        const {entryPoints} = finder.findEntryPoints();
        expect(entryPoints).toEqual([]);
      });

      it('should write an entry-point manifest file if none was found', () => {
        const basePath = _Abs('/sub_entry_points/node_modules');
        loadTestFiles([
          ...createPackage(basePath, 'common'),
          ...createPackage(fs.resolve(basePath, 'common'), 'http', ['common']),
          ...createPackage(
              fs.resolve(basePath, 'common/http'), 'testing', ['common/http', 'common/testing']),
          ...createPackage(fs.resolve(basePath, 'common'), 'testing', ['common']),
          {name: _Abs('/sub_entry_points/yarn.lock'), contents: 'MOCM LOCK FILE'},
        ]);
        spyOn(manifest, 'readEntryPointsUsingManifest').and.callThrough();
        spyOn(manifest, 'writeEntryPointManifest').and.callThrough();
        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, basePath, undefined);
        finder.findEntryPoints();
        expect(manifest.readEntryPointsUsingManifest).toHaveBeenCalled();
        expect(manifest.writeEntryPointManifest).toHaveBeenCalled();
        expect(fs.exists(_Abs('/sub_entry_points/node_modules/__ngcc_entry_points__.json')))
            .toBe(true);
      });

      it('should read from the entry-point manifest file if found', () => {
        const basePath = _Abs('/sub_entry_points/node_modules');
        loadTestFiles([
          ...createPackage(basePath, 'common'),
          ...createPackage(fs.resolve(basePath, 'common'), 'http', ['common']),
          ...createPackage(
              fs.resolve(basePath, 'common/http'), 'testing', ['common/http', 'common/testing']),
          ...createPackage(fs.resolve(basePath, 'common'), 'testing', ['common']),
          {name: _Abs('/sub_entry_points/yarn.lock'), contents: 'MOCM LOCK FILE'},
        ]);
        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, basePath, undefined);

        // Prime the manifest by calling findEntryPoints() once.
        finder.findEntryPoints();

        // Modify the manifest to prove that we use it to find the entry-points
        const manifestPath = _Abs('/sub_entry_points/node_modules/__ngcc_entry_points__.json');
        const manifestFile: EntryPointManifestFile = JSON.parse(fs.readFile(manifestPath));
        manifestFile.entryPointPaths.pop();
        fs.writeFile(manifestPath, JSON.stringify(manifestFile));

        // Now see if the manifest is read on a second call.
        spyOn(manifest, 'readEntryPointsUsingManifest').and.callThrough();
        spyOn(manifest, 'writeEntryPointManifest').and.callThrough();
        const {entryPoints} = finder.findEntryPoints();
        expect(manifest.readEntryPointsUsingManifest).toHaveBeenCalled();
        expect(manifest.writeEntryPointManifest).not.toHaveBeenCalled();
        expect(dumpEntryPointPaths(basePath, entryPoints)).toEqual([
          ['common', 'common'],
          ['common', 'common/http'],
          ['common', 'common/http/testing'],
        ]);
      });

      it('should ignore folders starting with .', () => {
        loadTestFiles([
          ...createPackage(_Abs('/dotted_folders/node_modules/'), '.common'),
        ]);
        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, _Abs('/dotted_folders/node_modules'),
            undefined);
        const {entryPoints} = finder.findEntryPoints();
        expect(entryPoints).toEqual([]);
      });

      it('should ignore folders that are symlinked', () => {
        fs.ensureDir(_Abs('/symlinked_folders/node_modules'));
        fs.symlink(
            _Abs('/external/node_modules/common'), _Abs('/symlinked_folders/node_modules/common'));
        loadTestFiles(createPackage(_Abs('/external/node_modules'), 'common'));
        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, _Abs('/symlinked_folders/node_modules'),
            undefined);
        const {entryPoints} = finder.findEntryPoints();
        expect(entryPoints).toEqual([]);
      });

      it('should handle nested node_modules folders', () => {
        loadTestFiles([
          ...createPackage(_Abs('/nested_node_modules/node_modules'), 'outer', ['inner']),
          ...createPackage(_Abs('/nested_node_modules/node_modules/outer/node_modules'), 'inner'),
        ]);
        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, _Abs('/nested_node_modules/node_modules'),
            undefined);
        const {entryPoints} = finder.findEntryPoints();
        // Note that the `inner` entry-point is not part of the `outer` package
        expect(dumpEntryPointPaths(_Abs('/nested_node_modules/node_modules'), entryPoints))
            .toEqual([
              ['outer/node_modules/inner', 'outer/node_modules/inner'],
              ['outer', 'outer'],
            ]);
      });

      it('should not try to process nested node_modules of non Angular packages', () => {
        const basePath = _Abs('/nested_node_modules/node_modules');
        loadTestFiles([
          ...createPackage(basePath, 'outer', ['inner'], false),
          ...createPackage(_Abs(`${basePath}/outer/node_modules`), 'inner', undefined, false),
        ]);

        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, _Abs('/nested_node_modules/node_modules'),
            undefined);
        const spy = spyOn(finder, 'walkDirectoryForEntryPoints').and.callThrough();
        const {entryPoints} = finder.findEntryPoints();
        expect(spy.calls.allArgs()).toEqual([
          [_Abs(basePath)],
          [_Abs(`${basePath}/outer`)],
        ]);

        expect(entryPoints).toEqual([]);
      });

      it('should not try to process deeply nested folders of non TypeScript packages', () => {
        const basePath = _Abs('/namespaced/node_modules');
        loadTestFiles([
          ...createNonTsPackage(_Abs(`${basePath}/@schematics`), 'angular'),
          {
            name: _Abs(`${basePath}/@schematics/angular/src/nested/index.js`),
            contents: 'index',
          },
        ]);

        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, basePath, undefined);
        const spy = spyOn(finder, 'walkDirectoryForEntryPoints').and.callThrough();
        const {entryPoints} = finder.findEntryPoints();
        expect(spy.calls.allArgs()).toEqual([
          [_Abs(basePath)],
          [_Abs(`${basePath}/@schematics`)],
          [_Abs(`${basePath}/@schematics/angular`)],
        ]);

        expect(entryPoints).toEqual([]);
      });

      it('should not try to process nested node_modules of non TypeScript packages', () => {
        const basePath = _Abs('/namespaced/node_modules');
        loadTestFiles([
          ...createNonTsPackage(_Abs(`${basePath}/@schematics`), 'angular'),
          ...createNonTsPackage(_Abs(`${basePath}/@schematics/angular/node_modules`), 'test'),
          {
            name: _Abs(`${basePath}/@schematics/angular/src/nested/index.js`),
            contents: 'index',
          },
        ]);

        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, basePath, undefined);
        const spy = spyOn(finder, 'walkDirectoryForEntryPoints').and.callThrough();
        const {entryPoints} = finder.findEntryPoints();
        expect(spy.calls.allArgs()).toEqual([
          [_Abs(basePath)],
          [_Abs(`${basePath}/@schematics`)],
          [_Abs(`${basePath}/@schematics/angular`)],
        ]);

        expect(entryPoints).toEqual([]);
      });

      it('should handle dependencies via pathMappings', () => {
        const basePath = _Abs('/path_mapped/node_modules');
        const pathMappings: PathMappings = {
          baseUrl: '/path_mapped/dist',
          paths: {
            '@x/*': ['*'],
            '@y/*/test': ['lib/*/test'],
          }
        };
        loadTestFiles([
          ...createPackage(
              _Abs('/path_mapped/node_modules'), 'test', ['pkg1', '@x/pkg2', '@y/pkg3/test']),
          ...createPackage(_Abs('/path_mapped/node_modules'), 'pkg1'),
          ...createPackage(_Abs('/path_mapped/dist'), 'pkg2', ['pkg4']),
          ...createPackage(_Abs('/path_mapped/dist/pkg2/node_modules'), 'pkg4'),
          ...createPackage(_Abs('/path_mapped/dist/lib/pkg3'), 'test'),
        ]);
        const srcHost = new EsmDependencyHost(fs, new ModuleResolver(fs, pathMappings));
        const dtsHost = new DtsDependencyHost(fs, pathMappings);
        resolver = new DependencyResolver(fs, logger, config, {esm2015: srcHost}, dtsHost);
        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, basePath, pathMappings);
        const {entryPoints} = finder.findEntryPoints();
        expect(dumpEntryPointPaths(basePath, entryPoints)).toEqual([
          ['pkg1', 'pkg1'],
          ['../dist/pkg2/node_modules/pkg4', '../dist/pkg2/node_modules/pkg4'],
          ['../dist/pkg2', '../dist/pkg2'],
          ['../dist/lib/pkg3/test', '../dist/lib/pkg3/test'],
          ['test', 'test'],
        ]);
      });

      it('should handle pathMappings that map to files or non-existent directories', () => {
        const basePath = _Abs('/path_mapped/node_modules');
        const pathMappings: PathMappings = {
          baseUrl: '/path_mapped/dist',
          paths: {
            '@test': ['pkg2/fesm2015/pkg2.js'],
            '@missing': ['pkg3'],
          }
        };
        loadTestFiles([
          ...createPackage(_Abs('/path_mapped/node_modules'), 'test', []),
          ...createPackage(_Abs('/path_mapped/dist'), 'pkg2'),
        ]);
        const srcHost = new EsmDependencyHost(fs, new ModuleResolver(fs, pathMappings));
        const dtsHost = new DtsDependencyHost(fs, pathMappings);
        resolver = new DependencyResolver(fs, logger, config, {esm2015: srcHost}, dtsHost);
        const finder = new DirectoryWalkerEntryPointFinder(
            fs, config, logger, resolver, manifest, basePath, pathMappings);
        const {entryPoints} = finder.findEntryPoints();
        expect(dumpEntryPointPaths(basePath, entryPoints)).toEqual([
          ['test', 'test'],
          ['../dist/pkg2', '../dist/pkg2'],
        ]);
      });

      function createPackage(
          basePath: AbsoluteFsPath, packageName: string, deps: string[] = [],
          isCompiledByAngular = true): TestFile[] {
        const files: TestFile[] = [
          {
            name: _Abs(`${basePath}/${packageName}/package.json`),
            contents: JSON.stringify({
              typings: `./${packageName}.d.ts`,
              fesm2015: `./fesm2015/${packageName}.js`,
            })
          },
          {
            name: _Abs(`${basePath}/${packageName}/fesm2015/${packageName}.js`),
            contents: deps.map((dep, i) => `import * as i${i} from '${dep}';`).join('\n'),
          },
        ];

        if (isCompiledByAngular) {
          files.push({
            name: _Abs(`${basePath}/${packageName}/${packageName}.metadata.json`),
            contents: 'metadata info'
          });
        }

        return files;
      }

      function createNonTsPackage(
          basePath: AbsoluteFsPath, packageName: string, deps: string[] = []): TestFile[] {
        return [
          {
            name: _Abs(`${basePath}/${packageName}/package.json`),
            contents: JSON.stringify({
              fesm2015: `./fesm2015/${packageName}.js`,
            })
          },
          {
            name: _Abs(`${basePath}/${packageName}/fesm2015/${packageName}.js`),
            contents: deps.map((dep, i) => `import * as i${i} from '${dep}';`).join('\n'),
          },
        ];
      }

      function dumpEntryPointPaths(
          basePath: AbsoluteFsPath, entryPoints: EntryPoint[]): [string, string][] {
        return entryPoints.map(x => [relative(basePath, x.package), relative(basePath, x.path)]);
      }
    });
  });
});
