/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Directionality} from '@angular/cdk/bidi';
import {ViewportRuler} from '@angular/cdk/scrolling';
import {DOCUMENT} from '@angular/common';
import {
  AfterViewInit,
  ContentChild,
  ContentChildren,
  Directive,
  ElementRef,
  EmbeddedViewRef,
  EventEmitter,
  Inject,
  Input,
  NgZone,
  OnDestroy,
  Optional,
  Output,
  QueryList,
  SkipSelf,
  ViewContainerRef,
} from '@angular/core';
import {merge, Observable, Subject} from 'rxjs';
import {takeUntil, take} from 'rxjs/operators';
import {DragDropRegistry} from './drag-drop-registry';
import {
  CdkDragDrop,
  CdkDragEnd,
  CdkDragEnter,
  CdkDragExit,
  CdkDragMove,
  CdkDragStart,
} from './drag-events';
import {CdkDragHandle} from './drag-handle';
import {CdkDragPlaceholder} from './drag-placeholder';
import {CdkDragPreview} from './drag-preview';
import {CDK_DROP_CONTAINER, CdkDropContainer} from './drop-container';


// TODO(crisbeto): add auto-scrolling functionality.
// TODO(crisbeto): add an API for moving a draggable up/down the
// list programmatically. Useful for keyboard controls.

/**
 * Amount the pixels the user should drag before we
 * consider them to have changed the drag direction.
 */
const POINTER_DIRECTION_CHANGE_THRESHOLD = 5;

/** Element that can be moved inside a CdkDrop container. */
@Directive({
  selector: '[cdkDrag]',
  exportAs: 'cdkDrag',
  host: {
    'class': 'cdk-drag',
    '[class.cdk-drag-dragging]': '_isDragging()',
  }
})
export class CdkDrag<T = any> implements AfterViewInit, OnDestroy {
  private _document: Document;
  private _destroyed = new Subject<void>();

  /** Element displayed next to the user's pointer while the element is dragged. */
  private _preview: HTMLElement;

  /** Reference to the view of the preview element. */
  private _previewRef: EmbeddedViewRef<any> | null;

  /** Reference to the view of the placeholder element. */
  private _placeholderRef: EmbeddedViewRef<any> | null;

  /** Element that is rendered instead of the draggable item while it is being sorted. */
  private _placeholder: HTMLElement;

  /** Coordinates within the element at which the user picked up the element. */
  private _pickupPositionInElement: Point;

  /** Coordinates on the page at which the user picked up the element. */
  private _pickupPositionOnPage: Point;

  /**
   * Reference to the element that comes after the draggable in the DOM, at the time
   * it was picked up. Used for restoring its initial position when it's dropped.
   */
  private _nextSibling: Node | null;

  /**
   * CSS `transform` applied to the element when it isn't being dragged. We need a
   * passive transform in order for the dragged element to retain its new position
   * after the user has stopped dragging and because we need to know the relative
   * position in case they start dragging again. This corresponds to `element.style.transform`.
   */
  private _passiveTransform: Point = {x: 0, y: 0};

  /** CSS `transform` that is applied to the element while it's being dragged. */
  private _activeTransform: Point = {x: 0, y: 0};

  /** Whether the element has moved since the user started dragging it. */
  private _hasMoved: boolean;

  /** Drop container in which the CdkDrag resided when dragging began. */
  private _initialContainer: CdkDropContainer;

  /** Cached scroll position on the page when the element was picked up. */
  private _scrollPosition: {top: number, left: number};

  /** Emits when the item is being moved. */
  private _moveEvents = new Subject<CdkDragMove<T>>();

  /**
   * Amount of subscriptions to the move event. Used to avoid
   * hitting the zone if the consumer didn't subscribe to it.
   */
  private _moveEventSubscriptions = 0;

  /** Keeps track of the direction in which the user is dragging along each axis. */
  private _pointerDirectionDelta: {x: -1 | 0 | 1, y: -1 | 0 | 1};

  /** Pointer position at which the last change in the delta occurred. */
  private _pointerPositionAtLastDirectionChange: Point;

  /** Root element that will be dragged by the user. */
  private _rootElement: HTMLElement;

  /** Elements that can be used to drag the draggable item. */
  @ContentChildren(CdkDragHandle) _handles: QueryList<CdkDragHandle>;

  /** Element that will be used as a template to create the draggable item's preview. */
  @ContentChild(CdkDragPreview) _previewTemplate: CdkDragPreview;

