/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {FileSystem, absoluteFrom, getFileSystem} from '@angular/compiler-cli/src/ngtsc/file_system';
import {fromObject} from 'convert-source-map';

import {runInEachFileSystem} from '../../../src/ngtsc/file_system/testing';
import {RawSourceMap} from '../../src/sourcemaps/raw_source_map';
import {SourceFileLoader as SourceFileLoader} from '../../src/sourcemaps/source_file_loader';

runInEachFileSystem(() => {
  describe('SourceFileLoader', () => {
    let fs: FileSystem;
    let _: typeof absoluteFrom;
    let registry: SourceFileLoader;
    beforeEach(() => {
      fs = getFileSystem();
      _ = absoluteFrom;
      registry = new SourceFileLoader(fs);
    });

    describe('loadSourceFile', () => {
      it('should load a file with no source map and inline contents', () => {
        const sourceFile = registry.loadSourceFile(_('/foo/src/index.js'), 'some inline content');
        if (sourceFile === null) {
          return fail('Expected source file to be defined');
        }
        expect(sourceFile.contents).toEqual('some inline content');
        expect(sourceFile.sourcePath).toEqual(_('/foo/src/index.js'));
        expect(sourceFile.rawMap).toEqual(null);
        expect(sourceFile.sources).toEqual([]);
      });

      it('should load a file with no source map and read its contents from disk', () => {
        fs.ensureDir(_('/foo/src'));
        fs.writeFile(_('/foo/src/index.js'), 'some external content');
        const sourceFile = registry.loadSourceFile(_('/foo/src/index.js'));
        if (sourceFile === null) {
          return fail('Expected source file to be defined');
        }
        expect(sourceFile.contents).toEqual('some external content');
        expect(sourceFile.sourcePath).toEqual(_('/foo/src/index.js'));
        expect(sourceFile.rawMap).toEqual(null);
        expect(sourceFile.sources).toEqual([]);
      });

      it('should load a file with an external source map', () => {
        fs.ensureDir(_('/foo/src'));
        const sourceMap = createRawSourceMap({file: 'index.js'});
        fs.writeFile(_('/foo/src/external.js.map'), JSON.stringify(sourceMap));
        const sourceFile = registry.loadSourceFile(
            _('/foo/src/index.js'), 'some inline content\n//# sourceMappingURL=external.js.map');
        if (sourceFile === null) {
          return fail('Expected source file to be defined');
        }
        expect(sourceFile.rawMap).toEqual(sourceMap);
      });

      it('should handle a missing external source map', () => {
        fs.ensureDir(_('/foo/src'));
        const sourceFile = registry.loadSourceFile(
            _('/foo/src/index.js'), 'some inline content\n//# sourceMappingURL=external.js.map');
        if (sourceFile === null) {
          return fail('Expected source file to be defined');
        }
        expect(sourceFile.rawMap).toBe(null);
      });

      it('should load a file with an inline encoded source map', () => {
        const sourceMap = createRawSourceMap({file: 'index.js'});
        const encodedSourceMap = Buffer.from(JSON.stringify(sourceMap)).toString('base64');
        const sourceFile = registry.loadSourceFile(
            _('/foo/src/index.js'),
            `some inline content\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${encodedSourceMap}`);
        if (sourceFile === null) {
          return fail('Expected source file to be defined');
        }
        expect(sourceFile.rawMap).toEqual(sourceMap);
      });

      it('should load a file with an implied source map', () => {
        const sourceMap = createRawSourceMap({file: 'index.js'});
        fs.ensureDir(_('/foo/src'));
        fs.writeFile(_('/foo/src/index.js.map'), JSON.stringify(sourceMap));
        const sourceFile = registry.loadSourceFile(_('/foo/src/index.js'), 'some inline content');
        if (sourceFile === null) {
          return fail('Expected source file to be defined');
        }
        expect(sourceFile.rawMap).toEqual(sourceMap);
      });

      it('should handle missing implied source-map file', () => {
        fs.ensureDir(_('/foo/src'));
        const sourceFile = registry.loadSourceFile(_('/foo/src/index.js'), 'some inline content');
        if (sourceFile === null) {
          return fail('Expected source file to be defined');
        }
        expect(sourceFile.rawMap).toBe(null);
      });

      it('should recurse into external original source files that are referenced from source maps',
         () => {
           // Setup a scenario where the generated files reference previous files:
           //
           // index.js
           //  -> x.js
           //  -> y.js
           //       -> a.js
           //  -> z.js (inline content)
           fs.ensureDir(_('/foo/src'));

           const indexSourceMap = createRawSourceMap({
             file: 'index.js',
             sources: ['x.js', 'y.js', 'z.js'],
             'sourcesContent': [null, null, 'z content']
           });
           fs.writeFile(_('/foo/src/index.js.map'), JSON.stringify(indexSourceMap));

           fs.writeFile(_('/foo/src/x.js'), 'x content');

           const ySourceMap = createRawSourceMap({file: 'y.js', sources: ['a.js']});
           fs.writeFile(_('/foo/src/y.js'), 'y content');
           fs.writeFile(_('/foo/src/y.js.map'), JSON.stringify(ySourceMap));
           fs.writeFile(_('/foo/src/z.js'), 'z content');
           fs.writeFile(_('/foo/src/a.js'), 'a content');

           const sourceFile = registry.loadSourceFile(_('/foo/src/index.js'), 'index content');
           if (sourceFile === null) {
             return fail('Expected source file to be defined');
           }

           expect(sourceFile.contents).toEqual('index content');
           expect(sourceFile.sourcePath).toEqual(_('/foo/src/index.js'));
           expect(sourceFile.rawMap).toEqual(indexSourceMap);

           expect(sourceFile.sources.length).toEqual(3);

           expect(sourceFile.sources[0] !.contents).toEqual('x content');
           expect(sourceFile.sources[0] !.sourcePath).toEqual(_('/foo/src/x.js'));
           expect(sourceFile.sources[0] !.rawMap).toEqual(null);
           expect(sourceFile.sources[0] !.sources).toEqual([]);


           expect(sourceFile.sources[1] !.contents).toEqual('y content');
           expect(sourceFile.sources[1] !.sourcePath).toEqual(_('/foo/src/y.js'));
           expect(sourceFile.sources[1] !.rawMap).toEqual(ySourceMap);

           expect(sourceFile.sources[1] !.sources.length).toEqual(1);
           expect(sourceFile.sources[1] !.sources[0] !.contents).toEqual('a content');
           expect(sourceFile.sources[1] !.sources[0] !.sourcePath).toEqual(_('/foo/src/a.js'));
           expect(sourceFile.sources[1] !.sources[0] !.rawMap).toEqual(null);
           expect(sourceFile.sources[1] !.sources[0] !.sources).toEqual([]);

           expect(sourceFile.sources[2] !.contents).toEqual('z content');
           expect(sourceFile.sources[2] !.sourcePath).toEqual(_('/foo/src/z.js'));
           expect(sourceFile.sources[2] !.rawMap).toEqual(null);
           expect(sourceFile.sources[2] !.sources).toEqual([]);
         });

      it('should handle a missing source file referenced from a source-map', () => {
        fs.ensureDir(_('/foo/src'));

        const indexSourceMap =
            createRawSourceMap({file: 'index.js', sources: ['x.js'], 'sourcesContent': [null]});
        fs.writeFile(_('/foo/src/index.js.map'), JSON.stringify(indexSourceMap));

        const sourceFile = registry.loadSourceFile(_('/foo/src/index.js'), 'index content');
        if (sourceFile === null) {
          return fail('Expected source file to be defined');
        }

        expect(sourceFile.contents).toEqual('index content');
        expect(sourceFile.sourcePath).toEqual(_('/foo/src/index.js'));
        expect(sourceFile.rawMap).toEqual(indexSourceMap);
        expect(sourceFile.sources.length).toEqual(1);
        expect(sourceFile.sources[0]).toBe(null);
      });
    });

    it('should fail if there is a cyclic dependency in files loaded from disk', () => {
      fs.ensureDir(_('/foo/src'));

      const aPath = _('/foo/src/a.js');
      fs.writeFile(
          aPath, 'a content\n' +
              fromObject(createRawSourceMap({file: 'a.js', sources: ['b.js']})).toComment());

      const bPath = _('/foo/src/b.js');
      fs.writeFile(
          bPath, 'b content\n' +
              fromObject(createRawSourceMap({file: 'b.js', sources: ['c.js']})).toComment());

      const cPath = _('/foo/src/c.js');
      fs.writeFile(
          cPath, 'c content\n' +
              fromObject(createRawSourceMap({file: 'c.js', sources: ['a.js']})).toComment());

      expect(() => registry.loadSourceFile(aPath))
          .toThrowError(
              `Circular source file mapping dependency: ${aPath} -> ${bPath} -> ${cPath} -> ${aPath}`);
    });

    it('should not fail if there is a cyclic dependency in filenames of inline sources', () => {
      fs.ensureDir(_('/foo/src'));

      const aPath = _('/foo/src/a.js');
      fs.writeFile(
          aPath, 'a content\n' +
              fromObject(createRawSourceMap({file: 'a.js', sources: ['b.js']})).toComment());

      const bPath = _('/foo/src/b.js');
      fs.writeFile(bPath, 'b content');
      fs.writeFile(
          _('/foo/src/b.js.map'),
          JSON.stringify(createRawSourceMap({file: 'b.js', sources: ['c.js']})));

      const cPath = _('/foo/src/c.js');
      fs.writeFile(cPath, 'c content');
      fs.writeFile(
          _('/foo/src/c.js.map'),
          JSON.stringify(createRawSourceMap(
              {file: 'c.js', sources: ['a.js'], sourcesContent: ['inline a.js content']})));

      expect(() => registry.loadSourceFile(aPath)).not.toThrow();
    });
  });
});


function createRawSourceMap(custom: Partial<RawSourceMap>): RawSourceMap {
  return {
    'version': 3,
    'sourceRoot': '',
    'sources': [],
    'sourcesContent': [],
    'names': [],
    'mappings': '', ...custom
  };
}