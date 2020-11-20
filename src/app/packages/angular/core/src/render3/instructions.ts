/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import './ng_dev_mode';

import {QueryList} from '../linker';
import {Sanitizer} from '../sanitization/security';
import {StyleSanitizeFn} from '../sanitization/style_sanitizer';
import {assertDefined, assertEqual, assertLessThan, assertNotEqual} from './assert';
import {attachPatchData, getLElementFromComponent, readElementValue, readPatchedLViewData} from './context_discovery';
import {getRootView} from './discovery_utils';
import {throwCyclicDependencyError, throwErrorIfNoChangesMode, throwMultipleComponentError} from './errors';
import {executeHooks, executeInitHooks, queueInitHooks, queueLifecycleHooks} from './hooks';
import {ACTIVE_INDEX, LContainer, RENDER_PARENT, VIEWS} from './interfaces/container';
import {ComponentDefInternal, ComponentQuery, ComponentTemplate, DirectiveDefInternal, DirectiveDefListOrFactory, InitialStylingFlags, PipeDefListOrFactory, RenderFlags} from './interfaces/definition';
import {LInjector} from './interfaces/injector';
import {AttributeMarker, InitialInputData, InitialInputs, LContainerNode, LElementContainerNode, LElementNode, LNode, LProjectionNode, LTextNode, LViewNode, LocalRefExtractor, PropertyAliasValue, PropertyAliases, TAttributes, TContainerNode, TElementContainerNode, TElementNode, TNode, TNodeFlags, TNodeType, TProjectionNode, TViewNode} from './interfaces/node';
import {CssSelectorList, NG_PROJECT_AS_ATTR_NAME} from './interfaces/projection';
import {LQueries} from './interfaces/query';
import {ProceduralRenderer3, RComment, RElement, RNode, RText, Renderer3, RendererFactory3, isProceduralRenderer} from './interfaces/renderer';
import {BINDING_INDEX, CLEANUP, CONTAINER_INDEX, CONTENT_QUERIES, CONTEXT, CurrentMatchesList, DECLARATION_VIEW, DIRECTIVES, FLAGS, HEADER_OFFSET, HOST_NODE, INJECTOR, LViewData, LViewFlags, NEXT, OpaqueViewState, PARENT, QUERIES, RENDERER, RootContext, RootContextFlags, SANITIZER, TAIL, TVIEW, TView} from './interfaces/view';
import {assertNodeOfPossibleTypes, assertNodeType} from './node_assert';
import {appendChild, appendProjectedNode, createTextNode, findComponentView, getContainerNode, getHostElementNode, getLViewChild, getParentOrContainerNode, getRenderParent, insertView, removeView} from './node_manipulation';
import {isNodeMatchingSelectorList, matchingSelectorIndex} from './node_selector_matcher';
import {StylingContext, allocStylingContext, createStylingContextTemplate, renderStyling as renderElementStyles, updateClassProp as updateElementClassProp, updateStyleProp as updateElementStyleProp, updateStylingMap} from './styling';
import {assertDataInRangeInternal, getLNode, isContentQueryHost, isDifferent, loadElementInternal, loadInternal, stringify} from './util';

/**
 * A permanent marker promise which signifies that the current CD tree is
 * clean.
 */
const _CLEAN_PROMISE = Promise.resolve(null);

/**
 * Function used to sanitize the value before writing it into the renderer.
 */
export type SanitizerFn = (value: any) => string;

/**
 * TView.data needs to fill the same number of slots as the LViewData header
 * so the indices of nodes are consistent between LViewData and TView.data.
 *
 * It's much faster to keep a blueprint of the pre-filled array and slice it
 * than it is to create a new array and fill it each time a TView is created.
 */
const HEADER_FILLER = new Array(HEADER_OFFSET).fill(null);

/**
 * Token set in currentMatches while dependencies are being resolved.
 *
 * If we visit a directive that has a value set to CIRCULAR, we know we've
 * already seen it, and thus have a circular dependency.
 */
export const CIRCULAR = '__CIRCULAR__';

/**
 * This property gets set before entering a template.
 *
 * This renderer can be one of two varieties of Renderer3:
 *
 * - ObjectedOrientedRenderer3
 *
 * This is the native browser API style, e.g. operations are methods on individual objects
 * like HTMLElement. With this style, no additional code is needed as a facade (reducing payload
 * size).
 *
 * - ProceduralRenderer3
 *
 * In non-native browser environments (e.g. platforms such as web-workers), this is the facade
 * that enables element manipulation. This also facilitates backwards compatibility with
 * Renderer2.
 */
let renderer: Renderer3;

export function getRenderer(): Renderer3 {
  // top level variables should not be exported for performance reasons (PERF_NOTES.md)
  return renderer;
}

let rendererFactory: RendererFactory3;

export function getRendererFactory(): RendererFactory3 {
  // top level variables should not be exported for performance reasons (PERF_NOTES.md)
  return rendererFactory;
}

export function getCurrentSanitizer(): Sanitizer|null {
  return viewData && viewData[SANITIZER];
}

/**
 * Store the element depth count. This is used to identify the root elements of the template
 * so that we can than attach `LViewData` to only those elements.
 */
let elementDepthCount !: number;

/**
 * Stores whether directives should be matched to elements.
 *
 * When template contains `ngNonBindable` than we need to prevent the runtime form matching
 * directives on children of that element.
 *
 * Example:
 * ```
 * <my-comp my-directive>
 *   Should match component / directive.
 * </my-comp>
 * <div ngNonBindable>
 *   <my-comp my-directive>
 *     Should not match component / directive because we are in ngNonBindable.
 *   </my-comp>
 * </div>
 * ```
 */
let bindingsEnabled !: boolean;

/**
 * Returns the current OpaqueViewState instance.
 *
 * Used in conjunction with the restoreView() instruction to save a snapshot
 * of the current view and restore it when listeners are invoked. This allows
 * walking the declaration view tree in listeners to get vars from parent views.
 */
export function getCurrentView(): OpaqueViewState {
  return viewData as any as OpaqueViewState;
}

/**
 * Restores `contextViewData` to the given OpaqueViewState instance.
 *
 * Used in conjunction with the getCurrentView() instruction to save a snapshot
 * of the current view and restore it when listeners are invoked. This allows
 * walking the declaration view tree in listeners to get vars from parent views.
 *
 * @param viewToRestore The OpaqueViewState instance to restore.
 */
export function restoreView(viewToRestore: OpaqueViewState) {
  contextViewData = viewToRestore as any as LViewData;
}

/** Used to set the parent property when nodes are created and track query results. */
let previousOrParentTNode: TNode;

export function getPreviousOrParentNode(): LNode|null {
  return previousOrParentTNode == null || previousOrParentTNode === viewData[HOST_NODE] ?
      getHostElementNode(viewData) :
      getLNode(previousOrParentTNode, viewData);
}

export function getPreviousOrParentTNode(): TNode {
  // top level variables should not be exported for performance reasons (PERF_NOTES.md)
  return previousOrParentTNode;
}

export function setEnvironment(tNode: TNode, view: LViewData) {
  previousOrParentTNode = tNode;
  viewData = view;
}

/**
 * If `isParent` is:
 *  - `true`: then `previousOrParentTNode` points to a parent node.
 *  - `false`: then `previousOrParentTNode` points to previous node (sibling).
 */
let isParent: boolean;

let tView: TView;

let currentQueries: LQueries|null;

/**
 * Query instructions can ask for "current queries" in 2 different cases:
 * - when creating view queries (at the root of a component view, before any node is created - in
 * this case currentQueries points to view queries)
 * - when creating content queries (i.e. this previousOrParentTNode points to a node on which we
 * create content queries).
 */
export function getOrCreateCurrentQueries(
    QueryType: {new (parent: null, shallow: null, deep: null): LQueries}): LQueries {
  // if this is the first content query on a node, any existing LQueries needs to be cloned
  // in subsequent template passes, the cloning occurs before directive instantiation.
  if (previousOrParentTNode && previousOrParentTNode !== viewData[HOST_NODE] &&
      !isContentQueryHost(previousOrParentTNode)) {
    currentQueries && (currentQueries = currentQueries.clone());
    previousOrParentTNode.flags |= TNodeFlags.hasContentQuery;
  }

  return currentQueries || (currentQueries = new QueryType(null, null, null));
}

/**
 * This property gets set before entering a template.
 */
let creationMode: boolean;

export function getCreationMode(): boolean {
  // top level variables should not be exported for performance reasons (PERF_NOTES.md)
  return creationMode;
}

/**
 * State of the current view being processed.
 *
 * An array of nodes (text, element, container, etc), pipes, their bindings, and
 * any local variables that need to be stored between invocations.
 */
let viewData: LViewData;

/**
 * Internal function that returns the current LViewData instance.
 *
 * The getCurrentView() instruction should be used for anything public.
 */
export function _getViewData(): LViewData {
  // top level variables should not be exported for performance reasons (PERF_NOTES.md)
  return viewData;
}

/**
 * The last viewData retrieved by nextContext().
 * Allows building nextContext() and reference() calls.
 *
 * e.g. const inner = x().$implicit; const outer = x().$implicit;
 */
let contextViewData: LViewData = null !;

/**
 * An array of directive instances in the current view.
 *
 * These must be stored separately from LNodes because their presence is
 * unknown at compile-time and thus space cannot be reserved in data[].
 */
let directives: any[]|null;

function getCleanup(view: LViewData): any[] {
  // top level variables should not be exported for performance reasons (PERF_NOTES.md)
  return view[CLEANUP] || (view[CLEANUP] = []);
}

function getTViewCleanup(view: LViewData): any[] {
  return view[TVIEW].cleanup || (view[TVIEW].cleanup = []);
}
/**
 * In this mode, any changes in bindings will throw an ExpressionChangedAfterChecked error.
 *
 * Necessary to support ChangeDetectorRef.checkNoChanges().
 */
let checkNoChangesMode = false;

/** Whether or not this is the first time the current view has been processed. */
let firstTemplatePass = true;

/**
 * The root index from which pure function instructions should calculate their binding
 * indices. In component views, this is TView.bindingStartIndex. In a host binding
 * context, this is the TView.hostBindingStartIndex + any hostVars before the given dir.
 */
let bindingRootIndex: number = -1;

// top level variables should not be exported for performance reasons (PERF_NOTES.md)
export function getBindingRoot() {
  return bindingRootIndex;
}

const enum BindingDirection {
  Input,
  Output,
}

/**
 * Swap the current state with a new state.
 *
 * For performance reasons we store the state in the top level of the module.
 * This way we minimize the number of properties to read. Whenever a new view
 * is entered we have to store the state for later, and when the view is
 * exited the state has to be restored
 *
 * @param newView New state to become active
 * @param host Element to which the View is a child of
 * @returns the previous state;
 */
export function enterView(
    newView: LViewData, hostTNode: TElementNode | TViewNode | null): LViewData {
  const oldView: LViewData = viewData;
  directives = newView && newView[DIRECTIVES];
  tView = newView && newView[TVIEW];

  creationMode = newView && (newView[FLAGS] & LViewFlags.CreationMode) === LViewFlags.CreationMode;
  firstTemplatePass = newView && tView.firstTemplatePass;
  bindingRootIndex = newView && tView.bindingStartIndex;
  renderer = newView && newView[RENDERER];

  previousOrParentTNode = hostTNode !;
  isParent = true;

  viewData = contextViewData = newView;
  oldView && (oldView[QUERIES] = currentQueries);
  currentQueries = newView && newView[QUERIES];

  return oldView;
}

/**
 * Used in lieu of enterView to make it clear when we are exiting a child view. This makes
 * the direction of traversal (up or down the view tree) a bit clearer.
 *
 * @param newView New state to become active
 * @param creationOnly An optional boolean to indicate that the view was processed in creation mode
 * only, i.e. the first update will be done later. Only possible for dynamically created views.
 */
export function leaveView(newView: LViewData, creationOnly?: boolean): void {
  if (!creationOnly) {
    if (!checkNoChangesMode) {
      executeHooks(directives !, tView.viewHooks, tView.viewCheckHooks, creationMode);
    }
    // Views are clean and in update mode after being checked, so these bits are cleared
    viewData[FLAGS] &= ~(LViewFlags.CreationMode | LViewFlags.Dirty);
  }
  viewData[FLAGS] |= LViewFlags.RunInit;
  viewData[BINDING_INDEX] = tView.bindingStartIndex;
  enterView(newView, null);
}

/**
 * Refreshes the view, executing the following steps in that order:
 * triggers init hooks, refreshes dynamic embedded views, triggers content hooks, sets host
 * bindings, refreshes child components.
 * Note: view hooks are triggered later when leaving the view.
 */
function refreshDescendantViews() {
  // This needs to be set before children are processed to support recursive components
  tView.firstTemplatePass = firstTemplatePass = false;

  if (!checkNoChangesMode) {
    executeInitHooks(viewData, tView, creationMode);
  }
  refreshDynamicEmbeddedViews(viewData);

  // Content query results must be refreshed before content hooks are called.
  refreshContentQueries(tView);

  if (!checkNoChangesMode) {
    executeHooks(directives !, tView.contentHooks, tView.contentCheckHooks, creationMode);
  }

  setHostBindings(tView.hostBindings);
  refreshChildComponents(tView.components);
}


/** Sets the host bindings for the current view. */
export function setHostBindings(bindings: number[] | null): void {
  if (bindings != null) {
    bindingRootIndex = viewData[BINDING_INDEX] = tView.hostBindingStartIndex;
    const defs = tView.directives !;
    for (let i = 0; i < bindings.length; i += 2) {
      const dirIndex = bindings[i];
      const def = defs[dirIndex] as DirectiveDefInternal<any>;
      def.hostBindings !(dirIndex, bindings[i + 1]);
      bindingRootIndex = viewData[BINDING_INDEX] = bindingRootIndex + def.hostVars;
    }
  }
}