  /** Template for placeholder element rendered to show where a draggable would be dropped. */
  @ContentChild(CdkDragPlaceholder) _placeholderTemplate: CdkDragPlaceholder;

  /** Arbitrary data to attach to this drag instance. */
  @Input('cdkDragData') data: T;

  /** Locks the position of the dragged element along the specified axis. */
  @Input('cdkDragLockAxis') lockAxis: 'x' | 'y';

  /**
   * Selector that will be used to determine the root draggable element, starting from
   * the `cdkDrag` element and going up the DOM. Passing an alternate root element is useful
   * when trying to enable dragging on an element that you might not have access to.
   */
  @Input('cdkDragRootElement') rootElementSelector: string;

  /** Emits when the user starts dragging the item. */
  @Output('cdkDragStarted') started: EventEmitter<CdkDragStart> = new EventEmitter<CdkDragStart>();

  /** Emits when the user stops dragging an item in the container. */
  @Output('cdkDragEnded') ended: EventEmitter<CdkDragEnd> = new EventEmitter<CdkDragEnd>();

  /** Emits when the user has moved the item into a new container. */
  @Output('cdkDragEntered') entered: EventEmitter<CdkDragEnter<any>> =
      new EventEmitter<CdkDragEnter<any>>();

  /** Emits when the user removes the item its container by dragging it into another container. */
  @Output('cdkDragExited') exited: EventEmitter<CdkDragExit<any>> =
      new EventEmitter<CdkDragExit<any>>();

  /** Emits when the user drops the item inside a container. */
  @Output('cdkDragDropped') dropped: EventEmitter<CdkDragDrop<any>> =
      new EventEmitter<CdkDragDrop<any>>();

  /**
   * Emits as the user is dragging the item. Use with caution,
   * because this event will fire for every pixel that the user has dragged.
   */
  @Output('cdkDragMoved') moved: Observable<CdkDragMove<T>> = Observable.create(observer => {
    const subscription = this._moveEvents.subscribe(observer);
    this._moveEventSubscriptions++;

    return () => {
      subscription.unsubscribe();
      this._moveEventSubscriptions--;
    };
  });

  constructor(
    /** Element that the draggable is attached to. */
    public element: ElementRef<HTMLElement>,
    /** Droppable container that the draggable is a part of. */
    @Inject(CDK_DROP_CONTAINER) @Optional() @SkipSelf() public dropContainer: CdkDropContainer,
    @Inject(DOCUMENT) document: any,
    private _ngZone: NgZone,
    private _viewContainerRef: ViewContainerRef,
    private _viewportRuler: ViewportRuler,
    private _dragDropRegistry: DragDropRegistry<CdkDrag<T>, CdkDropContainer>,
    @Optional() private _dir: Directionality) {
      this._document = document;
      _dragDropRegistry.registerDragItem(this);
    }

  /**
   * Returns the element that is being used as a placeholder
   * while the current element is being dragged.
   */
  getPlaceholderElement(): HTMLElement {
    return this._placeholder;
  }

  /** Returns the root draggable element. */
  getRootElement(): HTMLElement {
    return this._rootElement;
  }

  ngAfterViewInit() {
    // We need to wait for the zone to stabilize, in order for the reference
    // element to be in the proper place in the DOM. This is mostly relevant
    // for draggable elements inside portals since they get stamped out in
    // their original DOM position and then they get transferred to the portal.
    this._ngZone.onStable.asObservable().pipe(take(1)).subscribe(() => {
      const rootElement = this._rootElement = this._getRootElement();
      
      console.log(this._rootElement.innerText);

      // We need to bring the events back into the `NgZone`, because of the `onStable` call.
      this._ngZone.run(() => {
        rootElement.addEventListener('mousedown', this._startDragging);
        rootElement.addEventListener('touchstart', this._startDragging);
      });
    });
  }

  ngOnDestroy() {
    this._rootElement.removeEventListener('mousedown', this._startDragging);
    this._rootElement.removeEventListener('touchstart', this._startDragging);
    this._destroyPreview();
    this._destroyPlaceholder();

    // Do this check before removing from the registry since it'll
    // stop being considered as dragged once it is removed.
    if (this._isDragging()) {
      // Since we move out the element to the end of the body while it's being
      // dragged, we have to make sure that it's removed if it gets destroyed.
      this._removeElement(this._rootElement);
    }

    this._nextSibling = null;
    this._dragDropRegistry.removeDragItem(this);
    this._moveEvents.complete();
    this._destroyed.next();
    this._destroyed.complete();
  }

