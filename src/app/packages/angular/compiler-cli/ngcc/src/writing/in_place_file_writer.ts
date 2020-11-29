/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {FileSystem, absoluteFrom, dirname} from '../../../src/ngtsc/file_system';
import {Logger} from '../logging/logger';
import {EntryPointJsonProperty} from '../packages/entry_point';
import {EntryPointBundle} from '../packages/entry_point_bundle';
import {FileToWrite} from '../rendering/utils';
import {FileWriter} from './file_writer';

export const NGCC_BACKUP_EXTENSION = '.__ivy_ngcc_bak';
/**
 * This FileWriter overwrites the transformed file, in-place, while creating
 * a back-up of the original file with an extra `.__ivy_ngcc_bak` extension.
 */
export class InPlaceFileWriter implements FileWriter {
  constructor(
      protected fs: FileSystem, protected logger: Logger,
      protected errorOnFailedEntryPoint: boolean) {}

  writeBundle(
      _bundle: EntryPointBundle, transformedFiles: FileToWrite[],
      _formatProperties?: EntryPointJsonProperty[]) {
    transformedFiles.forEach(file => this.writeFileAndBackup(file));
  }

  protected writeFileAndBackup(file: FileToWrite): void {
    this.fs.ensureDir(dirname(file.path));
    const backPath = absoluteFrom(`${file.path}${NGCC_BACKUP_EXTENSION}`);
    if (this.fs.exists(backPath)) {
      if (this.errorOnFailedEntryPoint) {
        throw new Error(
            `Tried to overwrite ${backPath} with an ngcc back up file, which is disallowed.`);
      } else {
        this.logger.error(
            `Tried to write ${backPath} with an ngcc back up file but it already exists so not writing, nor backing up, ${file.path}.\n` +
            `This error may be because two or more entry-points overlap and ngcc has been asked to process some files more than once.\n` +
            `You should check other entry-points in this package and set up a config to ignore any that you are not using.`);
      }
    } else {
      if (this.fs.exists(file.path)) {
        this.fs.moveFile(file.path, backPath);
      }
      this.fs.writeFile(file.path, file.contents);
    }
  }
}