/** Refreshes content queries for all directives in the given view. */
function refreshContentQueries(tView: TView): void {
  if (tView.contentQueries != null) {
    for (let i = 0; i < tView.contentQueries.length; i += 2) {
      const directiveDefIdx = tView.contentQueries[i];
      const directiveDef = tView.directives ![directiveDefIdx];

      directiveDef.contentQueriesRefresh !(directiveDefIdx, tView.contentQueries[i + 1]);
    }
  }
}

/** Refreshes child components in the current view. */
function refreshChildComponents(components: number[] | null): void {
  if (components != null) {
    for (let i = 0; i < components.length; i++) {
      componentRefresh(components[i]);
    }
  }
}

export function executeInitAndContentHooks(): void {
  if (!checkNoChangesMode) {
    executeInitHooks(viewData, tView, creationMode);
    executeHooks(directives !, tView.contentHooks, tView.contentCheckHooks, creationMode);
  }
}

export function createLViewData<T>(
    renderer: Renderer3, tView: TView, context: T | null, flags: LViewFlags,
    sanitizer?: Sanitizer | null): LViewData {
  const instance = tView.blueprint.slice() as LViewData;
  instance[PARENT] = viewData;
  instance[FLAGS] = flags | LViewFlags.CreationMode | LViewFlags.Attached | LViewFlags.RunInit;
  instance[CONTEXT] = context;
  instance[INJECTOR] = viewData ? viewData[INJECTOR] : null;
  instance[RENDERER] = renderer;
  instance[SANITIZER] = sanitizer || null;
  return instance;
}

/**
 * Creation of LNode object is extracted to a separate function so we always create LNode object
 * with the same shape
 * (same properties assigned in the same order).
 */
export function createLNodeObject(
    type: TNodeType, nodeInjector: LInjector | null, native: RText | RElement | RComment | null,
    state: any): LElementNode&LTextNode&LViewNode&LContainerNode&LProjectionNode {
  return {
    native: native as any,
    nodeInjector: nodeInjector,
    data: state,
    dynamicLContainerNode: null
  };
}

/**
 * A common way of creating the LNode to make sure that all of them have same shape to
 * keep the execution code monomorphic and fast.
 *
 * @param index The index at which the LNode should be saved (null if view, since they are not
 * saved).
 * @param type The type of LNode to create
 * @param native The native element for this LNode, if applicable
 * @param name The tag name of the associated native element, if applicable
 * @param attrs Any attrs for the native element, if applicable
 * @param data Any data that should be saved on the LNode
 */
export function createNodeAtIndex(
    index: number, type: TNodeType.Element, native: RElement | RText | null, name: string | null,
    attrs: TAttributes | null, lViewData?: LViewData | null): TElementNode;
export function createNodeAtIndex(
    index: number, type: TNodeType.View, native: null, name: null, attrs: null,
    lViewData: LViewData): TViewNode;
export function createNodeAtIndex(
    index: number, type: TNodeType.Container, native: RComment, name: string | null,
    attrs: TAttributes | null, lContainer: LContainer): TContainerNode;
export function createNodeAtIndex(
    index: number, type: TNodeType.Projection, native: null, name: null, attrs: TAttributes | null,
    lProjection: null): TProjectionNode;
export function createNodeAtIndex(
    index: number, type: TNodeType.ElementContainer, native: RComment, name: null,
    attrs: TAttributes | null, data: null): TElementContainerNode;
export function createNodeAtIndex(
    index: number, type: TNodeType, native: RText | RElement | RComment | null, name: string | null,
    attrs: TAttributes | null, state?: null | LViewData | LContainer): TElementNode&TViewNode&
    TContainerNode&TElementContainerNode&TProjectionNode {
  const parent =
      isParent ? previousOrParentTNode : previousOrParentTNode && previousOrParentTNode.parent;

  // Parents cannot cross component boundaries because components will be used in multiple places,
  // so it's only set if the view is the same.
  const parentInSameView = parent && viewData && parent !== viewData[HOST_NODE];
  const tParent = parentInSameView ? parent as TElementNode | TContainerNode : null;

  const isState = state != null;
  const node = createLNodeObject(type, null, native, isState ? state as any : null);
  let tNode: TNode;

  if (index === -1 || type === TNodeType.View) {
    // View nodes are not stored in data because they can be added / removed at runtime (which
    // would cause indices to change). Their TNodes are instead stored in tView.node.
    tNode = (state ? (state as LViewData)[TVIEW].node : null) ||
        createTNode(type, index, null, null, tParent, null);
  } else {
    const adjustedIndex = index + HEADER_OFFSET;

    // This is an element or container or projection node
    const tData = tView.data;
    ngDevMode && assertLessThan(
                     adjustedIndex, viewData.length, `Slot should have been initialized with null`);

    viewData[adjustedIndex] = node;

    if (tData[adjustedIndex] == null) {
      const tNode = tData[adjustedIndex] =
          createTNode(type, adjustedIndex, name, attrs, tParent, null);
      if (!isParent && previousOrParentTNode) {
        previousOrParentTNode.next = tNode;
        if (previousOrParentTNode.dynamicContainerNode)
          previousOrParentTNode.dynamicContainerNode.next = tNode;
      }
    }

    tNode = tData[adjustedIndex] as TNode;
    if (!tView.firstChild && type === TNodeType.Element) {
      tView.firstChild = tNode;
    }

    // Now link ourselves into the tree.
    if (isParent && previousOrParentTNode) {
      if (previousOrParentTNode.child == null && parentInSameView ||
          previousOrParentTNode.type === TNodeType.View) {
        // We are in the same view, which means we are adding content node to the parent View.
        previousOrParentTNode.child = tNode;
      }
    }
  }
  // TODO: temporary, remove this when removing nodeInjector (bringing in fns to hello world)
  if (index !== -1 && !(viewData[FLAGS] & LViewFlags.IsRoot)) {
    const parentLNode: LNode|null = type === TNodeType.View ?
        getContainerNode(tNode, state as LViewData) :
        getParentOrContainerNode(tNode, viewData);
    parentLNode && (node.nodeInjector = parentLNode.nodeInjector);
  }

  // View nodes and host elements need to set their host node (components do not save host TNodes)
  if ((type & TNodeType.ViewOrElement) === TNodeType.ViewOrElement && isState) {
    const lViewData = state as LViewData;
    ngDevMode &&
        assertEqual(
            lViewData[HOST_NODE], null, 'lViewData[HOST_NODE] should not have been initialized');
    lViewData[HOST_NODE] = tNode as TElementNode | TViewNode;
    if (lViewData[TVIEW].firstTemplatePass) {
      lViewData[TVIEW].node = tNode as TViewNode | TElementNode;
    }
  }

  previousOrParentTNode = tNode;
  isParent = true;
  return tNode as TElementNode & TViewNode & TContainerNode & TElementContainerNode &
      TProjectionNode;
}

/**
 * When LNodes are created dynamically after a view blueprint is created (e.g. through
 * i18nApply() or ComponentFactory.create), we need to adjust the blueprint for future
 * template passes.
 */
export function adjustBlueprintForNewNode(view: LViewData) {
  const tView = view[TVIEW];
  if (tView.firstTemplatePass) {
    tView.hostBindingStartIndex++;
    tView.blueprint.push(null);
    view.push(null);
  }
}


//////////////////////////
//// Render
//////////////////////////

/**
 * Resets the application state.
 */
export function resetComponentState() {
  isParent = false;
  previousOrParentTNode = null !;
  elementDepthCount = 0;
  bindingsEnabled = true;
}

/**
 *
 * @param hostNode Existing node to render into.
 * @param templateFn Template function with the instructions.
 * @param consts The number of nodes, local refs, and pipes in this template
 * @param context to pass into the template.
 * @param providedRendererFactory renderer factory to use
 * @param host The host element node to use
 * @param directives Directive defs that should be used for matching
 * @param pipes Pipe defs that should be used for matching
 */
export function renderTemplate<T>(
    hostNode: RElement, templateFn: ComponentTemplate<T>, consts: number, vars: number, context: T,
    providedRendererFactory: RendererFactory3, host: LElementNode | null,
    directives?: DirectiveDefListOrFactory | null, pipes?: PipeDefListOrFactory | null,
    sanitizer?: Sanitizer | null): LElementNode {
  if (host == null) {
    resetComponentState();
    rendererFactory = providedRendererFactory;
    renderer = providedRendererFactory.createRenderer(null, null);

    // We need to create a root view so it's possible to look up the host element through its index
    tView = createTView(-1, null, 1, 0, null, null, null);
    viewData = createLViewData(renderer, tView, {}, LViewFlags.CheckAlways | LViewFlags.IsRoot);

    const componentTView =
        getOrCreateTView(templateFn, consts, vars, directives || null, pipes || null, null);
    const componentLView =
        createLViewData(renderer, componentTView, context, LViewFlags.CheckAlways, sanitizer);
    createNodeAtIndex(0, TNodeType.Element, hostNode, null, null, componentLView);
    host = loadElement(0);
  }
  const hostView = host.data !;
  ngDevMode && assertDefined(hostView, 'Host node should have an LView defined in host.data.');
  renderComponentOrTemplate(hostView, context, templateFn);

  return host;
}

/**
 * Used for creating the LViewNode of a dynamic embedded view,
 * either through ViewContainerRef.createEmbeddedView() or TemplateRef.createEmbeddedView().
 * Such lViewNode will then be renderer with renderEmbeddedTemplate() (see below).
 */
export function createEmbeddedViewAndNode<T>(
    tView: TView, context: T, declarationView: LViewData, renderer: Renderer3,
    queries?: LQueries | null): LViewData {
  const _isParent = isParent;
  const _previousOrParentTNode = previousOrParentTNode;
  isParent = true;
  previousOrParentTNode = null !;

  const lView =
      createLViewData(renderer, tView, context, LViewFlags.CheckAlways, getCurrentSanitizer());
  lView[DECLARATION_VIEW] = declarationView;

  if (queries) {
    lView[QUERIES] = queries.createView();
  }
  createNodeAtIndex(-1, TNodeType.View, null, null, null, lView);

  isParent = _isParent;
  previousOrParentTNode = _previousOrParentTNode;
  return lView;
}

/**
 * Used for rendering embedded views (e.g. dynamically created views)
 *
 * Dynamically created views must store/retrieve their TViews differently from component views
 * because their template functions are nested in the template functions of their hosts, creating
 * closures. If their host template happens to be an embedded template in a loop (e.g. ngFor inside
 * an ngFor), the nesting would mean we'd have multiple instances of the template function, so we
 * can't store TViews in the template function itself (as we do for comps). Instead, we store the
 * TView for dynamically created views on their host TNode, which only has one instance.
 */
export function renderEmbeddedTemplate<T>(
    viewToRender: LViewData, tView: TView, context: T, rf: RenderFlags) {
  const _isParent = isParent;
  const _previousOrParentTNode = previousOrParentTNode;
  let oldView: LViewData;
  if (viewToRender[FLAGS] & LViewFlags.IsRoot) {
    // This is a root view inside the view tree
    tickRootContext(viewToRender[CONTEXT] as RootContext);
  } else {
    try {
      isParent = true;
      previousOrParentTNode = null !;

      oldView = enterView(viewToRender, viewToRender[HOST_NODE]);
      namespaceHTML();
      tView.template !(rf, context);
      if (rf & RenderFlags.Update) {
        refreshDescendantViews();
      } else {
        viewToRender[TVIEW].firstTemplatePass = firstTemplatePass = false;
      }
    } finally {
      // renderEmbeddedTemplate() is called twice in fact, once for creation only and then once for
      // update. When for creation only, leaveView() must not trigger view hooks, nor clean flags.
      const isCreationOnly = (rf & RenderFlags.Create) === RenderFlags.Create;
      leaveView(oldView !, isCreationOnly);
      isParent = _isParent;
      previousOrParentTNode = _previousOrParentTNode;
    }
  }
}

/**
 * Retrieves a context at the level specified and saves it as the global, contextViewData.
 * Will get the next level up if level is not specified.
 *
 * This is used to save contexts of parent views so they can be bound in embedded views, or
 * in conjunction with reference() to bind a ref from a parent view.
 *
 * @param level The relative level of the view from which to grab context compared to contextVewData
 * @returns context
 */
export function nextContext<T = any>(level: number = 1): T {
  contextViewData = walkUpViews(level, contextViewData !);
  return contextViewData[CONTEXT] as T;
}

export function renderComponentOrTemplate<T>(
    hostView: LViewData, componentOrContext: T, templateFn?: ComponentTemplate<T>) {
  const oldView = enterView(hostView, hostView[HOST_NODE]);
  try {
    if (rendererFactory.begin) {
      rendererFactory.begin();
    }
    if (templateFn) {
      namespaceHTML();
      templateFn(getRenderFlags(hostView), componentOrContext !);
      refreshDescendantViews();
    } else {
      executeInitAndContentHooks();

      // Element was stored at 0 in data and directive was stored at 0 in directives
      // in renderComponent()
      setHostBindings(tView.hostBindings);
      componentRefresh(HEADER_OFFSET);
    }
  } finally {
    if (rendererFactory.end) {
      rendererFactory.end();
    }
    leaveView(oldView);
  }
}

/**
 * This function returns the default configuration of rendering flags depending on when the
 * template is in creation mode or update mode. By default, the update block is run with the
 * creation block when the view is in creation mode. Otherwise, the update block is run
 * alone.
 *
 * Dynamically created views do NOT use this configuration (update block and create block are
 * always run separately).
 */