  /** Starts the dragging sequence. */
  _startDragging = (event: MouseEvent | TouchEvent) => {
    // Delegate the event based on whether it started from a handle or the element itself.
    if (this._handles.length) {
      const targetHandle = this._handles.find(handle => {
        const element = handle.element.nativeElement;
        const target = event.target;
        return !!target && (target === element || element.contains(target as HTMLElement));
      });

      if (targetHandle) {
        this._pointerDown(targetHandle.element.nativeElement, event);
      }
    } else {
      this._pointerDown(this._rootElement, event);
    }
  }

  /** Checks whether the element is currently being dragged. */
  _isDragging() {
    return this._dragDropRegistry.isDragging(this);
  }

  /** Handler for when the pointer is pressed down on the element or the handle. */
  private _pointerDown = (referenceElement: HTMLElement,
                          event: MouseEvent | TouchEvent) => {

    const isDragging = this._isDragging();

    // Abort if the user is already dragging or is using a mouse button other than the primary one.
    if (isDragging || (!this._isTouchEvent(event) && event.button !== 0)) {
      return;
    }

    const endedOrDestroyed = merge(this.ended, this._destroyed);

    this._hasMoved = false;
    this._dragDropRegistry.pointerMove
      .pipe(takeUntil(endedOrDestroyed))
      .subscribe(this._pointerMove);

    this._dragDropRegistry.pointerUp
      .pipe(takeUntil(endedOrDestroyed))
      .subscribe(this._pointerUp);

    this._dragDropRegistry.startDragging(this, event);
    this._initialContainer = this.dropContainer;
    this._scrollPosition = this._viewportRuler.getViewportScrollPosition();

    // If we have a custom preview template, the element won't be visible anyway so we avoid the
    // extra `getBoundingClientRect` calls and just move the preview next to the cursor.
    this._pickupPositionInElement = this._previewTemplate ? {x: 0, y: 0} :
        this._getPointerPositionInElement(referenceElement, event);
    const pointerPosition = this._pickupPositionOnPage = this._getPointerPositionOnPage(event);

    this._pointerDirectionDelta = {x: 0, y: 0};
    this._pointerPositionAtLastDirectionChange = {x: pointerPosition.x, y: pointerPosition.y};

    // Emit the event on the item before the one on the container.
    this.started.emit({source: this});

    if (this.dropContainer) {
      const element = this._rootElement;

      // Grab the `nextSibling` before the preview and placeholder
      // have been created so we don't get the preview by accident.
      this._nextSibling = element.nextSibling;

      const preview = this._preview = this._createPreviewElement();
      const placeholder = this._placeholder = this._createPlaceholderElement();

      // We move the element out at the end of the body and we make it hidden, because keeping it in
      // place will throw off the consumer's `:last-child` selectors. We can't remove the element
      // from the DOM completely, because iOS will stop firing all subsequent events in the chain.
      element.style.display = 'none';
      this._document.body.appendChild(element.parentNode!.replaceChild(placeholder, element));
      this._document.body.appendChild(preview);
      this.dropContainer.start();
    }
  }

  /** Handler that is invoked when the user moves their pointer after they've initiated a drag. */
  private _pointerMove = (event: MouseEvent | TouchEvent) => {
    // TODO(crisbeto): this should start dragging after a certain threshold,
    // otherwise we risk interfering with clicks on the element.
    if (!this._isDragging()) {
      return;
    }

    this._hasMoved = true;
    event.preventDefault();

    const pointerPosition = this._getConstrainedPointerPosition(event);
    const delta = this._updatePointerDirectionDelta(pointerPosition);

    if (this.dropContainer) {
      this._updateActiveDropContainer(pointerPosition);
    } else {
      const activeTransform = this._activeTransform;
      activeTransform.x =
          pointerPosition.x - this._pickupPositionOnPage.x + this._passiveTransform.x;
      activeTransform.y =
          pointerPosition.y - this._pickupPositionOnPage.y + this._passiveTransform.y;
      this._setTransform(this._rootElement, activeTransform.x, activeTransform.y);
    }

    // Since this event gets fired for every pixel while dragging, we only
    // want to fire it if the consumer opted into it. Also we have to
    // re-enter the zone because we run all of the events on the outside.
    if (this._moveEventSubscriptions > 0) {
      this._ngZone.run(() => {
        this._moveEvents.next({
          source: this,
          pointerPosition,
          event,
          delta
        });
      });
    }
  }

