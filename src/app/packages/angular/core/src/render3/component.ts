/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

// We are temporarily importing the existing viewEngine from core so we can be sure we are
// correctly implementing its interfaces for backwards compatibility.
import {Type} from '../core';
import {Injector} from '../di/injector';
import {Sanitizer} from '../sanitization/security';

import {PlayerHandler} from './animations/interfaces';
import {assertComponentType, assertDefined} from './assert';
import {getLElementFromComponent, readPatchedLViewData} from './context_discovery';
import {getComponentDef} from './definition';
import {queueInitHooks, queueLifecycleHooks} from './hooks';
import {CLEAN_PROMISE, baseDirectiveCreate, createLViewData, createTView, detectChangesInternal, enterView, executeInitAndContentHooks, hostElement, leaveView, locateHostElement, setHostBindings, queueHostBindingForCheck,} from './instructions';
import {ComponentDef, ComponentDefInternal, ComponentType} from './interfaces/definition';
import {LElementNode} from './interfaces/node';
import {RElement, RendererFactory3, domRendererFactory3} from './interfaces/renderer';
import {CONTEXT, INJECTOR, LViewData, LViewFlags, RootContext, RootContextFlags, TVIEW} from './interfaces/view';
import {getRootView, stringify} from './util';



/** Options that control how the component should be bootstrapped. */
export interface CreateComponentOptions {
  /** Which renderer factory to use. */
  rendererFactory?: RendererFactory3;

  /** A custom sanitizer instance */
  sanitizer?: Sanitizer;

  /** A custom animation player handler */
  playerHandler?: PlayerHandler;

  /**
   * Host element on which the component will be bootstrapped. If not specified,
   * the component definition's `tag` is used to query the existing DOM for the
   * element to bootstrap.
   */
  host?: RElement|string;

  /** Module injector for the component. If unspecified, the injector will be NULL_INJECTOR. */
  injector?: Injector;

  /**
   * List of features to be applied to the created component. Features are simply
   * functions that decorate a component with a certain behavior.
   *
   * Typically, the features in this list are features that cannot be added to the
   * other features list in the component definition because they rely on other factors.
   *
   * Example: `RootLifecycleHooks` is a function that adds lifecycle hook capabilities
   * to root components in a tree-shakable way. It cannot be added to the component
   * features list because there's no way of knowing when the component will be used as
   * a root component.
   */
  hostFeatures?: HostFeature[];

  /**
   * A function which is used to schedule change detection work in the future.
   *
   * When marking components as dirty, it is necessary to schedule the work of
   * change detection in the future. This is done to coalesce multiple
   * {@link markDirty} calls into a single changed detection processing.
   *
   * The default value of the scheduler is the `requestAnimationFrame` function.
   *
   * It is also useful to override this function for testing purposes.
   */
  scheduler?: (work: () => void) => void;
}

/** See CreateComponentOptions.hostFeatures */
type HostFeature = (<T>(component: T, componentDef: ComponentDef<T, string>) => void);

// TODO: A hack to not pull in the NullInjector from @angular/core.
export const NULL_INJECTOR: Injector = {
  get: (token: any, notFoundValue?: any) => {
    throw new Error('NullInjector: Not found: ' + stringify(token));
  }
};

/**
 * Bootstraps a Component into an existing host element and returns an instance
 * of the component.
 *
 * Use this function to bootstrap a component into the DOM tree. Each invocation
 * of this function will create a separate tree of components, injectors and
 * change detection cycles and lifetimes. To dynamically insert a new component
 * into an existing tree such that it shares the same injection, change detection
 * and object lifetime, use {@link ViewContainer#createComponent}.
 *
 * @param componentType Component to bootstrap
 * @param options Optional parameters which control bootstrapping
 */