function getRenderFlags(view: LViewData): RenderFlags {
  return view[FLAGS] & LViewFlags.CreationMode ? RenderFlags.Create | RenderFlags.Update :
                                                 RenderFlags.Update;
}

//////////////////////////
//// Namespace
//////////////////////////

let _currentNamespace: string|null = null;

export function namespaceSVG() {
  _currentNamespace = 'http://www.w3.org/2000/svg/';
}

export function namespaceMathML() {
  _currentNamespace = 'http://www.w3.org/1998/MathML/';
}

export function namespaceHTML() {
  _currentNamespace = null;
}

//////////////////////////
//// Element
//////////////////////////

/**
 * Creates an empty element using {@link elementStart} and {@link elementEnd}
 *
 * @param index Index of the element in the data array
 * @param name Name of the DOM Node
 * @param attrs Statically bound set of attributes to be written into the DOM element on creation.
 * @param localRefs A set of local reference bindings on the element.
 */
export function element(
    index: number, name: string, attrs?: TAttributes | null, localRefs?: string[] | null): void {
  elementStart(index, name, attrs, localRefs);
  elementEnd();
}

/**
 * Creates a logical container for other nodes (<ng-container>) backed by a comment node in the DOM.
 * The instruction must later be followed by `elementContainerEnd()` call.
 *
 * @param index Index of the element in the LViewData array
 * @param attrs Set of attributes to be used when matching directives.
 * @param localRefs A set of local reference bindings on the element.
 *
 * Even if this instruction accepts a set of attributes no actual attribute values are propagated to
 * the DOM (as a comment node can't have attributes). Attributes are here only for directive
 * matching purposes and setting initial inputs of directives.
 */
export function elementContainerStart(
    index: number, attrs?: TAttributes | null, localRefs?: string[] | null): void {
  ngDevMode && assertEqual(
                   viewData[BINDING_INDEX], tView.bindingStartIndex,
                   'element containers should be created before any bindings');

  ngDevMode && ngDevMode.rendererCreateComment++;
  const native = renderer.createComment(ngDevMode ? 'ng-container' : '');

  ngDevMode && assertDataInRange(index - 1);
  const tNode =
      createNodeAtIndex(index, TNodeType.ElementContainer, native, null, attrs || null, null);

  appendChild(native, tNode, viewData);
  createDirectivesAndLocals(localRefs);
}

/** Mark the end of the <ng-container>. */
export function elementContainerEnd(): void {
  if (isParent) {
    isParent = false;
  } else {
    ngDevMode && assertHasParent();
    previousOrParentTNode = previousOrParentTNode.parent !;
  }

  ngDevMode && assertNodeType(previousOrParentTNode, TNodeType.ElementContainer);
  currentQueries &&
      (currentQueries = currentQueries.addNode(previousOrParentTNode as TElementContainerNode));

  queueLifecycleHooks(previousOrParentTNode.flags, tView);
}

/**
 * Create DOM element. The instruction must later be followed by `elementEnd()` call.
 *
 * @param index Index of the element in the LViewData array
 * @param name Name of the DOM Node
 * @param attrs Statically bound set of attributes to be written into the DOM element on creation.
 * @param localRefs A set of local reference bindings on the element.
 *
 * Attributes and localRefs are passed as an array of strings where elements with an even index
 * hold an attribute name and elements with an odd index hold an attribute value, ex.:
 * ['id', 'warning5', 'class', 'alert']
 */
export function elementStart(
    index: number, name: string, attrs?: TAttributes | null, localRefs?: string[] | null): void {
  ngDevMode && assertEqual(
                   viewData[BINDING_INDEX], tView.bindingStartIndex,
                   'elements should be created before any bindings ');

  ngDevMode && ngDevMode.rendererCreateElement++;

  const native = elementCreate(name);

  ngDevMode && assertDataInRange(index - 1);

  const tNode = createNodeAtIndex(index, TNodeType.Element, native !, name, attrs || null, null);

  if (attrs) {
    setUpAttributes(native, attrs);
  }
  appendChild(native, tNode, viewData);
  createDirectivesAndLocals(localRefs);

  // any immediate children of a component or template container must be pre-emptively
  // monkey-patched with the component view data so that the element can be inspected
  // later on using any element discovery utility methods (see `element_discovery.ts`)
  if (elementDepthCount === 0) {
    attachPatchData(native, viewData);
  }
  elementDepthCount++;
}

/**
 * Creates a native element from a tag name, using a renderer.
 * @param name the tag name
 * @param overriddenRenderer Optional A renderer to override the default one
 * @returns the element created
 */
export function elementCreate(name: string, overriddenRenderer?: Renderer3): RElement {
  let native: RElement;
  const rendererToUse = overriddenRenderer || renderer;

  if (isProceduralRenderer(rendererToUse)) {
    native = rendererToUse.createElement(name, _currentNamespace);
  } else {
    if (_currentNamespace === null) {
      native = rendererToUse.createElement(name);
    } else {
      native = rendererToUse.createElementNS(_currentNamespace, name);
    }
  }
  return native;
}

function nativeNodeLocalRefExtractor(tNode: TNode, currentView: LViewData): RNode {
  return getLNode(tNode, currentView).native;
}

/**
 * Creates directive instances and populates local refs.
 *
 * @param lNode LNode for which directive and locals should be created
 * @param localRefs Local refs of the node in question
 * @param localRefExtractor mapping function that extracts local ref value from LNode
 */
function createDirectivesAndLocals(
    localRefs: string[] | null | undefined,
    localRefExtractor: LocalRefExtractor = nativeNodeLocalRefExtractor) {
  if (!bindingsEnabled) return;
  if (firstTemplatePass) {
    ngDevMode && ngDevMode.firstTemplatePass++;
    cacheMatchingDirectivesForNode(previousOrParentTNode, tView, localRefs || null);
  } else {
    instantiateDirectivesDirectly();
  }
  saveResolvedLocalsInData(localRefExtractor);
}

/**
 * On first template pass, we match each node against available directive selectors and save
 * the resulting defs in the correct instantiation order for subsequent change detection runs
 * (so dependencies are always created before the directives that inject them).
 */
function cacheMatchingDirectivesForNode(
    tNode: TNode, tView: TView, localRefs: string[] | null): void {
  // Please make sure to have explicit type for `exportsMap`. Inferred type triggers bug in tsickle.
  const exportsMap: ({[key: string]: number} | null) = localRefs ? {'': -1} : null;
  const matches = tView.currentMatches = findDirectiveMatches(tNode);
  if (matches) {
    for (let i = 0; i < matches.length; i += 2) {
      const def = matches[i] as DirectiveDefInternal<any>;
      const valueIndex = i + 1;
      resolveDirective(def, valueIndex, matches, tView);
      saveNameToExportMap(matches[valueIndex] as number, def, exportsMap);
    }
  }
  if (exportsMap) cacheMatchingLocalNames(tNode, localRefs, exportsMap);
}

/** Matches the current node against all available selectors. */
function findDirectiveMatches(tNode: TNode): CurrentMatchesList|null {
  const registry = tView.directiveRegistry;
  let matches: any[]|null = null;
  if (registry) {
    for (let i = 0; i < registry.length; i++) {
      const def = registry[i];
      if (isNodeMatchingSelectorList(tNode, def.selectors !)) {
        matches || (matches = []);
        if ((def as ComponentDefInternal<any>).template) {
          if (tNode.flags & TNodeFlags.isComponent) throwMultipleComponentError(tNode);
          addComponentLogic(def as ComponentDefInternal<any>);
          tNode.flags = TNodeFlags.isComponent;

          // The component is always stored first with directives after.
          matches.unshift(def, null);
        } else {
          matches.push(def, null);
        }
        if (def.diPublic) def.diPublic(def);
      }
    }
  }
  return matches as CurrentMatchesList;
}

export function resolveDirective(
    def: DirectiveDefInternal<any>, valueIndex: number, matches: CurrentMatchesList,
    tView: TView): any {
  if (matches[valueIndex] === null) {
    matches[valueIndex] = CIRCULAR;
    const instance = def.factory();
    (tView.directives || (tView.directives = [])).push(def);
    return directiveCreate(matches[valueIndex] = tView.directives !.length - 1, instance, def);
  } else if (matches[valueIndex] === CIRCULAR) {
    // If we revisit this directive before it's resolved, we know it's circular
    throwCyclicDependencyError(def.type);
  }
  return null;
}

/** Stores index of component's host element so it will be queued for view refresh during CD. */
function queueComponentIndexForCheck(): void {
  if (firstTemplatePass) {
    (tView.components || (tView.components = [])).push(previousOrParentTNode.index);
  }
}

/** Stores index of directive and host element so it will be queued for binding refresh during CD.
 */
export function queueHostBindingForCheck(dirIndex: number, hostVars: number): void {
  // Must subtract the header offset because hostBindings functions are generated with
  // instructions that expect element indices that are NOT adjusted (e.g. elementProperty).
  ngDevMode &&
      assertEqual(firstTemplatePass, true, 'Should only be called in first template pass.');
  for (let i = 0; i < hostVars; i++) {
    tView.blueprint.push(NO_CHANGE);
    viewData.push(NO_CHANGE);
  }
  (tView.hostBindings || (tView.hostBindings = [
   ])).push(dirIndex, previousOrParentTNode.index - HEADER_OFFSET);
}

/**
 * This function instantiates the given directives.
 */
function instantiateDirectivesDirectly() {
  ngDevMode && assertEqual(
                   firstTemplatePass, false,
                   `Directives should only be instantiated directly after first template pass`);
  const count = previousOrParentTNode.flags & TNodeFlags.DirectiveCountMask;

  if (isContentQueryHost(previousOrParentTNode) && currentQueries) {
    currentQueries = currentQueries.clone();
  }

  if (count > 0) {
    const start = previousOrParentTNode.flags >> TNodeFlags.DirectiveStartingIndexShift;
    const end = start + count;
    const tDirectives = tView.directives !;

    for (let i = start; i < end; i++) {
      const def: DirectiveDefInternal<any> = tDirectives[i];

      // Component view must be set on node before the factory is created so
      // ChangeDetectorRefs have a way to store component view on creation.
      if ((def as ComponentDefInternal<any>).template) {
        addComponentLogic(def as ComponentDefInternal<any>);
      }
      directiveCreate(i, def.factory(), def);
    }
  }
}

/** Caches local names and their matching directive indices for query and template lookups. */
function cacheMatchingLocalNames(
    tNode: TNode, localRefs: string[] | null, exportsMap: {[key: string]: number}): void {
  if (localRefs) {
    const localNames: (string | number)[] = tNode.localNames = [];

    // Local names must be stored in tNode in the same order that localRefs are defined
    // in the template to ensure the data is loaded in the same slots as their refs
    // in the template (for template queries).
    for (let i = 0; i < localRefs.length; i += 2) {
      const index = exportsMap[localRefs[i + 1]];
      if (index == null) throw new Error(`Export of name '${localRefs[i + 1]}' not found!`);
      localNames.push(localRefs[i], index);
    }
  }
}

/**
 * Builds up an export map as directives are created, so local refs can be quickly mapped
 * to their directive instances.
 */
function saveNameToExportMap(
    index: number, def: DirectiveDefInternal<any>| ComponentDefInternal<any>,
    exportsMap: {[key: string]: number} | null) {
  if (exportsMap) {
    if (def.exportAs) exportsMap[def.exportAs] = index;
    if ((def as ComponentDefInternal<any>).template) exportsMap[''] = index;
  }
}

/**
 * Takes a list of local names and indices and pushes the resolved local variable values
 * to LViewData in the same order as they are loaded in the template with load().
 */
function saveResolvedLocalsInData(localRefExtractor: LocalRefExtractor): void {
  const localNames = previousOrParentTNode.localNames;
  const tNode = previousOrParentTNode as TElementNode | TContainerNode | TElementContainerNode;
  if (localNames) {
    let localIndex = previousOrParentTNode.index + 1;
    for (let i = 0; i < localNames.length; i += 2) {
      const index = localNames[i + 1] as number;
      const value = index === -1 ? localRefExtractor(tNode, viewData) : directives ![index];
      viewData[localIndex++] = value;
    }
  }
}

/**
 * Gets TView from a template function or creates a new TView
 * if it doesn't already exist.
 *
 * @param templateFn The template from which to get static data
 * @param consts The number of nodes, local refs, and pipes in this view
 * @param vars The number of bindings and pure function bindings in this view
 * @param directives Directive defs that should be saved on TView
 * @param pipes Pipe defs that should be saved on TView
 * @returns TView
 */
function getOrCreateTView(
    templateFn: ComponentTemplate<any>, consts: number, vars: number,
    directives: DirectiveDefListOrFactory | null, pipes: PipeDefListOrFactory | null,
    viewQuery: ComponentQuery<any>| null): TView {
  // TODO(misko): reading `ngPrivateData` here is problematic for two reasons
  // 1. It is a megamorphic call on each invocation.
  // 2. For nested embedded views (ngFor inside ngFor) the template instance is per
  //    outer template invocation, which means that no such property will exist
  // Correct solution is to only put `ngPrivateData` on the Component template
  // and not on embedded templates.

  return templateFn.ngPrivateData ||
      (templateFn.ngPrivateData =
           createTView(-1, templateFn, consts, vars, directives, pipes, viewQuery) as never);
}

/**
 * Creates a TView instance
 *
 * @param viewIndex The viewBlockId for inline views, or -1 if it's a component/dynamic
 * @param templateFn Template function
 * @param consts The number of nodes, local refs, and pipes in this template
 * @param directives Registry of directives for this view
 * @param pipes Registry of pipes for this view
 */