  /** Handler that is invoked when the user lifts their pointer up, after initiating a drag. */
  private _pointerUp = () => {
    if (!this._isDragging()) {
      return;
    }

    this._dragDropRegistry.stopDragging(this);

    if (!this.dropContainer) {
      // Convert the active transform into a passive one. This means that next time
      // the user starts dragging the item, its position will be calculated relatively
      // to the new passive transform.
      this._passiveTransform.x = this._activeTransform.x;
      this._passiveTransform.y = this._activeTransform.y;
      this._ngZone.run(() => this.ended.emit({source: this}));
      return;
    }

    this._animatePreviewToPlaceholder().then(() => this._cleanupDragArtifacts());
  }

  /** Cleans up the DOM artifacts that were added to facilitate the element being dragged. */
  private _cleanupDragArtifacts() {
    // Restore the element's visibility and insert it at its old position in the DOM.
    // It's important that we maintain the position, because moving the element around in the DOM
    // can throw off `NgFor` which does smart diffing and re-creates elements only when necessary,
    // while moving the existing elements in all other cases.
    this._rootElement.style.display = '';

    if (this._nextSibling) {
      this._nextSibling.parentNode!.insertBefore(this._rootElement, this._nextSibling);
    } else {
      this._initialContainer.element.nativeElement.appendChild(this._rootElement);
    }

    this._destroyPreview();
    this._destroyPlaceholder();

    // Re-enter the NgZone since we bound `document` events on the outside.
    this._ngZone.run(() => {
      const currentIndex = this.dropContainer.getItemIndex(this);

      this.ended.emit({source: this});
      this.dropped.emit({
        item: this,
        currentIndex,
        previousIndex: this._initialContainer.getItemIndex(this),
        container: this.dropContainer,
        previousContainer: this._initialContainer
      });
      this.dropContainer.drop(this, currentIndex, this._initialContainer);
      this.dropContainer = this._initialContainer;
    });
  }

  /**
   * Updates the item's position in its drop container, or moves it
   * into a new one, depending on its current drag position.
   */
  private _updateActiveDropContainer({x, y}) {
    // Drop container that draggable has been moved into.
    let newContainer = this.dropContainer._getSiblingContainerFromPosition(this, x, y);

    // If we couldn't find a new container to move the item into, and the item has left it's
    // initial container, check whether the it's allowed to return into its original container.
    // This handles the case where two containers are connected one way and the user tries to
    // undo dragging an item into a new container.
    if (!newContainer && this.dropContainer !== this._initialContainer &&
        this._initialContainer._canReturnItem(this, x, y)) {
      newContainer = this._initialContainer;
    }

    if (newContainer) {
      this._ngZone.run(() => {
        // Notify the old container that the item has left.
        this.exited.emit({item: this, container: this.dropContainer});
        this.dropContainer.exit(this);
        // Notify the new container that the item has entered.
        this.entered.emit({item: this, container: newContainer!});
        this.dropContainer = newContainer!;
        this.dropContainer.enter(this, x, y);
      });
    }

    this.dropContainer._sortItem(this, x, y, this._pointerDirectionDelta);
    this._setTransform(this._preview,
                       x - this._pickupPositionInElement.x,
                       y - this._pickupPositionInElement.y);
  }

  /**
   * Creates the element that will be rendered next to the user's pointer
   * and will be used as a preview of the element that is being dragged.
   */
  private _createPreviewElement(): HTMLElement {
    let preview: HTMLElement;

    if (this._previewTemplate) {
      const viewRef = this._viewContainerRef.createEmbeddedView(this._previewTemplate.templateRef,
                                                                this._previewTemplate.data);

      preview = viewRef.rootNodes[0];
      this._previewRef = viewRef;
      this._setTransform(preview, this._pickupPositionOnPage.x, this._pickupPositionOnPage.y);
    } else {
      const element = this._rootElement;
      const elementRect = element.getBoundingClientRect();

      preview = element.cloneNode(true) as HTMLElement;
      preview.style.width = `${elementRect.width}px`;
      preview.style.height = `${elementRect.height}px`;
      this._setTransform(preview, elementRect.left, elementRect.top);
    }

    preview.classList.add('cdk-drag-preview');
    preview.setAttribute('dir', this._dir ? this._dir.value : 'ltr');

    return preview;
  }

