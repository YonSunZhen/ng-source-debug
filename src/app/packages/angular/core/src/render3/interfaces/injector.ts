/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */


import {ChangeDetectorRef} from '../../change_detection/change_detector_ref';
import {ElementRef} from '../../linker/element_ref';
import {TemplateRef} from '../../linker/template_ref';
import {ViewContainerRef} from '../../linker/view_container_ref';

import {TContainerNode, TElementContainerNode, TElementNode,} from './node';
import {LViewData} from './view';

export interface LInjector {
  /**
   * We need to store a reference to the injector's parent so DI can keep looking up
   * the injector tree until it finds the dependency it's looking for.
   */
  readonly parent: LInjector|null;

  /** Necessary to find directive indices for a particular node and look up the LNode. */
  readonly tNode: TElementNode|TElementContainerNode|TContainerNode;

  /**
   * The view where the node is stored. Necessary because as we traverse up the injector
   * tree the view where we search directives may change.
   */
  readonly view: LViewData;

  /**
   * The following bloom filter determines whether a directive is available
   * on the associated node or not. This prevents us from searching the directives
   * array at this level unless it's probable the directive is in it.
   *
   * - bf0: Check directive IDs 0-31  (IDs are % 128)
   * - bf1: Check directive IDs 32-63
   * - bf2: Check directive IDs 64-95
   * - bf3: Check directive IDs 96-127
   * - bf4: Check directive IDs 128-159
   * - bf5: Check directive IDs 160 - 191
   * - bf6: Check directive IDs 192 - 223
   * - bf7: Check directive IDs 224 - 255
   *
   * See: https://en.wikipedia.org/wiki/Bloom_filter for more about bloom filters.
   */
  bf0: number;
  bf1: number;
  bf2: number;
  bf3: number;
  bf4: number;
  bf5: number;
  bf6: number;
  bf7: number;

  /**
   * cbf0 - cbf7 properties determine whether a directive is available through a
   * parent injector. They refer to the merged values of parent bloom filters. This
   * allows us to skip looking up the chain unless it's probable that directive exists
   * up the chain.
   */
  cbf0: number;
  cbf1: number;
  cbf2: number;
  cbf3: number;
  cbf4: number;
  cbf5: number;
  cbf6: number;
  cbf7: number;
}

// Note: This hack is necessary so we don't erroneously get a circular dependency
// failure based on types.
export const unusedValueExportToPlacateAjd = 1;