export function createTView(
    viewIndex: number, templateFn: ComponentTemplate<any>| null, consts: number, vars: number,
    directives: DirectiveDefListOrFactory | null, pipes: PipeDefListOrFactory | null,
    viewQuery: ComponentQuery<any>| null): TView {
  ngDevMode && ngDevMode.tView++;
  const bindingStartIndex = HEADER_OFFSET + consts;
  // This length does not yet contain host bindings from child directives because at this point,
  // we don't know which directives are active on this template. As soon as a directive is matched
  // that has a host binding, we will update the blueprint with that def's hostVars count.
  const initialViewLength = bindingStartIndex + vars;
  const blueprint = createViewBlueprint(bindingStartIndex, initialViewLength);
  return blueprint[TVIEW] = {
    id: viewIndex,
    blueprint: blueprint,
    template: templateFn,
    viewQuery: viewQuery,
    node: null !,
    data: HEADER_FILLER.slice(),  // Fill in to match HEADER_OFFSET in LViewData
    childIndex: -1,               // Children set in addToViewTree(), if any
    bindingStartIndex: bindingStartIndex,
    hostBindingStartIndex: initialViewLength,
    directives: null,
    firstTemplatePass: true,
    initHooks: null,
    checkHooks: null,
    contentHooks: null,
    contentCheckHooks: null,
    viewHooks: null,
    viewCheckHooks: null,
    destroyHooks: null,
    pipeDestroyHooks: null,
    cleanup: null,
    hostBindings: null,
    contentQueries: null,
    components: null,
    directiveRegistry: typeof directives === 'function' ? directives() : directives,
    pipeRegistry: typeof pipes === 'function' ? pipes() : pipes,
    currentMatches: null,
    firstChild: null,
  };
}

function createViewBlueprint(bindingStartIndex: number, initialViewLength: number): LViewData {
  const blueprint = new Array(initialViewLength)
                        .fill(null, 0, bindingStartIndex)
                        .fill(NO_CHANGE, bindingStartIndex) as LViewData;
  blueprint[CONTAINER_INDEX] = -1;
  blueprint[BINDING_INDEX] = bindingStartIndex;
  return blueprint;
}

function setUpAttributes(native: RElement, attrs: TAttributes): void {
  const isProc = isProceduralRenderer(renderer);
  let i = 0;

  while (i < attrs.length) {
    const attrName = attrs[i];
    if (attrName === AttributeMarker.SelectOnly) break;
    if (attrName === NG_PROJECT_AS_ATTR_NAME) {
      i += 2;
    } else {
      ngDevMode && ngDevMode.rendererSetAttribute++;
      if (attrName === AttributeMarker.NamespaceURI) {
        // Namespaced attributes
        const namespaceURI = attrs[i + 1] as string;
        const attrName = attrs[i + 2] as string;
        const attrVal = attrs[i + 3] as string;
        isProc ?
            (renderer as ProceduralRenderer3)
                .setAttribute(native, attrName, attrVal, namespaceURI) :
            native.setAttributeNS(namespaceURI, attrName, attrVal);
        i += 4;
      } else {
        // Standard attributes
        const attrVal = attrs[i + 1];
        isProc ?
            (renderer as ProceduralRenderer3)
                .setAttribute(native, attrName as string, attrVal as string) :
            native.setAttribute(attrName as string, attrVal as string);
        i += 2;
      }
    }
  }
}

export function createError(text: string, token: any) {
  return new Error(`Renderer: ${text} [${stringify(token)}]`);
}


/**
 * Locates the host native element, used for bootstrapping existing nodes into rendering pipeline.
 *
 * @param elementOrSelector Render element or CSS selector to locate the element.
 */
export function locateHostElement(
    factory: RendererFactory3, elementOrSelector: RElement | string): RElement|null {
  ngDevMode && assertDataInRange(-1);
  rendererFactory = factory;
  const defaultRenderer = factory.createRenderer(null, null);
  const rNode = typeof elementOrSelector === 'string' ?
      (isProceduralRenderer(defaultRenderer) ?
           defaultRenderer.selectRootElement(elementOrSelector) :
           defaultRenderer.querySelector(elementOrSelector)) :
      elementOrSelector;
  if (ngDevMode && !rNode) {
    if (typeof elementOrSelector === 'string') {
      throw createError('Host node with selector not found:', elementOrSelector);
    } else {
      throw createError('Host node is required:', elementOrSelector);
    }
  }
  return rNode;
}

/**
 * Creates the host LNode.
 *
 * @param rNode Render host element.
 * @param def ComponentDef
 *
 * @returns LElementNode created
 */
export function hostElement(
    tag: string, rNode: RElement | null, def: ComponentDefInternal<any>,
    sanitizer?: Sanitizer | null): LElementNode {
  resetComponentState();
  const tNode = createNodeAtIndex(
      0, TNodeType.Element, rNode, null, null,
      createLViewData(
          renderer,
          getOrCreateTView(
              def.template, def.consts, def.vars, def.directiveDefs, def.pipeDefs, def.viewQuery),
          null, def.onPush ? LViewFlags.Dirty : LViewFlags.CheckAlways, sanitizer));

  if (firstTemplatePass) {
    tNode.flags = TNodeFlags.isComponent;
    if (def.diPublic) def.diPublic(def);
    tView.directives = [def];
  }
  return viewData[HEADER_OFFSET];
}

/**
 * Adds an event listener to the current node.
 *
 * If an output exists on one of the node's directives, it also subscribes to the output
 * and saves the subscription for later cleanup.
 *
 * @param eventName Name of the event
 * @param listenerFn The function to be called when event emits
 * @param useCapture Whether or not to use capture in event listener.
 */
export function listener(
    eventName: string, listenerFn: (e?: any) => any, useCapture = false): void {
  const tNode = previousOrParentTNode;
  ngDevMode && assertNodeOfPossibleTypes(
                   tNode, TNodeType.Element, TNodeType.Container, TNodeType.ElementContainer);

  // add native event listener - applicable to elements only
  if (tNode.type === TNodeType.Element) {
    const node = getPreviousOrParentNode() as LElementNode;
    ngDevMode && ngDevMode.rendererAddEventListener++;

    // In order to match current behavior, native DOM event listeners must be added for all
    // events (including outputs).
    if (isProceduralRenderer(renderer)) {
      const cleanupFn = renderer.listen(node.native, eventName, listenerFn);
      storeCleanupFn(viewData, cleanupFn);
    } else {
      const wrappedListener = wrapListenerWithPreventDefault(listenerFn);
      node.native.addEventListener(eventName, wrappedListener, useCapture);
      const cleanupInstances = getCleanup(viewData);
      cleanupInstances.push(wrappedListener);
      if (firstTemplatePass) {
        getTViewCleanup(viewData).push(
            eventName, tNode.index, cleanupInstances !.length - 1, useCapture);
      }
    }
  }

  // subscribe to directive outputs
  if (tNode.outputs === undefined) {
    // if we create TNode here, inputs must be undefined so we know they still need to be
    // checked
    tNode.outputs = generatePropertyAliases(tNode.flags, BindingDirection.Output);
  }

  const outputs = tNode.outputs;
  let outputData: PropertyAliasValue|undefined;
  if (outputs && (outputData = outputs[eventName])) {
    createOutput(outputData, listenerFn);
  }
}

/**
 * Iterates through the outputs associated with a particular event name and subscribes to
 * each output.
 */
function createOutput(outputs: PropertyAliasValue, listener: Function): void {
  for (let i = 0; i < outputs.length; i += 2) {
    ngDevMode && assertDataInRange(outputs[i] as number, directives !);
    const subscription = directives ![outputs[i] as number][outputs[i + 1]].subscribe(listener);
    storeCleanupWithContext(viewData, subscription, subscription.unsubscribe);
  }
}

/**
 * Saves context for this cleanup function in LView.cleanupInstances.
 *
 * On the first template pass, saves in TView:
 * - Cleanup function
 * - Index of context we just saved in LView.cleanupInstances
 */
export function storeCleanupWithContext(
    view: LViewData | null, context: any, cleanupFn: Function): void {
  if (!view) view = viewData;
  getCleanup(view).push(context);

  if (view[TVIEW].firstTemplatePass) {
    getTViewCleanup(view).push(cleanupFn, view[CLEANUP] !.length - 1);
  }
}

/**
 * Saves the cleanup function itself in LView.cleanupInstances.
 *
 * This is necessary for functions that are wrapped with their contexts, like in renderer2
 * listeners.
 *
 * On the first template pass, the index of the cleanup function is saved in TView.
 */
export function storeCleanupFn(view: LViewData, cleanupFn: Function): void {
  getCleanup(view).push(cleanupFn);

  if (view[TVIEW].firstTemplatePass) {
    getTViewCleanup(view).push(view[CLEANUP] !.length - 1, null);
  }
}

/** Mark the end of the element. */
export function elementEnd(): void {
  if (isParent) {
    isParent = false;
  } else {
    ngDevMode && assertHasParent();
    previousOrParentTNode = previousOrParentTNode.parent !;
  }
  ngDevMode && assertNodeType(previousOrParentTNode, TNodeType.Element);
  currentQueries &&
      (currentQueries = currentQueries.addNode(previousOrParentTNode as TElementNode));

  queueLifecycleHooks(previousOrParentTNode.flags, tView);
  elementDepthCount--;
}

/**
 * Updates the value of removes an attribute on an Element.
 *
 * @param number index The index of the element in the data array
 * @param name name The name of the attribute.
 * @param value value The attribute is removed when value is `null` or `undefined`.
 *                  Otherwise the attribute value is set to the stringified value.
 * @param sanitizer An optional function used to sanitize the value.
 */
export function elementAttribute(
    index: number, name: string, value: any, sanitizer?: SanitizerFn): void {
  if (value !== NO_CHANGE) {
    const element = loadElement(index);
    if (value == null) {
      ngDevMode && ngDevMode.rendererRemoveAttribute++;
      isProceduralRenderer(renderer) ? renderer.removeAttribute(element.native, name) :
                                       element.native.removeAttribute(name);
    } else {
      ngDevMode && ngDevMode.rendererSetAttribute++;
      const strValue = sanitizer == null ? stringify(value) : sanitizer(value);
      isProceduralRenderer(renderer) ? renderer.setAttribute(element.native, name, strValue) :
                                       element.native.setAttribute(name, strValue);
    }
  }
}

/**
 * Update a property on an Element.
 *
 * If the property name also exists as an input property on one of the element's directives,
 * the component property will be set instead of the element property. This check must
 * be conducted at runtime so child components that add new @Inputs don't have to be re-compiled.
 *
 * @param index The index of the element to update in the data array
 * @param propName Name of property. Because it is going to DOM, this is not subject to
 *        renaming as part of minification.
 * @param value New value to write.
 * @param sanitizer An optional function used to sanitize the value.
 */

export function elementProperty<T>(
    index: number, propName: string, value: T | NO_CHANGE, sanitizer?: SanitizerFn): void {
  if (value === NO_CHANGE) return;
  const node = loadElement(index) as LElementNode;
  const tNode = getTNode(index);
  // if tNode.inputs is undefined, a listener has created outputs, but inputs haven't
  // yet been checked
  if (tNode && tNode.inputs === undefined) {
    // mark inputs as checked
    tNode.inputs = generatePropertyAliases(tNode.flags, BindingDirection.Input);
  }

  const inputData = tNode && tNode.inputs;
  let dataValue: PropertyAliasValue|undefined;
  if (inputData && (dataValue = inputData[propName])) {
    setInputsForProperty(dataValue, value);
    markDirtyIfOnPush(node);
  } else {
    // It is assumed that the sanitizer is only added when the compiler determines that the property
    // is risky, so sanitization can be done without further checks.
    value = sanitizer != null ? (sanitizer(value) as any) : value;
    const native = node.native;
    ngDevMode && ngDevMode.rendererSetProperty++;
    isProceduralRenderer(renderer) ? renderer.setProperty(native, propName, value) :
                                     (native.setProperty ? native.setProperty(propName, value) :
                                                           (native as any)[propName] = value);
  }
}

/**
 * Enables directive matching on elements.
 *
 *  * Example:
 * ```
 * <my-comp my-directive>
 *   Should match component / directive.
 * </my-comp>
 * <div ngNonBindable>
 *   <!-- disabledBindings() -->
 *   <my-comp my-directive>
 *     Should not match component / directive because we are in ngNonBindable.
 *   </my-comp>
 *   <!-- enableBindings() -->
 * </div>
 * ```
 */
export function enableBindings(): void {
  bindingsEnabled = true;
}

/**
 * Disables directive matching on element.
 *
 *  * Example:
 * ```
 * <my-comp my-directive>
 *   Should match component / directive.
 * </my-comp>
 * <div ngNonBindable>
 *   <!-- disabledBindings() -->
 *   <my-comp my-directive>
 *     Should not match component / directive because we are in ngNonBindable.
 *   </my-comp>
 *   <!-- enableBindings() -->
 * </div>
 * ```
 */
export function disableBindings(): void {
  bindingsEnabled = false;
}

/**
 * Constructs a TNode object from the arguments.
 *
 * @param type The type of the node
 * @param adjustedIndex The index of the TNode in TView.data, adjusted for HEADER_OFFSET
 * @param tagName The tag name of the node
 * @param attrs The attributes defined on this node
 * @param parent The parent of this node
 * @param tViews Any TViews attached to this node
 * @returns the TNode object
 */