  /** Creates an element that will be shown instead of the current element while dragging. */
  private _createPlaceholderElement(): HTMLElement {
    let placeholder: HTMLElement;

    if (this._placeholderTemplate) {
      this._placeholderRef = this._viewContainerRef.createEmbeddedView(
        this._placeholderTemplate.templateRef,
        this._placeholderTemplate.data
      );
      placeholder = this._placeholderRef.rootNodes[0];
    } else {
      placeholder = this._rootElement.cloneNode(true) as HTMLElement;
    }

    placeholder.classList.add('cdk-drag-placeholder');
    return placeholder;
  }

  /**
   * Figures out the coordinates at which an element was picked up.
   * @param referenceElement Element that initiated the dragging.
   * @param event Event that initiated the dragging.
   */
  private _getPointerPositionInElement(referenceElement: HTMLElement,
                                       event: MouseEvent | TouchEvent): Point {
    const elementRect = this._rootElement.getBoundingClientRect();
    const handleElement = referenceElement === this._rootElement ? null : referenceElement;
    const referenceRect = handleElement ? handleElement.getBoundingClientRect() : elementRect;
    const point = this._isTouchEvent(event) ? event.targetTouches[0] : event;
    const x = point.pageX - referenceRect.left - this._scrollPosition.left;
    const y = point.pageY - referenceRect.top - this._scrollPosition.top;

    return {
      x: referenceRect.left - elementRect.left + x,
      y: referenceRect.top - elementRect.top + y
    };
  }

  /**
   * Animates the preview element from its current position to the location of the drop placeholder.
   * @returns Promise that resolves when the animation completes.
   */
  private _animatePreviewToPlaceholder(): Promise<void> {
    // If the user hasn't moved yet, the transitionend event won't fire.
    if (!this._hasMoved) {
      return Promise.resolve();
    }

    const placeholderRect = this._placeholder.getBoundingClientRect();

    // Apply the class that adds a transition to the preview.
    this._preview.classList.add('cdk-drag-animating');

    // Move the preview to the placeholder position.
    this._setTransform(this._preview, placeholderRect.left, placeholderRect.top);

    // If the element doesn't have a `transition`, the `transitionend` event won't fire. Since
    // we need to trigger a style recalculation in order for the `cdk-drag-animating` class to
    // apply its style, we take advantage of the available info to figure out whether we need to
    // bind the event in the first place.
    const duration = getTransformTransitionDurationInMs(this._preview);

    if (duration === 0) {
      return Promise.resolve();
    }

    return this._ngZone.runOutsideAngular(() => {
      return new Promise(resolve => {
        const handler = ((event: TransitionEvent) => {
          if (!event || (event.target === this._preview && event.propertyName === 'transform')) {
            this._preview.removeEventListener('transitionend', handler);
            resolve();
            clearTimeout(timeout);
          }
        });// as EventListenerOrEventListenerObject;

        // If a transition is short enough, the browser might not fire the `transitionend` event.
        // Since we know how long it's supposed to take, add a timeout with a 50% buffer that'll
        // fire if the transition hasn't completed when it was supposed to.
        const timeout = setTimeout(handler, duration * 1.5);
        this._preview.addEventListener('transitionend', handler);
      });
    });
  }

