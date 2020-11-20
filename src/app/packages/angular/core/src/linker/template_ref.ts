/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {R3_TEMPLATE_REF_FACTORY} from '../ivy_switch/runtime/index';

import {ElementRef} from './element_ref';
import {EmbeddedViewRef} from './view_ref';


/**
 * 使用 ViewContainerRef_.createEmbeddedView<C>(templateRef: TemplateRef<C>, context?: C, index?: number): EmbeddedViewRef<C>
 * 来创建 EmbeddedViewRef。
 *
 * Represents an embedded template that can be used to instantiate embedded views.
 * To instantiate embedded views based on a template, use the `ViewContainerRef`
 * method `createEmbeddedView()`.
 *
 * Access a `TemplateRef` instance by placing a directive on an `<ng-template>`
 * element (or directive prefixed with `*`). The `TemplateRef` for the embedded view
 * is injected into the constructor of the directive,
 * using the `TemplateRef` token.
 *
 * You can also use a `Query` to find a `TemplateRef` associated with
 * a component or a directive.
 *
 * @see `ViewContainerRef`
 * @see [Navigate the Component Tree with DI](guide/dependency-injection-navtree)
 *
 */
export abstract class TemplateRef<C> {
  /**
   * The anchor element in the parent view for this embedded view.
   *
   * The data-binding and injection contexts of embedded views created from this `TemplateRef`
   * inherit from the contexts of this location.
   *
   * Typically new embedded views are attached to the view container of this location, but in
   * advanced use-cases, the view can be attached to a different container while keeping the
   * data-binding and injection context from the original location.
   *
   */
  // TODO(i): rename to anchor or location
  abstract get elementRef(): ElementRef;

  /**
   * Creates a view object and attaches it to the view container of the parent view.
   * @param context The context for the new view, inherited from the anchor element.
   * @returns The new view object.
   */
  abstract createEmbeddedView(context: C): EmbeddedViewRef<C>;

  /** @internal */
  static __NG_ELEMENT_ID__:
      () => TemplateRef<any> = () => R3_TEMPLATE_REF_FACTORY(TemplateRef, ElementRef)
}