export function createTNode(
    type: TNodeType, adjustedIndex: number, tagName: string | null, attrs: TAttributes | null,
    parent: TElementNode | TContainerNode | null, tViews: TView[] | null): TNode {
  ngDevMode && ngDevMode.tNode++;
  return {
    type: type,
    index: adjustedIndex,
    flags: 0,
    tagName: tagName,
    attrs: attrs,
    localNames: null,
    initialInputs: undefined,
    inputs: undefined,
    outputs: undefined,
    tViews: tViews,
    next: null,
    child: null,
    parent: parent,
    dynamicContainerNode: null,
    detached: null,
    stylingTemplate: null,
    projection: null
  };
}

/**
 * Given a list of directive indices and minified input names, sets the
 * input properties on the corresponding directives.
 */
function setInputsForProperty(inputs: PropertyAliasValue, value: any): void {
  for (let i = 0; i < inputs.length; i += 2) {
    ngDevMode && assertDataInRange(inputs[i] as number, directives !);
    directives ![inputs[i] as number][inputs[i + 1]] = value;
  }
}

/**
 * Consolidates all inputs or outputs of all directives on this logical node.
 *
 * @param number lNodeFlags logical node flags
 * @param Direction direction whether to consider inputs or outputs
 * @returns PropertyAliases|null aggregate of all properties if any, `null` otherwise
 */
function generatePropertyAliases(
    tNodeFlags: TNodeFlags, direction: BindingDirection): PropertyAliases|null {
  const count = tNodeFlags & TNodeFlags.DirectiveCountMask;
  let propStore: PropertyAliases|null = null;

  if (count > 0) {
    const start = tNodeFlags >> TNodeFlags.DirectiveStartingIndexShift;
    const end = start + count;
    const isInput = direction === BindingDirection.Input;
    const defs = tView.directives !;

    for (let i = start; i < end; i++) {
      const directiveDef = defs[i] as DirectiveDefInternal<any>;
      const propertyAliasMap: {[publicName: string]: string} =
          isInput ? directiveDef.inputs : directiveDef.outputs;
      for (let publicName in propertyAliasMap) {
        if (propertyAliasMap.hasOwnProperty(publicName)) {
          propStore = propStore || {};
          const internalName = propertyAliasMap[publicName];
          const hasProperty = propStore.hasOwnProperty(publicName);
          hasProperty ? propStore[publicName].push(i, internalName) :
                        (propStore[publicName] = [i, internalName]);
        }
      }
    }
  }
  return propStore;
}

/**
 * Add or remove a class in a `classList` on a DOM element.
 *
 * This instruction is meant to handle the [class.foo]="exp" case
 *
 * @param index The index of the element to update in the data array
 * @param className Name of class to toggle. Because it is going to DOM, this is not subject to
 *        renaming as part of minification.
 * @param value A value indicating if a given class should be added or removed.
 */
export function elementClassProp<T>(
    index: number, stylingIndex: number, value: T | NO_CHANGE): void {
  updateElementClassProp(getStylingContext(index), stylingIndex, value ? true : false);
}

/**
 * Assign any inline style values to the element during creation mode.
 *
 * This instruction is meant to be called during creation mode to apply all styling
 * (e.g. `style="..."`) values to the element. This is also where the provided index
 * value is allocated for the styling details for its corresponding element (the element
 * index is the previous index value from this one).
 *
 * (Note this function calls `elementStylingApply` immediately when called.)
 *
 *
 * @param index Index value which will be allocated to store styling data for the element.
 *        (Note that this is not the element index, but rather an index value allocated
 *        specifically for element styling--the index must be the next index after the element
 *        index.)
 * @param classDeclarations A key/value array of CSS classes that will be registered on the element.
 *   Each individual style will be used on the element as long as it is not overridden
 *   by any classes placed on the element by multiple (`[class]`) or singular (`[class.named]`)
 *   bindings. If a class binding changes its value to a falsy value then the matching initial
 *   class value that are passed in here will be applied to the element (if matched).
 * @param styleDeclarations A key/value array of CSS styles that will be registered on the element.
 *   Each individual style will be used on the element as long as it is not overridden
 *   by any styles placed on the element by multiple (`[style]`) or singular (`[style.prop]`)
 *   bindings. If a style binding changes its value to null then the initial styling
 *   values that are passed in here will be applied to the element (if matched).
 * @param styleSanitizer An optional sanitizer function that will be used (if provided)
 *   to sanitize the any CSS property values that are applied to the element (during rendering).
 */
export function elementStyling<T>(
    classDeclarations?: (string | boolean | InitialStylingFlags)[] | null,
    styleDeclarations?: (string | boolean | InitialStylingFlags)[] | null,
    styleSanitizer?: StyleSanitizeFn | null): void {
  const tNode = previousOrParentTNode;
  if (!tNode.stylingTemplate) {
    // initialize the styling template.
    tNode.stylingTemplate =
        createStylingContextTemplate(classDeclarations, styleDeclarations, styleSanitizer);
  }
  if (styleDeclarations && styleDeclarations.length ||
      classDeclarations && classDeclarations.length) {
    elementStylingApply(tNode.index - HEADER_OFFSET);
  }
}

/**
 * Retrieve the `StylingContext` at a given index.
 *
 * This method lazily creates the `StylingContext`. This is because in most cases
 * we have styling without any bindings. Creating `StylingContext` eagerly would mean that
 * every style declaration such as `<div style="color: red">` would result `StyleContext`
 * which would create unnecessary memory pressure.
 *
 * @param index Index of the style allocation. See: `elementStyling`.
 */
function getStylingContext(index: number): StylingContext {
  let stylingContext = load<StylingContext>(index);
  if (!Array.isArray(stylingContext)) {
    const lElement = stylingContext as any as LElementNode;
    const tNode = getTNode(index);
    ngDevMode &&
        assertDefined(tNode.stylingTemplate, 'getStylingContext() called before elementStyling()');
    stylingContext = viewData[index + HEADER_OFFSET] =
        allocStylingContext(lElement, tNode.stylingTemplate !);
  }
  return stylingContext;
}

/**
 * Apply all styling values to the element which have been queued by any styling instructions.
 *
 * This instruction is meant to be run once one or more `elementStyle` and/or `elementStyleProp`
 * have been issued against the element. This function will also determine if any styles have
 * changed and will then skip the operation if there is nothing new to render.
 *
 * Once called then all queued styles will be flushed.
 *
 * @param index Index of the element's styling storage that will be rendered.
 *        (Note that this is not the element index, but rather an index value allocated
 *        specifically for element styling--the index must be the next index after the element
 *        index.)
 */
export function elementStylingApply<T>(index: number): void {
  renderElementStyles(getStylingContext(index), renderer);
}

/**
 * Queue a given style to be rendered on an Element.
 *
 * If the style value is `null` then it will be removed from the element
 * (or assigned a different value depending if there are any styles placed
 * on the element with `elementStyle` or any styles that are present
 * from when the element was created (with `elementStyling`).
 *
 * (Note that the styling instruction will not be applied until `elementStylingApply` is called.)
 *
 * @param index Index of the element's styling storage to change in the data array.
 *        (Note that this is not the element index, but rather an index value allocated
 *        specifically for element styling--the index must be the next index after the element
 *        index.)
 * @param styleIndex Index of the style property on this element. (Monotonically increasing.)
 * @param styleName Name of property. Because it is going to DOM this is not subject to
 *        renaming as part of minification.
 * @param value New value to write (null to remove).
 * @param suffix Optional suffix. Used with scalar values to add unit such as `px`.
 *        Note that when a suffix is provided then the underlying sanitizer will
 *        be ignored.
 */
export function elementStyleProp<T>(
    index: number, styleIndex: number, value: T | null, suffix?: string): void {
  let valueToAdd: string|null = null;
  if (value) {
    if (suffix) {
      // when a suffix is applied then it will bypass
      // sanitization entirely (b/c a new string is created)
      valueToAdd = stringify(value) + suffix;
    } else {
      // sanitization happens by dealing with a String value
      // this means that the string value will be passed through
      // into the style rendering later (which is where the value
      // will be sanitized before it is applied)
      valueToAdd = value as any as string;
    }
  }
  updateElementStyleProp(getStylingContext(index), styleIndex, valueToAdd);
}

/**
 * Queue a key/value map of styles to be rendered on an Element.
 *
 * This instruction is meant to handle the `[style]="exp"` usage. When styles are applied to
 * the Element they will then be placed with respect to any styles set with `elementStyleProp`.
 * If any styles are set to `null` then they will be removed from the element (unless the same
 * style properties have been assigned to the element during creation using `elementStyling`).
 *
 * (Note that the styling instruction will not be applied until `elementStylingApply` is called.)
 *
 * @param index Index of the element's styling storage to change in the data array.
 *        (Note that this is not the element index, but rather an index value allocated
 *        specifically for element styling--the index must be the next index after the element
 *        index.)
 * @param classes A key/value style map of CSS classes that will be added to the given element.
 *        Any missing classes (that have already been applied to the element beforehand) will be
 *        removed (unset) from the element's list of CSS classes.
 * @param styles A key/value style map of the styles that will be applied to the given element.
 *        Any missing styles (that have already been applied to the element beforehand) will be
 *        removed (unset) from the element's styling.
 */
export function elementStylingMap<T>(
    index: number, classes: {[key: string]: any} | string | null,
    styles?: {[styleName: string]: any} | null): void {
  updateStylingMap(getStylingContext(index), classes, styles);
}

//////////////////////////
//// Text
//////////////////////////

/**
 * Create static text node
 *
 * @param index Index of the node in the data array
 * @param value Value to write. This value will be stringified.
 */
export function text(index: number, value?: any): void {
  ngDevMode && assertEqual(
                   viewData[BINDING_INDEX], tView.bindingStartIndex,
                   'text nodes should be created before any bindings');
  ngDevMode && ngDevMode.rendererCreateTextNode++;
  const textNative = createTextNode(value, renderer);
  const tNode = createNodeAtIndex(index, TNodeType.Element, textNative, null, null);

  // Text nodes are self closing.
  isParent = false;
  appendChild(textNative, tNode, viewData);
}

/**
 * Create text node with binding
 * Bindings should be handled externally with the proper interpolation(1-8) method
 *
 * @param index Index of the node in the data array.
 * @param value Stringified value to write.
 */
export function textBinding<T>(index: number, value: T | NO_CHANGE): void {
  if (value !== NO_CHANGE) {
    ngDevMode && assertDataInRange(index + HEADER_OFFSET);
    const existingNode = loadElement(index) as any as LTextNode;
    ngDevMode && assertDefined(existingNode, 'LNode should exist');
    ngDevMode && assertDefined(existingNode.native, 'native element should exist');
    ngDevMode && ngDevMode.rendererSetText++;
    isProceduralRenderer(renderer) ? renderer.setValue(existingNode.native, stringify(value)) :
                                     existingNode.native.textContent = stringify(value);
  }
}

//////////////////////////
//// Directive
//////////////////////////

/**
 * Create a directive and their associated content queries.
 *
 * NOTE: directives can be created in order other than the index order. They can also
 *       be retrieved before they are created in which case the value will be null.
 *
 * @param directive The directive instance.
 * @param directiveDef DirectiveDef object which contains information about the template.
 */
export function directiveCreate<T>(
    directiveDefIdx: number, directive: T,
    directiveDef: DirectiveDefInternal<T>| ComponentDefInternal<T>): T {
  const hostNode = getLNode(previousOrParentTNode, viewData);
  const instance = baseDirectiveCreate(directiveDefIdx, directive, directiveDef, hostNode);

  if ((directiveDef as ComponentDefInternal<T>).template) {
    hostNode.data ![CONTEXT] = directive;
  }

  if (firstTemplatePass) {
    // Init hooks are queued now so ngOnInit is called in host components before
    // any projected components.
    queueInitHooks(directiveDefIdx, directiveDef.onInit, directiveDef.doCheck, tView);

    if (directiveDef.hostBindings) queueHostBindingForCheck(directiveDefIdx, directiveDef.hostVars);
  }

  ngDevMode && assertDefined(previousOrParentTNode, 'previousOrParentTNode');
  if (previousOrParentTNode && previousOrParentTNode.attrs) {
    setInputsFromAttrs(directiveDefIdx, instance, directiveDef.inputs, previousOrParentTNode);
  }

  if (directiveDef.contentQueries) {
    directiveDef.contentQueries();
  }

  return instance;
}

function addComponentLogic<T>(def: ComponentDefInternal<T>): void {
  const hostNode = getLNode(previousOrParentTNode, viewData);

  const tView = getOrCreateTView(
      def.template, def.consts, def.vars, def.directiveDefs, def.pipeDefs, def.viewQuery);

  // Only component views should be added to the view tree directly. Embedded views are
  // accessed through their containers because they may be removed / re-added later.
  const componentView = addToViewTree(
      viewData, previousOrParentTNode.index as number,
      createLViewData(
          rendererFactory.createRenderer(hostNode.native as RElement, def), tView, null,
          def.onPush ? LViewFlags.Dirty : LViewFlags.CheckAlways, getCurrentSanitizer()));

  // We need to set the host node/data here because when the component LNode was created,
  // we didn't yet know it was a component (just an element).
  (hostNode as{data: LViewData}).data = componentView;
  (componentView as LViewData)[HOST_NODE] = previousOrParentTNode as TElementNode;

  if (firstTemplatePass) queueComponentIndexForCheck();
}

/**
 * A lighter version of directiveCreate() that is used for the root component
 *
 * This version does not contain features that we don't already support at root in
 * current Angular. Example: local refs and inputs on root component.
 */