  /**
   * Sets the `transform` style on an element.
   * @param element Element on which to set the transform.
   * @param x Desired position of the element along the X axis.
   * @param y Desired position of the element along the Y axis.
   */
  private _setTransform(element: HTMLElement, x: number, y: number) {
    element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  /**
   * Helper to remove an element from the DOM and to do all the necessary null checks.
   * @param element Element to be removed.
   */
  private _removeElement(element: HTMLElement | null) {
    if (element && element.parentNode) {
      element.parentNode.removeChild(element);
    }
  }

  /** Determines the point of the page that was touched by the user. */
  private _getPointerPositionOnPage(event: MouseEvent | TouchEvent): Point {
    const point = this._isTouchEvent(event) ? event.touches[0] : event;

    return {
      x: point.pageX - this._scrollPosition.left,
      y: point.pageY - this._scrollPosition.top
    };
  }

  /** Gets the pointer position on the page, accounting for any position constraints. */
  private _getConstrainedPointerPosition(event: MouseEvent | TouchEvent): Point {
    const point = this._getPointerPositionOnPage(event);
    const dropContainerLock = this.dropContainer ? this.dropContainer.lockAxis : null;

    if (this.lockAxis === 'x' || dropContainerLock === 'x') {
      point.y = this._pickupPositionOnPage.y;
    } else if (this.lockAxis === 'y' || dropContainerLock === 'y') {
      point.x = this._pickupPositionOnPage.x;
    }

    return point;
  }

  /** Determines whether an event is a touch event. */
  private _isTouchEvent(event: MouseEvent | TouchEvent): event is TouchEvent {
    return event.type.startsWith('touch');
  }

  /** Destroys the preview element and its ViewRef. */
  private _destroyPreview() {
    if (this._preview) {
      this._removeElement(this._preview);
    }

    if (this._previewRef) {
      this._previewRef.destroy();
    }

    this._preview = this._previewRef = null!;
  }

  /** Destroys the placeholder element and its ViewRef. */
  private _destroyPlaceholder() {
    if (this._placeholder) {
      this._removeElement(this._placeholder);
    }

    if (this._placeholderRef) {
      this._placeholderRef.destroy();
    }

    this._placeholder = this._placeholderRef = null!;
  }

  /** Updates the current drag delta, based on the user's current pointer position on the page. */
  private _updatePointerDirectionDelta(pointerPositionOnPage: Point) {
    const {x, y} = pointerPositionOnPage;
    const delta = this._pointerDirectionDelta;
    const positionSinceLastChange = this._pointerPositionAtLastDirectionChange;

    // Amount of pixels the user has dragged since the last time the direction changed.
    const changeX = Math.abs(x - positionSinceLastChange.x);
    const changeY = Math.abs(y - positionSinceLastChange.y);

    // Because we handle pointer events on a per-pixel basis, we don't want the delta
    // to change for every pixel, otherwise anything that depends on it can look erratic.
    // To make the delta more consistent, we track how much the user has moved since the last
    // delta change and we only update it after it has reached a certain threshold.
    if (changeX > POINTER_DIRECTION_CHANGE_THRESHOLD) {
      delta.x = x > positionSinceLastChange.x ? 1 : -1;
      positionSinceLastChange.x = x;
    }

    if (changeY > POINTER_DIRECTION_CHANGE_THRESHOLD) {
      delta.y = y > positionSinceLastChange.y ? 1 : -1;
      positionSinceLastChange.y = y;
    }

    return delta;
  }

  /** Gets the root draggable element, based on the `rootElementSelector`. */
  private _getRootElement(): HTMLElement {
    if (this.rootElementSelector) {
      const selector = this.rootElementSelector;
      let currentElement = this.element.nativeElement.parentElement as HTMLElement | null;

      while (currentElement) {
        // IE doesn't support `matches` so we have to fall back to `msMatchesSelector`.
        if (currentElement.matches) {
          return currentElement;
        }

        currentElement = currentElement.parentElement;
      }
    }

    return this.element.nativeElement;
  }
}

/** Parses a CSS time value to milliseconds. */
function parseCssTimeUnitsToMs(value: string): number {
  // Some browsers will return it in seconds, whereas others will return milliseconds.
  const multiplier = value.toLowerCase().indexOf('ms') > -1 ? 1 : 1000;
  return parseFloat(value) * multiplier;
}

/** Gets the transform transition duration, including the delay, of an element in milliseconds. */
function getTransformTransitionDurationInMs(element: HTMLElement): number {
  const computedStyle = getComputedStyle(element);
  const transitionedProperties = parseCssPropertyValue(computedStyle, 'transition-property');
  const property = transitionedProperties.find(prop => prop === 'transform' || prop === 'all');

  // If there's no transition for `all` or `transform`, we shouldn't do anything.
  if (!property) {
    return 0;
  }

  // Get the index of the property that we're interested in and match
  // it up to the same index in `transition-delay` and `transition-duration`.
  const propertyIndex = transitionedProperties.indexOf(property);
  const rawDurations = parseCssPropertyValue(computedStyle, 'transition-duration');
  const rawDelays = parseCssPropertyValue(computedStyle, 'transition-delay');

  return parseCssTimeUnitsToMs(rawDurations[propertyIndex]) +
         parseCssTimeUnitsToMs(rawDelays[propertyIndex]);
}

/** Parses out multiple values from a computed style into an array. */
function parseCssPropertyValue(computedStyle: CSSStyleDeclaration, name: string): string[] {
  const value = computedStyle.getPropertyValue(name);
  return value.split(',').map(part => part.trim());
}

/** Point on the page or within an element. */
interface Point {
  x: number;
  y: number;
}
