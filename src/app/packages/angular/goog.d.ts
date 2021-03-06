/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */


/**
 * Typings for google closure.
 */
declare namespace goog {
  /**
   * Note: Don't use this to check for advanced compilation,
   * as it is sometimes true.
   */
  export const DEBUG: boolean;
  export const getMsg: Function;
  export const LOCALE: any;
}

/**
 * Use this flag to check for advanced compilation.
 */
declare const COMPILED: boolean;