export function baseDirectiveCreate<T>(
    index: number, directive: T, directiveDef: DirectiveDefInternal<T>| ComponentDefInternal<T>,
    hostNode: LNode): T {
  ngDevMode && assertEqual(
                   viewData[BINDING_INDEX], tView.bindingStartIndex,
                   'directives should be created before any bindings');
  ngDevMode && assertPreviousIsParent();

  attachPatchData(directive, viewData);
  if (hostNode) {
    attachPatchData(hostNode.native, viewData);
  }

  if (directives == null) viewData[DIRECTIVES] = directives = [];

  ngDevMode && assertDataNext(index, directives);
  directives[index] = directive;

  if (firstTemplatePass) {
    const flags = previousOrParentTNode.flags;
    if ((flags & TNodeFlags.DirectiveCountMask) === 0) {
      // When the first directive is created:
      // - save the index,
      // - set the number of directives to 1
      previousOrParentTNode.flags =
          index << TNodeFlags.DirectiveStartingIndexShift | flags & TNodeFlags.isComponent | 1;
    } else {
      // Only need to bump the size when subsequent directives are created
      ngDevMode && assertNotEqual(
                       flags & TNodeFlags.DirectiveCountMask, TNodeFlags.DirectiveCountMask,
                       'Reached the max number of directives');
      previousOrParentTNode.flags++;
    }
  } else {
    const diPublic = directiveDef !.diPublic;
    if (diPublic) diPublic(directiveDef !);
  }

  if (directiveDef !.attributes != null && previousOrParentTNode.type == TNodeType.Element) {
    setUpAttributes((hostNode as LElementNode).native, directiveDef !.attributes as string[]);
  }

  return directive;
}

/**
 * Sets initial input properties on directive instances from attribute data
 *
 * @param directiveIndex Index of the directive in directives array
 * @param instance Instance of the directive on which to set the initial inputs
 * @param inputs The list of inputs from the directive def
 * @param tNode The static data for this node
 */
function setInputsFromAttrs<T>(
    directiveIndex: number, instance: T, inputs: {[P in keyof T]: string;}, tNode: TNode): void {
  let initialInputData = tNode.initialInputs as InitialInputData | undefined;
  if (initialInputData === undefined || directiveIndex >= initialInputData.length) {
    initialInputData = generateInitialInputs(directiveIndex, inputs, tNode);
  }

  const initialInputs: InitialInputs|null = initialInputData[directiveIndex];
  if (initialInputs) {
    for (let i = 0; i < initialInputs.length; i += 2) {
      (instance as any)[initialInputs[i]] = initialInputs[i + 1];
    }
  }
}

/**
 * Generates initialInputData for a node and stores it in the template's static storage
 * so subsequent template invocations don't have to recalculate it.
 *
 * initialInputData is an array containing values that need to be set as input properties
 * for directives on this node, but only once on creation. We need this array to support
 * the case where you set an @Input property of a directive using attribute-like syntax.
 * e.g. if you have a `name` @Input, you can set it once like this:
 *
 * <my-component name="Bess"></my-component>
 *
 * @param directiveIndex Index to store the initial input data
 * @param inputs The list of inputs from the directive def
 * @param tNode The static data on this node
 */
function generateInitialInputs(
    directiveIndex: number, inputs: {[key: string]: string}, tNode: TNode): InitialInputData {
  const initialInputData: InitialInputData = tNode.initialInputs || (tNode.initialInputs = []);
  initialInputData[directiveIndex] = null;

  const attrs = tNode.attrs !;
  let i = 0;
  while (i < attrs.length) {
    const attrName = attrs[i];
    if (attrName === AttributeMarker.SelectOnly) break;
    if (attrName === AttributeMarker.NamespaceURI) {
      // We do not allow inputs on namespaced attributes.
      i += 4;
      continue;
    }
    const minifiedInputName = inputs[attrName];
    const attrValue = attrs[i + 1];

    if (minifiedInputName !== undefined) {
      const inputsToStore: InitialInputs =
          initialInputData[directiveIndex] || (initialInputData[directiveIndex] = []);
      inputsToStore.push(minifiedInputName, attrValue as string);
    }

    i += 2;
  }
  return initialInputData;
}

//////////////////////////
//// ViewContainer & View
//////////////////////////

/**
 * Creates a LContainer, either from a container instruction, or for a ViewContainerRef.
 *
 * @param currentView The parent view of the LContainer
 * @param isForViewContainerRef Optional a flag indicating the ViewContainerRef case
 * @returns LContainer
 */
export function createLContainer(
    currentView: LViewData, isForViewContainerRef?: boolean): LContainer {
  return [
    isForViewContainerRef ? null : 0,  // active index
    currentView,                       // parent
    null,                              // next
    null,                              // queries
    [],                                // views
    null                               // renderParent, set after node creation
  ];
}

/**
 * Creates an LContainerNode for an ng-template (dynamically-inserted view), e.g.
 *
 * <ng-template #foo>
 *    <div></div>
 * </ng-template>
 *
 * @param index The index of the container in the data array
 * @param templateFn Inline template
 * @param consts The number of nodes, local refs, and pipes for this template
 * @param vars The number of bindings for this template
 * @param tagName The name of the container element, if applicable
 * @param attrs The attrs attached to the container, if applicable
 * @param localRefs A set of local reference bindings on the element.
 * @param localRefExtractor A function which extracts local-refs values from the template.
 *        Defaults to the current element associated with the local-ref.
 */
export function template(
    index: number, templateFn: ComponentTemplate<any>| null, consts: number, vars: number,
    tagName?: string | null, attrs?: TAttributes | null, localRefs?: string[] | null,
    localRefExtractor?: LocalRefExtractor) {
  // TODO: consider a separate node type for templates
  const tNode = containerInternal(index, tagName || null, attrs || null);

  if (firstTemplatePass) {
    tNode.tViews = createTView(
        -1, templateFn, consts, vars, tView.directiveRegistry, tView.pipeRegistry, null);
  }

  createDirectivesAndLocals(localRefs, localRefExtractor);
  currentQueries &&
      (currentQueries = currentQueries.addNode(previousOrParentTNode as TContainerNode));
  queueLifecycleHooks(tNode.flags, tView);
  isParent = false;
}

/**
 * Creates an LContainerNode for inline views, e.g.
 *
 * % if (showing) {
 *   <div></div>
 * % }
 *
 * @param index The index of the container in the data array
 */
export function container(index: number): void {
  const tNode = containerInternal(index, null, null);
  firstTemplatePass && (tNode.tViews = []);
  isParent = false;
}

function containerInternal(
    index: number, tagName: string | null, attrs: TAttributes | null): TNode {
  ngDevMode && assertEqual(
                   viewData[BINDING_INDEX], tView.bindingStartIndex,
                   'container nodes should be created before any bindings');

  const lContainer = createLContainer(viewData);
  ngDevMode && ngDevMode.rendererCreateComment++;
  const comment = renderer.createComment(ngDevMode ? 'container' : '');
  const tNode = createNodeAtIndex(index, TNodeType.Container, comment, tagName, attrs, lContainer);

  lContainer[RENDER_PARENT] = getRenderParent(tNode, viewData);
  appendChild(comment, tNode, viewData);

  // Containers are added to the current view tree instead of their embedded views
  // because views can be removed and re-inserted.
  addToViewTree(viewData, index + HEADER_OFFSET, lContainer);

  if (currentQueries) {
    // prepare place for matching nodes from views inserted into a given container
    lContainer[QUERIES] = currentQueries.container();
  }

  ngDevMode && assertNodeType(previousOrParentTNode, TNodeType.Container);
  return tNode;
}

/**
 * Sets a container up to receive views.
 *
 * @param index The index of the container in the data array
 */
export function containerRefreshStart(index: number): void {
  previousOrParentTNode = loadInternal(index, tView.data) as TNode;

  ngDevMode && assertNodeType(previousOrParentTNode, TNodeType.Container);
  isParent = true;
  // Inline containers cannot have style bindings, so we can read the value directly
  (viewData[previousOrParentTNode.index] as LContainerNode).data[ACTIVE_INDEX] = 0;

  if (!checkNoChangesMode) {
    // We need to execute init hooks here so ngOnInit hooks are called in top level views
    // before they are called in embedded views (for backwards compatibility).
    executeInitHooks(viewData, tView, creationMode);
  }
}

/**
 * Marks the end of the LContainerNode.
 *
 * Marking the end of LContainerNode is the time when to child Views get inserted or removed.
 */
export function containerRefreshEnd(): void {
  if (isParent) {
    isParent = false;
  } else {
    ngDevMode && assertNodeType(previousOrParentTNode, TNodeType.View);
    ngDevMode && assertHasParent();
    previousOrParentTNode = previousOrParentTNode.parent !;
  }

  ngDevMode && assertNodeType(previousOrParentTNode, TNodeType.Container);

  // Inline containers cannot have style bindings, so we can read the value directly
  const lContainer = viewData[previousOrParentTNode.index].data;
  const nextIndex = lContainer[ACTIVE_INDEX];

  // remove extra views at the end of the container
  while (nextIndex < lContainer[VIEWS].length) {
    removeView(lContainer, previousOrParentTNode as TContainerNode, nextIndex);
  }
}

/**
 * Goes over dynamic embedded views (ones created through ViewContainerRef APIs) and refreshes them
 * by executing an associated template function.
 */
function refreshDynamicEmbeddedViews(lViewData: LViewData) {
  for (let current = getLViewChild(lViewData); current !== null; current = current[NEXT]) {
    // Note: current can be an LViewData or an LContainer instance, but here we are only interested
    // in LContainer. We can tell it's an LContainer because its length is less than the LViewData
    // header.
    if (current.length < HEADER_OFFSET && current[ACTIVE_INDEX] === null) {
      const container = current as LContainer;
      for (let i = 0; i < container[VIEWS].length; i++) {
        const dynamicViewData = container[VIEWS][i];
        // The directives and pipes are not needed here as an existing view is only being refreshed.
        ngDevMode && assertDefined(dynamicViewData[TVIEW], 'TView must be allocated');
        renderEmbeddedTemplate(
            dynamicViewData, dynamicViewData[TVIEW], dynamicViewData[CONTEXT] !,
            RenderFlags.Update);
      }
    }
  }
}


/**
 * Looks for a view with a given view block id inside a provided LContainer.
 * Removes views that need to be deleted in the process.
 *
 * @param lContainer to search for views
 * @param tContainerNode to search for views
 * @param startIdx starting index in the views array to search from
 * @param viewBlockId exact view block id to look for
 * @returns index of a found view or -1 if not found
 */
function scanForView(
    lContainer: LContainer, tContainerNode: TContainerNode, startIdx: number,
    viewBlockId: number): LViewData|null {
  const views = lContainer[VIEWS];
  for (let i = startIdx; i < views.length; i++) {
    const viewAtPositionId = views[i][TVIEW].id;
    if (viewAtPositionId === viewBlockId) {
      return views[i];
    } else if (viewAtPositionId < viewBlockId) {
      // found a view that should not be at this position - remove
      removeView(lContainer, tContainerNode, i);
    } else {
      // found a view with id greater than the one we are searching for
      // which means that required view doesn't exist and can't be found at
      // later positions in the views array - stop the search here
      break;
    }
  }
  return null;
}

/**
 * Marks the start of an embedded view.
 *
 * @param viewBlockId The ID of this view
 * @return boolean Whether or not this view is in creation mode
 */
export function embeddedViewStart(viewBlockId: number, consts: number, vars: number): RenderFlags {
  // The previous node can be a view node if we are processing an inline for loop
  const containerTNode = previousOrParentTNode.type === TNodeType.View ?
      previousOrParentTNode.parent ! :
      previousOrParentTNode;
  // Inline containers cannot have style bindings, so we can read the value directly
  const container = viewData[containerTNode.index] as LContainerNode;
  const currentView = viewData;

  ngDevMode && assertNodeType(containerTNode, TNodeType.Container);
  const lContainer = container.data;
  let viewToRender = scanForView(
      lContainer, containerTNode as TContainerNode, lContainer[ACTIVE_INDEX] !, viewBlockId);

  if (viewToRender) {
    isParent = true;
    enterView(viewToRender, viewToRender[TVIEW].node);
  } else {
    // When we create a new LView, we always reset the state of the instructions.
    viewToRender = createLViewData(
        renderer,
        getOrCreateEmbeddedTView(viewBlockId, consts, vars, containerTNode as TContainerNode), null,
        LViewFlags.CheckAlways, getCurrentSanitizer());

    if (lContainer[QUERIES]) {
      viewToRender[QUERIES] = lContainer[QUERIES] !.createView();
    }

    createNodeAtIndex(viewBlockId, TNodeType.View, null, null, null, viewToRender);
    enterView(viewToRender, viewToRender[TVIEW].node);
  }
  if (container) {
    if (creationMode) {
      // it is a new view, insert it into collection of views for a given container
      insertView(viewToRender, lContainer, currentView, lContainer[ACTIVE_INDEX] !, -1);
    }
    lContainer[ACTIVE_INDEX] !++;
  }
  return getRenderFlags(viewToRender);
}

/**
 * Initialize the TView (e.g. static data) for the active embedded view.
 *
 * Each embedded view block must create or retrieve its own TView. Otherwise, the embedded view's
 * static data for a particular node would overwrite the static data for a node in the view above
 * it with the same index (since it's in the same template).
 *
 * @param viewIndex The index of the TView in TNode.tViews
 * @param consts The number of nodes, local refs, and pipes in this template
 * @param vars The number of bindings and pure function bindings in this template
 * @param container The parent container in which to look for the view's static data
 * @returns TView
 */
function getOrCreateEmbeddedTView(
    viewIndex: number, consts: number, vars: number, parent: TContainerNode): TView {
  ngDevMode && assertNodeType(parent, TNodeType.Container);
  const containerTViews = parent.tViews as TView[];
  ngDevMode && assertDefined(containerTViews, 'TView expected');
  ngDevMode && assertEqual(Array.isArray(containerTViews), true, 'TViews should be in an array');
  if (viewIndex >= containerTViews.length || containerTViews[viewIndex] == null) {
    containerTViews[viewIndex] = createTView(
        viewIndex, null, consts, vars, tView.directiveRegistry, tView.pipeRegistry, null);
  }
  return containerTViews[viewIndex];
}