export function renderComponent<T>(
    componentType: ComponentType<T>|
        Type<T>/* Type as workaround for: Microsoft/TypeScript/issues/4881 */
    ,
    opts: CreateComponentOptions = {}): T {
  ngDevMode && assertComponentType(componentType);
  const rendererFactory = opts.rendererFactory || domRendererFactory3;
  const sanitizer = opts.sanitizer || null;
  const componentDef = getComponentDef<T>(componentType) !;
  if (componentDef.type != componentType) componentDef.type = componentType;

  // The first index of the first selector is the tag name.
  const componentTag = componentDef.selectors ![0] ![0] as string;
  const hostNode = locateHostElement(rendererFactory, opts.host || componentTag);
  const rootFlags = componentDef.onPush ? LViewFlags.Dirty | LViewFlags.IsRoot :
                                          LViewFlags.CheckAlways | LViewFlags.IsRoot;
  const rootContext = createRootContext(
      opts.scheduler || requestAnimationFrame.bind(window), opts.playerHandler || null);

  const rootView: LViewData = createLViewData(
      rendererFactory.createRenderer(hostNode, componentDef),
      createTView(-1, null, 1, 0, null, null, null), rootContext, rootFlags);
  rootView[INJECTOR] = opts.injector || null;

  const oldView = enterView(rootView, null);
  let elementNode: LElementNode;
  let component: T;
  try {
    if (rendererFactory.begin) rendererFactory.begin();

    // Create element node at index 0 in data array
    elementNode = hostElement(componentTag, hostNode, componentDef, sanitizer);
    component = createRootComponent(
        elementNode, componentDef, rootView, rootContext, opts.hostFeatures || null);

    executeInitAndContentHooks();
    detectChangesInternal(elementNode.data as LViewData, component);
  } finally {
    leaveView(oldView);
    if (rendererFactory.end) rendererFactory.end();
  }

  return component;
}

/**
 * Creates a root component and sets it up with features and host bindings. Shared by
 * renderComponent() and ViewContainerRef.createComponent().
 */
export function createRootComponent<T>(
    elementNode: LElementNode, componentDef: ComponentDef<T, string>, rootView: LViewData,
    rootContext: RootContext, hostFeatures: HostFeature[] | null): any {
  // Create directive instance with factory() and store at index 0 in directives array
  const component = baseDirectiveCreate(0, componentDef.factory() as T, componentDef, elementNode);

  if (componentDef.hostBindings) queueHostBindingForCheck(0, componentDef.hostVars);
  rootContext.components.push(component);
  (elementNode.data as LViewData)[CONTEXT] = component;

  hostFeatures && hostFeatures.forEach((feature) => feature(component, componentDef));
  setHostBindings(rootView[TVIEW].hostBindings);
  return component;
}


export function createRootContext(
    scheduler: (workFn: () => void) => void, playerHandler?: PlayerHandler|null): RootContext {
  return {
    components: [],
    scheduler: scheduler,
    clean: CLEAN_PROMISE,
    playerHandler: playerHandler || null,
    flags: RootContextFlags.Empty
  };
}

/**
 * Used to enable lifecycle hooks on the root component.
 *
 * Include this feature when calling `renderComponent` if the root component
 * you are rendering has lifecycle hooks defined. Otherwise, the hooks won't
 * be called properly.
 *
 * Example:
 *
 * ```
 * renderComponent(AppComponent, {features: [RootLifecycleHooks]});
 * ```
 */
export function LifecycleHooksFeature(component: any, def: ComponentDefInternal<any>): void {
  const rootTView = readPatchedLViewData(component) ![TVIEW];

  // Root component is always created at dir index 0
  queueInitHooks(0, def.onInit, def.doCheck, rootTView);
  // Directive starting index 0, directive count 1 -> directive flags: 1
  queueLifecycleHooks(1, rootTView);
}

/**
 * Retrieve the root context for any component by walking the parent `LView` until
 * reaching the root `LView`.
 *
 * @param component any component
 */
function getRootContext(component: any): RootContext {
  const rootContext = getRootView(component)[CONTEXT] as RootContext;
  ngDevMode && assertDefined(rootContext, 'rootContext');
  return rootContext;
}

/**
 * Retrieve the host element of the component.
 *
 * Use this function to retrieve the host element of the component. The host
 * element is the element which the component is associated with.
 *
 * @param component Component for which the host element should be retrieved.
 */
export function getHostElement<T>(component: T): HTMLElement {
  return getLElementFromComponent(component).native as any;
}

/**
 * Retrieves the rendered text for a given component.
 *
 * This function retrieves the host element of a component and
 * and then returns the `textContent` for that element. This implies
 * that the text returned will include re-projected content of
 * the component as well.
 *
 * @param component The component to return the content text for.
 */
export function getRenderedText(component: any): string {
  const hostElement = getHostElement(component);
  return hostElement.textContent || '';
}

/**
 * Wait on component until it is rendered.
 *
 * This function returns a `Promise` which is resolved when the component's
 * change detection is executed. This is determined by finding the scheduler
 * associated with the `component`'s render tree and waiting until the scheduler
 * flushes. If nothing is scheduled, the function returns a resolved promise.
 *
 * Example:
 * ```
 * await whenRendered(myComponent);
 * ```
 *
 * @param component Component to wait upon
 * @returns Promise which resolves when the component is rendered.
 */
export function whenRendered(component: any): Promise<null> {
  return getRootContext(component).clean;
}
