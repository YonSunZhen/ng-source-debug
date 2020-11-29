/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

/// <reference types="node" />

describe('unlocker', () => {
  it('should attach a handler to the `disconnect` event', () => {
    spyOn(process, 'on');
    require('../../../src/locking/lock_file_with_child_process/unlocker');
    expect(process.on).toHaveBeenCalledWith('disconnect', jasmine.any(Function));
  });
});