/** Marks the end of an embedded view. */
export function embeddedViewEnd(): void {
  const viewHost = viewData[HOST_NODE];
  refreshDescendantViews();
  leaveView(viewData[PARENT] !);
  previousOrParentTNode = viewHost !;
  isParent = false;
}

/////////////

/**
 * Refreshes components by entering the component view and processing its bindings, queries, etc.
 *
 * @param adjustedElementIndex  Element index in LViewData[] (adjusted for HEADER_OFFSET)
 */
export function componentRefresh<T>(adjustedElementIndex: number): void {
  ngDevMode && assertDataInRange(adjustedElementIndex);
  const element = readElementValue(viewData[adjustedElementIndex]) as LElementNode;
  ngDevMode && assertNodeType(tView.data[adjustedElementIndex] as TNode, TNodeType.Element);
  ngDevMode &&
      assertDefined(element.data, `Component's host node should have an LViewData attached.`);
  const hostView = element.data !;

  // Only attached CheckAlways components or attached, dirty OnPush components should be checked
  if (viewAttached(hostView) && hostView[FLAGS] & (LViewFlags.CheckAlways | LViewFlags.Dirty)) {
    detectChangesInternal(hostView, hostView[CONTEXT]);
  }
}

/** Returns a boolean for whether the view is attached */
export function viewAttached(view: LViewData): boolean {
  return (view[FLAGS] & LViewFlags.Attached) === LViewFlags.Attached;
}

/**
 * Instruction to distribute projectable nodes among <ng-content> occurrences in a given template.
 * It takes all the selectors from the entire component's template and decides where
 * each projected node belongs (it re-distributes nodes among "buckets" where each "bucket" is
 * backed by a selector).
 *
 * This function requires CSS selectors to be provided in 2 forms: parsed (by a compiler) and text,
 * un-parsed form.
 *
 * The parsed form is needed for efficient matching of a node against a given CSS selector.
 * The un-parsed, textual form is needed for support of the ngProjectAs attribute.
 *
 * Having a CSS selector in 2 different formats is not ideal, but alternatives have even more
 * drawbacks:
 * - having only a textual form would require runtime parsing of CSS selectors;
 * - we can't have only a parsed as we can't re-construct textual form from it (as entered by a
 * template author).
 *
 * @param selectors A collection of parsed CSS selectors
 * @param rawSelectors A collection of CSS selectors in the raw, un-parsed form
 */
export function projectionDef(selectors?: CssSelectorList[], textSelectors?: string[]): void {
  const componentNode = findComponentView(viewData)[HOST_NODE] as TElementNode;

  if (!componentNode.projection) {
    const noOfNodeBuckets = selectors ? selectors.length + 1 : 1;
    const pData: (TNode | null)[] = componentNode.projection =
        new Array(noOfNodeBuckets).fill(null);
    const tails: (TNode | null)[] = pData.slice();

    let componentChild: TNode|null = componentNode.child;

    while (componentChild !== null) {
      const bucketIndex =
          selectors ? matchingSelectorIndex(componentChild, selectors, textSelectors !) : 0;
      const nextNode = componentChild.next;

      if (tails[bucketIndex]) {
        tails[bucketIndex] !.next = componentChild;
      } else {
        pData[bucketIndex] = componentChild;
        componentChild.next = null;
      }
      tails[bucketIndex] = componentChild;

      componentChild = nextNode;
    }
  }
}

/**
 * Stack used to keep track of projection nodes in projection() instruction.
 *
 * This is deliberately created outside of projection() to avoid allocating
 * a new array each time the function is called. Instead the array will be
 * re-used by each invocation. This works because the function is not reentrant.
 */
const projectionNodeStack: (LViewData | TNode)[] = [];

/**
 * Inserts previously re-distributed projected nodes. This instruction must be preceded by a call
 * to the projectionDef instruction.
 *
 * @param nodeIndex
 * @param selectorIndex:
 *        - 0 when the selector is `*` (or unspecified as this is the default value),
 *        - 1 based index of the selector from the {@link projectionDef}
 */
export function projection(nodeIndex: number, selectorIndex: number = 0, attrs?: string[]): void {
  const tProjectionNode =
      createNodeAtIndex(nodeIndex, TNodeType.Projection, null, null, attrs || null, null);

  // We can't use viewData[HOST_NODE] because projection nodes can be nested in embedded views.
  if (tProjectionNode.projection === null) tProjectionNode.projection = selectorIndex;

  // `<ng-content>` has no content
  isParent = false;

  // re-distribution of projectable nodes is stored on a component's view level
  const componentView = findComponentView(viewData);
  const componentNode = componentView[HOST_NODE] as TElementNode;
  let nodeToProject = (componentNode.projection as(TNode | null)[])[selectorIndex];
  let projectedView = componentView[PARENT] !;
  let projectionNodeIndex = -1;

  while (nodeToProject) {
    if (nodeToProject.type === TNodeType.Projection) {
      // This node is re-projected, so we must go up the tree to get its projected nodes.
      const currentComponentView = findComponentView(projectedView);
      const currentComponentHost = currentComponentView[HOST_NODE] as TElementNode;
      const firstProjectedNode =
          (currentComponentHost.projection as(TNode | null)[])[nodeToProject.projection as number];

      if (firstProjectedNode) {
        projectionNodeStack[++projectionNodeIndex] = nodeToProject;
        projectionNodeStack[++projectionNodeIndex] = projectedView;

        nodeToProject = firstProjectedNode;
        projectedView = currentComponentView[PARENT] !;
        continue;
      }
    } else {
      const lNode = projectedView[nodeToProject.index] as LTextNode | LElementNode | LContainerNode;
      // This flag must be set now or we won't know that this node is projected
      // if the nodes are inserted into a container later.
      nodeToProject.flags |= TNodeFlags.isProjected;

      appendProjectedNode(lNode, nodeToProject, tProjectionNode, viewData, projectedView);
    }

    // If we are finished with a list of re-projected nodes, we need to get
    // back to the root projection node that was re-projected.
    if (nodeToProject.next === null && projectedView !== componentView[PARENT] !) {
      projectedView = projectionNodeStack[projectionNodeIndex--] as LViewData;
      nodeToProject = projectionNodeStack[projectionNodeIndex--] as TNode;
    }
    nodeToProject = nodeToProject.next;
  }
}

/**
 * Adds LViewData or LContainer to the end of the current view tree.
 *
 * This structure will be used to traverse through nested views to remove listeners
 * and call onDestroy callbacks.
 *
 * @param currentView The view where LViewData or LContainer should be added
 * @param adjustedHostIndex Index of the view's host node in LViewData[], adjusted for header
 * @param state The LViewData or LContainer to add to the view tree
 * @returns The state passed in
 */
export function addToViewTree<T extends LViewData|LContainer>(
    currentView: LViewData, adjustedHostIndex: number, state: T): T {
  if (currentView[TAIL]) {
    currentView[TAIL] ![NEXT] = state;
  } else if (firstTemplatePass) {
    tView.childIndex = adjustedHostIndex;
  }
  currentView[TAIL] = state;
  return state;
}

///////////////////////////////
//// Change detection
///////////////////////////////

/** If node is an OnPush component, marks its LViewData dirty. */
export function markDirtyIfOnPush(node: LElementNode): void {
  // Because data flows down the component tree, ancestors do not need to be marked dirty
  if (node.data && !(node.data[FLAGS] & LViewFlags.CheckAlways)) {
    node.data[FLAGS] |= LViewFlags.Dirty;
  }
}

/** Wraps an event listener with preventDefault behavior. */
export function wrapListenerWithPreventDefault(listenerFn: (e?: any) => any): EventListener {
  return function wrapListenerIn_preventDefault(e: Event) {
    if (listenerFn(e) === false) {
      e.preventDefault();
      // Necessary for legacy browsers that don't support preventDefault (e.g. IE)
      e.returnValue = false;
    }
  };
}

/** Marks current view and all ancestors dirty */
export function markViewDirty(view: LViewData): void {
  let currentView: LViewData = view;

  while (currentView && !(currentView[FLAGS] & LViewFlags.IsRoot)) {
    currentView[FLAGS] |= LViewFlags.Dirty;
    currentView = currentView[PARENT] !;
  }
  currentView[FLAGS] |= LViewFlags.Dirty;
  ngDevMode && assertDefined(currentView[CONTEXT], 'rootContext should be defined');

  const rootContext = currentView[CONTEXT] as RootContext;
  const nothingScheduled = rootContext.flags === RootContextFlags.Empty;
  rootContext.flags |= RootContextFlags.DetectChanges;
  if (nothingScheduled) {
    scheduleTick(rootContext);
  }
}

/**
 * Used to schedule change detection on the whole application.
 *
 * Unlike `tick`, `scheduleTick` coalesces multiple calls into one change detection run.
 * It is usually called indirectly by calling `markDirty` when the view needs to be
 * re-rendered.
 *
 * Typically `scheduleTick` uses `requestAnimationFrame` to coalesce multiple
 * `scheduleTick` requests. The scheduling function can be overridden in
 * `renderComponent`'s `scheduler` option.
 */
export function scheduleTick<T>(rootContext: RootContext) {
  if (rootContext.clean == _CLEAN_PROMISE) {
    let res: null|((val: null) => void);
    rootContext.clean = new Promise<null>((r) => res = r);
    rootContext.scheduler(() => {
      if (rootContext.flags & RootContextFlags.DetectChanges) {
        rootContext.flags &= ~RootContextFlags.DetectChanges;
        tickRootContext(rootContext);
      }

      if (rootContext.flags & RootContextFlags.FlushPlayers) {
        rootContext.flags &= ~RootContextFlags.FlushPlayers;
        const playerHandler = rootContext.playerHandler;
        if (playerHandler) {
          playerHandler.flushPlayers();
        }
      }

      rootContext.clean = _CLEAN_PROMISE;
      res !(null);
    });
  }
}

/**
 * Used to perform change detection on the whole application.
 *
 * This is equivalent to `detectChanges`, but invoked on root component. Additionally, `tick`
 * executes lifecycle hooks and conditionally checks components based on their
 * `ChangeDetectionStrategy` and dirtiness.
 *
 * The preferred way to trigger change detection is to call `markDirty`. `markDirty` internally
 * schedules `tick` using a scheduler in order to coalesce multiple `markDirty` calls into a
 * single change detection run. By default, the scheduler is `requestAnimationFrame`, but can
 * be changed when calling `renderComponent` and providing the `scheduler` option.
 */
export function tick<T>(component: T): void {
  const rootView = getRootView(component);
  const rootContext = rootView[CONTEXT] as RootContext;
  tickRootContext(rootContext);
}

function tickRootContext(rootContext: RootContext) {
  for (let i = 0; i < rootContext.components.length; i++) {
    const rootComponent = rootContext.components[i];
    renderComponentOrTemplate(readPatchedLViewData(rootComponent) !, rootComponent);
  }
}

/**
 * Synchronously perform change detection on a component (and possibly its sub-components).
 *
 * This function triggers change detection in a synchronous way on a component. There should
 * be very little reason to call this function directly since a preferred way to do change
 * detection is to {@link markDirty} the component and wait for the scheduler to call this method
 * at some future point in time. This is because a single user action often results in many
 * components being invalidated and calling change detection on each component synchronously
 * would be inefficient. It is better to wait until all components are marked as dirty and
 * then perform single change detection across all of the components
 *
 * @param component The component which the change detection should be performed on.
 */
export function detectChanges<T>(component: T): void {
  const hostNode = getLElementFromComponent(component) !;
  ngDevMode &&
      assertDefined(hostNode, 'Component host node should be attached to an LViewData instance.');
  detectChangesInternal(hostNode.data !, component);
}

/**
 * Synchronously perform change detection on a root view and its components.
 *
 * @param lViewData The view which the change detection should be performed on.
 */
export function detectChangesInRootView(lViewData: LViewData): void {
  tickRootContext(lViewData[CONTEXT] as RootContext);
}


/**
 * Checks the change detector and its children, and throws if any changes are detected.
 *
 * This is used in development mode to verify that running change detection doesn't
 * introduce other changes.
 */
export function checkNoChanges<T>(component: T): void {
  checkNoChangesMode = true;
  try {
    detectChanges(component);
  } finally {
    checkNoChangesMode = false;
  }
}

/**
 * Checks the change detector on a root view and its components, and throws if any changes are
 * detected.
 *
 * This is used in development mode to verify that running change detection doesn't
 * introduce other changes.
 *
 * @param lViewData The view which the change detection should be checked on.
 */
export function checkNoChangesInRootView(lViewData: LViewData): void {
  checkNoChangesMode = true;
  try {
    detectChangesInRootView(lViewData);
  } finally {
    checkNoChangesMode = false;
  }
}

/** Checks the view of the component provided. Does not gate on dirty checks or execute doCheck. */
export function detectChangesInternal<T>(hostView: LViewData, component: T) {
  const hostTView = hostView[TVIEW];
  const oldView = enterView(hostView, hostView[HOST_NODE]);
  const templateFn = hostTView.template !;
  const viewQuery = hostTView.viewQuery;

  try {
    namespaceHTML();
    createViewQuery(viewQuery, hostView[FLAGS], component);
    templateFn(getRenderFlags(hostView), component);
    refreshDescendantViews();
    updateViewQuery(viewQuery, component);
  } finally {
    leaveView(oldView);
  }
}

function createViewQuery<T>(
    viewQuery: ComponentQuery<{}>| null, flags: LViewFlags, component: T): void {
  if (viewQuery && (flags & LViewFlags.CreationMode)) {
    viewQuery(RenderFlags.Create, component);
  }
}

function updateViewQuery<T>(viewQuery: ComponentQuery<{}>| null, component: T): void {
  if (viewQuery) {
    viewQuery(RenderFlags.Update, component);
  }
}


/**
 * Mark the component as dirty (needing change detection).
 *
 * Marking a component dirty will schedule a change detection on this
 * component at some point in the future. Marking an already dirty
 * component as dirty is a noop. Only one outstanding change detection
 * can be scheduled per component tree. (Two components bootstrapped with
 * separate `renderComponent` will have separate schedulers)
 *
 * When the root component is bootstrapped with `renderComponent`, a scheduler
 * can be provided.
 *
 * @param component Component to mark as dirty.
 */
export function markDirty<T>(component: T) {
  ngDevMode && assertDefined(component, 'component');
  const elementNode = getLElementFromComponent(component) !;
  markViewDirty(elementNode.data as LViewData);
}

///////////////////////////////
//// Bindings & interpolations
///////////////////////////////

export interface NO_CHANGE {
  // This is a brand that ensures that this type can never match anything else
  brand: 'NO_CHANGE';
}

/** A special value which designates that a value has not changed. */
export const NO_CHANGE = {} as NO_CHANGE;

/**
 * Creates a single value binding.
 *
 * @param value Value to diff
 */
export function bind<T>(value: T): T|NO_CHANGE {
  return bindingUpdated(viewData[BINDING_INDEX]++, value) ? value : NO_CHANGE;
}

/**
 * Create interpolation bindings with a variable number of expressions.
 *
 * If there are 1 to 8 expressions `interpolation1()` to `interpolation8()` should be used instead.
 * Those are faster because there is no need to create an array of expressions and iterate over it.
 *
 * `values`:
 * - has static text at even indexes,
 * - has evaluated expressions at odd indexes.
 *
 * Returns the concatenated string when any of the arguments changes, `NO_CHANGE` otherwise.
 */
export function interpolationV(values: any[]): string|NO_CHANGE {
  ngDevMode && assertLessThan(2, values.length, 'should have at least 3 values');
  ngDevMode && assertEqual(values.length % 2, 1, 'should have an odd number of values');
  let different = false;

  for (let i = 1; i < values.length; i += 2) {
    // Check if bindings (odd indexes) have changed
    bindingUpdated(viewData[BINDING_INDEX]++, values[i]) && (different = true);
  }

  if (!different) {
    return NO_CHANGE;
  }

  // Build the updated content
  let content = values[0];
  for (let i = 1; i < values.length; i += 2) {
    content += stringify(values[i]) + values[i + 1];
  }

  return content;
}

/**
 * Creates an interpolation binding with 1 expression.
 *
 * @param prefix static value used for concatenation only.
 * @param v0 value checked for change.
 * @param suffix static value used for concatenation only.
 */
export function interpolation1(prefix: string, v0: any, suffix: string): string|NO_CHANGE {
  const different = bindingUpdated(viewData[BINDING_INDEX]++, v0);
  return different ? prefix + stringify(v0) + suffix : NO_CHANGE;
}

/** Creates an interpolation binding with 2 expressions. */
export function interpolation2(
    prefix: string, v0: any, i0: string, v1: any, suffix: string): string|NO_CHANGE {
  const different = bindingUpdated2(viewData[BINDING_INDEX], v0, v1);
  viewData[BINDING_INDEX] += 2;

  return different ? prefix + stringify(v0) + i0 + stringify(v1) + suffix : NO_CHANGE;
}

/** Creates an interpolation binding with 3 expressions. */
export function interpolation3(
    prefix: string, v0: any, i0: string, v1: any, i1: string, v2: any, suffix: string): string|
    NO_CHANGE {
  const different = bindingUpdated3(viewData[BINDING_INDEX], v0, v1, v2);
  viewData[BINDING_INDEX] += 3;

  return different ? prefix + stringify(v0) + i0 + stringify(v1) + i1 + stringify(v2) + suffix :
                     NO_CHANGE;
}

/** Create an interpolation binding with 4 expressions. */
export function interpolation4(
    prefix: string, v0: any, i0: string, v1: any, i1: string, v2: any, i2: string, v3: any,
    suffix: string): string|NO_CHANGE {
  const different = bindingUpdated4(viewData[BINDING_INDEX], v0, v1, v2, v3);
  viewData[BINDING_INDEX] += 4;

  return different ?
      prefix + stringify(v0) + i0 + stringify(v1) + i1 + stringify(v2) + i2 + stringify(v3) +
          suffix :
      NO_CHANGE;
}

/** Creates an interpolation binding with 5 expressions. */
export function interpolation5(
    prefix: string, v0: any, i0: string, v1: any, i1: string, v2: any, i2: string, v3: any,
    i3: string, v4: any, suffix: string): string|NO_CHANGE {
  let different = bindingUpdated4(viewData[BINDING_INDEX], v0, v1, v2, v3);
  different = bindingUpdated(viewData[BINDING_INDEX] + 4, v4) || different;
  viewData[BINDING_INDEX] += 5;

  return different ?
      prefix + stringify(v0) + i0 + stringify(v1) + i1 + stringify(v2) + i2 + stringify(v3) + i3 +
          stringify(v4) + suffix :
      NO_CHANGE;
}

/** Creates an interpolation binding with 6 expressions. */
export function interpolation6(
    prefix: string, v0: any, i0: string, v1: any, i1: string, v2: any, i2: string, v3: any,
    i3: string, v4: any, i4: string, v5: any, suffix: string): string|NO_CHANGE {
  let different = bindingUpdated4(viewData[BINDING_INDEX], v0, v1, v2, v3);
  different = bindingUpdated2(viewData[BINDING_INDEX] + 4, v4, v5) || different;
  viewData[BINDING_INDEX] += 6;

  return different ?
      prefix + stringify(v0) + i0 + stringify(v1) + i1 + stringify(v2) + i2 + stringify(v3) + i3 +
          stringify(v4) + i4 + stringify(v5) + suffix :
      NO_CHANGE;
}

/** Creates an interpolation binding with 7 expressions. */
export function interpolation7(
    prefix: string, v0: any, i0: string, v1: any, i1: string, v2: any, i2: string, v3: any,
    i3: string, v4: any, i4: string, v5: any, i5: string, v6: any, suffix: string): string|
    NO_CHANGE {
  let different = bindingUpdated4(viewData[BINDING_INDEX], v0, v1, v2, v3);
  different = bindingUpdated3(viewData[BINDING_INDEX] + 4, v4, v5, v6) || different;
  viewData[BINDING_INDEX] += 7;

  return different ?
      prefix + stringify(v0) + i0 + stringify(v1) + i1 + stringify(v2) + i2 + stringify(v3) + i3 +
          stringify(v4) + i4 + stringify(v5) + i5 + stringify(v6) + suffix :
      NO_CHANGE;
}

/** Creates an interpolation binding with 8 expressions. */
export function interpolation8(
    prefix: string, v0: any, i0: string, v1: any, i1: string, v2: any, i2: string, v3: any,
    i3: string, v4: any, i4: string, v5: any, i5: string, v6: any, i6: string, v7: any,
    suffix: string): string|NO_CHANGE {
  let different = bindingUpdated4(viewData[BINDING_INDEX], v0, v1, v2, v3);
  different = bindingUpdated4(viewData[BINDING_INDEX] + 4, v4, v5, v6, v7) || different;
  viewData[BINDING_INDEX] += 8;

  return different ?
      prefix + stringify(v0) + i0 + stringify(v1) + i1 + stringify(v2) + i2 + stringify(v3) + i3 +
          stringify(v4) + i4 + stringify(v5) + i5 + stringify(v6) + i6 + stringify(v7) + suffix :
      NO_CHANGE;
}

/** Store a value in the `data` at a given `index`. */
export function store<T>(index: number, value: T): void {
  // We don't store any static data for local variables, so the first time
  // we see the template, we should store as null to avoid a sparse array
  const adjustedIndex = index + HEADER_OFFSET;
  if (adjustedIndex >= tView.data.length) {
    tView.data[adjustedIndex] = null;
  }
  viewData[adjustedIndex] = value;
}

/**
 * Retrieves a local reference from the current contextViewData.
 *
 * If the reference to retrieve is in a parent view, this instruction is used in conjunction
 * with a nextContext() call, which walks up the tree and updates the contextViewData instance.
 *
 * @param index The index of the local ref in contextViewData.
 */
export function reference<T>(index: number) {
  return loadInternal<T>(index, contextViewData);
}

function walkUpViews(nestingLevel: number, currentView: LViewData): LViewData {
  while (nestingLevel > 0) {
    ngDevMode && assertDefined(
                     currentView[DECLARATION_VIEW],
                     'Declaration view should be defined if nesting level is greater than 0.');
    currentView = currentView[DECLARATION_VIEW] !;
    nestingLevel--;
  }
  return currentView;
}

/** Retrieves a value from the `directives` array. */
export function loadDirective<T>(index: number): T {
  ngDevMode && assertDefined(directives, 'Directives array should be defined if reading a dir.');
  ngDevMode && assertDataInRange(index, directives !);
  return directives ![index];
}

export function loadQueryList<T>(queryListIdx: number): QueryList<T> {
  ngDevMode && assertDefined(
                   viewData[CONTENT_QUERIES],
                   'Content QueryList array should be defined if reading a query.');
  ngDevMode && assertDataInRange(queryListIdx, viewData[CONTENT_QUERIES] !);

  return viewData[CONTENT_QUERIES] ![queryListIdx];
}

/** Retrieves a value from current `viewData`. */
export function load<T>(index: number): T {
  return loadInternal<T>(index, viewData);
}

export function loadElement(index: number): LElementNode {
  return loadElementInternal(index, viewData);
}

export function getTNode(index: number): TNode {
  return tView.data[index + HEADER_OFFSET] as TNode;
}

/** Gets the current binding value. */
export function getBinding(bindingIndex: number): any {
  ngDevMode && assertDataInRange(viewData[bindingIndex]);
  ngDevMode &&
      assertNotEqual(viewData[bindingIndex], NO_CHANGE, 'Stored value should never be NO_CHANGE.');
  return viewData[bindingIndex];
}

/** Updates binding if changed, then returns whether it was updated. */
export function bindingUpdated(bindingIndex: number, value: any): boolean {
  ngDevMode && assertNotEqual(value, NO_CHANGE, 'Incoming value should never be NO_CHANGE.');
  ngDevMode && assertLessThan(
                   bindingIndex, viewData.length, `Slot should have been initialized to NO_CHANGE`);

  if (viewData[bindingIndex] === NO_CHANGE) {
    viewData[bindingIndex] = value;
  } else if (isDifferent(viewData[bindingIndex], value, checkNoChangesMode)) {
    throwErrorIfNoChangesMode(creationMode, checkNoChangesMode, viewData[bindingIndex], value);
    viewData[bindingIndex] = value;
  } else {
    return false;
  }
  return true;
}

/** Updates binding and returns the value. */
export function updateBinding(bindingIndex: number, value: any): any {
  return viewData[bindingIndex] = value;
}

/** Updates 2 bindings if changed, then returns whether either was updated. */
export function bindingUpdated2(bindingIndex: number, exp1: any, exp2: any): boolean {
  const different = bindingUpdated(bindingIndex, exp1);
  return bindingUpdated(bindingIndex + 1, exp2) || different;
}

/** Updates 3 bindings if changed, then returns whether any was updated. */
export function bindingUpdated3(bindingIndex: number, exp1: any, exp2: any, exp3: any): boolean {
  const different = bindingUpdated2(bindingIndex, exp1, exp2);
  return bindingUpdated(bindingIndex + 2, exp3) || different;
}

/** Updates 4 bindings if changed, then returns whether any was updated. */
export function bindingUpdated4(
    bindingIndex: number, exp1: any, exp2: any, exp3: any, exp4: any): boolean {
  const different = bindingUpdated2(bindingIndex, exp1, exp2);
  return bindingUpdated2(bindingIndex + 2, exp3, exp4) || different;
}

export function getTView(): TView {
  return tView;
}

/**
 * Registers a QueryList, associated with a content query, for later refresh (part of a view
 * refresh).
 */
export function registerContentQuery<Q>(queryList: QueryList<Q>): void {
  const savedContentQueriesLength =
      (viewData[CONTENT_QUERIES] || (viewData[CONTENT_QUERIES] = [])).push(queryList);
  if (firstTemplatePass) {
    const currentDirectiveIndex = directives !.length - 1;
    const tViewContentQueries = tView.contentQueries || (tView.contentQueries = []);
    const lastSavedDirectiveIndex =
        tView.contentQueries.length ? tView.contentQueries[tView.contentQueries.length - 2] : -1;
    if (currentDirectiveIndex !== lastSavedDirectiveIndex) {
      tViewContentQueries.push(currentDirectiveIndex, savedContentQueriesLength - 1);
    }
  }
}

export function assertPreviousIsParent() {
  assertEqual(isParent, true, 'previousOrParentTNode should be a parent');
}

function assertHasParent() {
  assertDefined(previousOrParentTNode.parent, 'previousOrParentTNode should have a parent');
}

function assertDataInRange(index: number, arr?: any[]) {
  if (arr == null) arr = viewData;
  assertDataInRangeInternal(index, arr || viewData);
}

function assertDataNext(index: number, arr?: any[]) {
  if (arr == null) arr = viewData;
  assertEqual(
      arr.length, index, `index ${index} expected to be at the end of arr (length ${arr.length})`);
}

export const CLEAN_PROMISE = _CLEAN_PROMISE;
