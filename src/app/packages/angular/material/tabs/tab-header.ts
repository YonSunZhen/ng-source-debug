/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Direction, Directionality} from '@angular/cdk/bidi';
import {coerceNumberProperty} from '@angular/cdk/coercion';
import {END, ENTER, HOME, SPACE} from '@angular/cdk/keycodes';
import {ViewportRuler} from '@angular/cdk/scrolling';
import {
  AfterContentChecked,
  AfterContentInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ContentChildren,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnDestroy,
  Optional,
  Output,
  QueryList,
  ViewChild,
  ViewEncapsulation,
} from '@angular/core';
import {CanDisableRipple, CanDisableRippleCtor, mixinDisableRipple} from '@angular/material/core';
import {merge, of as observableOf, Subject} from 'rxjs';
import {takeUntil} from 'rxjs/operators';
import {MatInkBar} from './ink-bar';
import {MatTabLabelWrapper} from './tab-label-wrapper';
import {FocusKeyManager} from '@angular/cdk/a11y';


/**
 * The directions that scrolling can go in when the header's tabs exceed the header width. 'After'
 * will scroll the header towards the end of the tabs list and 'before' will scroll towards the
 * beginning of the list.
 */
export type ScrollDirection = 'after' | 'before';

/**
 * The distance in pixels that will be overshot when scrolling a tab label into view. This helps
 * provide a small affordance to the label next to it.
 */
const EXAGGERATED_OVERSCROLL = 60;

// Boilerplate for applying mixins to MatTabHeader.
/** @docs-private */
export class MatTabHeaderBase {}
export const _MatTabHeaderMixinBase: CanDisableRippleCtor & typeof MatTabHeaderBase =
    mixinDisableRipple(MatTabHeaderBase);

/**
 * The header of the tab group which displays a list of all the tabs in the tab group. Includes
 * an ink bar that follows the currently selected tab. When the tabs list's width exceeds the
 * width of the header container, then arrows will be displayed to allow the user to scroll
 * left and right across the header.
 * @docs-private
 */
@Component({
  moduleId: module.id,
  selector: 'mat-tab-header',
  templateUrl: 'tab-header.html',
  styleUrls: ['tab-header.css'],
  inputs: ['disableRipple'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'class': 'mat-tab-header',
    '[class.mat-tab-header-pagination-controls-enabled]': '_showPaginationControls',
    '[class.mat-tab-header-rtl]': "_getLayoutDirection() == 'rtl'",
  },
})
export class MatTabHeader extends _MatTabHeaderMixinBase
    implements AfterContentChecked, AfterContentInit, OnDestroy, CanDisableRipple {

  @ContentChildren(MatTabLabelWrapper) _labelWrappers: QueryList<MatTabLabelWrapper>;
  @ViewChild(MatInkBar) _inkBar: MatInkBar;
  @ViewChild('tabListContainer') _tabListContainer: ElementRef;
  @ViewChild('tabList') _tabList: ElementRef;

  /** The distance in pixels that the tab labels should be translated to the left. */
  private _scrollDistance = 0;

  /** Whether the header should scroll to the selected index after the view has been checked. */
  private _selectedIndexChanged = false;

  /** Emits when the component is destroyed. */
  private readonly _destroyed = new Subject<void>();

  /** Whether the controls for pagination should be displayed */
  _showPaginationControls = false;

  /** Whether the tab list can be scrolled more towards the end of the tab label list. */
  _disableScrollAfter = true;

  /** Whether the tab list can be scrolled more towards the beginning of the tab label list. */
  _disableScrollBefore = true;

  /**
   * The number of tab labels that are displayed on the header. When this changes, the header
   * should re-evaluate the scroll position.
   */
  private _tabLabelCount: number;

  /** Whether the scroll distance has changed and should be applied after the view is checked. */
  private _scrollDistanceChanged: boolean;

  /** Used to manage focus between the tabs. */
  private _keyManager: FocusKeyManager<MatTabLabelWrapper>;

  private _selectedIndex: number = 0;

  /** The index of the active tab. */
  @Input()
  get selectedIndex(): number { return this._selectedIndex; }
  set selectedIndex(value: number) {
    value = coerceNumberProperty(value);
    this._selectedIndexChanged = this._selectedIndex != value;
    this._selectedIndex = value;

    if (this._keyManager) {
      this._keyManager.updateActiveItemIndex(value);
    }
  }

  /** Event emitted when the option is selected. */
  @Output() readonly selectFocusedIndex = new EventEmitter();

  /** Event emitted when a label is focused. */
  @Output() readonly indexFocused = new EventEmitter();

  constructor(private _elementRef: ElementRef,
              private _changeDetectorRef: ChangeDetectorRef,
              private _viewportRuler: ViewportRuler,
              @Optional() private _dir: Directionality,
              // @breaking-change 8.0.0 `_ngZone` parameter to be made required.
              private _ngZone?: NgZone) {
    super();
  }

  ngAfterContentChecked(): void {
    // If the number of tab labels have changed, check if scrolling should be enabled
    if (this._tabLabelCount != this._labelWrappers.length) {
      this._updatePagination();
      this._tabLabelCount = this._labelWrappers.length;
      this._changeDetectorRef.markForCheck();
    }

    // If the selected index has changed, scroll to the label and check if the scrolling controls
    // should be disabled.
    if (this._selectedIndexChanged) {
      this._scrollToLabel(this._selectedIndex);
      this._checkScrollingControls();
      this._alignInkBarToSelectedTab();
      this._selectedIndexChanged = false;
      this._changeDetectorRef.markForCheck();
    }

    // If the scroll distance has been changed (tab selected, focused, scroll controls activated),
    // then translate the header to reflect this.
    if (this._scrollDistanceChanged) {
      this._updateTabScrollPosition();
      this._scrollDistanceChanged = false;
      this._changeDetectorRef.markForCheck();
    }
  }

  _handleKeydown(event: KeyboardEvent) {
    switch (event.keyCode) {
      case HOME:
        this._keyManager.setFirstItemActive();
        event.preventDefault();
        break;
      case END:
        this._keyManager.setLastItemActive();
        event.preventDefault();
        break;
      case ENTER:
      case SPACE:
        this.selectFocusedIndex.emit(this.focusIndex);
        event.preventDefault();
        break;
      default:
        this._keyManager.onKeydown(event);
    }
  }

  /**
   * Aligns the ink bar to the selected tab on load.
   */
  ngAfterContentInit() {
    const dirChange = this._dir ? this._dir.change : observableOf(null);
    const resize = this._viewportRuler.change(150);
    const realign = () => {
      this._updatePagination();
      this._alignInkBarToSelectedTab();
    };

    this._keyManager = new FocusKeyManager(this._labelWrappers)
      .withHorizontalOrientation(this._getLayoutDirection())
      .withWrap();

    this._keyManager.updateActiveItem(0);

    // Defer the first call in order to allow for slower browsers to lay out the elements.
    // This helps in cases where the user lands directly on a page with paginated tabs.
    typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(realign) : realign();

    // On dir change or window resize, realign the ink bar and update the orientation of
    // the key manager if the direction has changed.
    merge(dirChange, resize).pipe(takeUntil(this._destroyed)).subscribe(() => {
      realign();
      this._keyManager.withHorizontalOrientation(this._getLayoutDirection());
    });

    // If there is a change in the focus key manager we need to emit the `indexFocused`
    // event in order to provide a public event that notifies about focus changes. Also we realign
    // the tabs container by scrolling the new focused tab into the visible section.
    this._keyManager.change.pipe(takeUntil(this._destroyed)).subscribe(newFocusIndex => {
      this.indexFocused.emit(newFocusIndex);
      this._setTabFocus(newFocusIndex);
    });
  }

  ngOnDestroy() {
    this._destroyed.next();
    this._destroyed.complete();
  }

  /**
   * Callback for when the MutationObserver detects that the content has changed.
   */
  _onContentChanges() {
    const zoneCallback = () => {
      this._updatePagination();
      this._alignInkBarToSelectedTab();
      this._changeDetectorRef.markForCheck();
    };

    // The content observer runs outside the `NgZone` by default, which
    // means that we need to bring the callback back in ourselves.
    // @breaking-change 8.0.0 Remove null check for `_ngZone` once it's a required parameter.
    this._ngZone ? this._ngZone.run(zoneCallback) : zoneCallback();
  }

  /**
   * Updating the view whether pagination should be enabled or not
   */
  _updatePagination() {
    this._checkPaginationEnabled();
    this._checkScrollingControls();
    this._updateTabScrollPosition();
  }

  /** Tracks which element has focus; used for keyboard navigation */
  get focusIndex(): number {
    return this._keyManager ? this._keyManager.activeItemIndex! : 0;
  }

  /** When the focus index is set, we must manually send focus to the correct label */
  set focusIndex(value: number) {
    if (!this._isValidIndex(value) || this.focusIndex === value || !this._keyManager) {
      return;
    }

    this._keyManager.setActiveItem(value);
  }

  /**
   * Determines if an index is valid.  If the tabs are not ready yet, we assume that the user is
   * providing a valid index and return true.
   */
  _isValidIndex(index: number): boolean {
    if (!this._labelWrappers) { return true; }

    const tab = this._labelWrappers ? this._labelWrappers.toArray()[index] : null;
    return !!tab && !tab.disabled;
  }

  /**
   * Sets focus on the HTML element for the label wrapper and scrolls it into the view if
   * scrolling is enabled.
   */
  _setTabFocus(tabIndex: number) {
    if (this._showPaginationControls) {
      this._scrollToLabel(tabIndex);
    }

    if (this._labelWrappers && this._labelWrappers.length) {
      this._labelWrappers.toArray()[tabIndex].focus();

      // Do not let the browser manage scrolling to focus the element, this will be handled
      // by using translation. In LTR, the scroll left should be 0. In RTL, the scroll width
      // should be the full width minus the offset width.
      const containerEl = this._tabListContainer.nativeElement;
      const dir = this._getLayoutDirection();

      if (dir == 'ltr') {
        containerEl.scrollLeft = 0;
      } else {
        containerEl.scrollLeft = containerEl.scrollWidth - containerEl.offsetWidth;
      }
    }
  }

  /** The layout direction of the containing app. */
  _getLayoutDirection(): Direction {
    return this._dir && this._dir.value === 'rtl' ? 'rtl' : 'ltr';
  }

  /** Performs the CSS transformation on the tab list that will cause the list to scroll. */
  _updateTabScrollPosition() {
    const scrollDistance = this.scrollDistance;
    const translateX = this._getLayoutDirection() === 'ltr' ? -scrollDistance : scrollDistance;

    // Don't use `translate3d` here because we don't want to create a new layer. A new layer
    // seems to cause flickering and overflow in Internet Explorer. For example, the ink bar
    // and ripples will exceed the boundaries of the visible tab bar.
    // See: https://github.com/angular/material2/issues/10276
    this._tabList.nativeElement.style.transform = `translateX(${translateX}px)`;
  }

  /** Sets the distance in pixels that the tab header should be transformed in the X-axis. */
  get scrollDistance(): number { return this._scrollDistance; }
  set scrollDistance(v: number) {
    this._scrollDistance = Math.max(0, Math.min(this._getMaxScrollDistance(), v));

    // Mark that the scroll distance has changed so that after the view is checked, the CSS
    // transformation can move the header.
    this._scrollDistanceChanged = true;
    this._checkScrollingControls();
  }

  /**
   * Moves the tab list in the 'before' or 'after' direction (towards the beginning of the list or
   * the end of the list, respectively). The distance to scroll is computed to be a third of the
   * length of the tab list view window.
   *
   * This is an expensive call that forces a layout reflow to compute box and scroll metrics and
   * should be called sparingly.
   */
  _scrollHeader(scrollDir: ScrollDirection) {
    const viewLength = this._tabListContainer.nativeElement.offsetWidth;

    // Move the scroll distance one-third the length of the tab list's viewport.
    this.scrollDistance += (scrollDir == 'before' ? -1 : 1) * viewLength / 3;
  }

  /**
   * Moves the tab list such that the desired tab label (marked by index) is moved into view.
   *
   * This is an expensive call that forces a layout reflow to compute box and scroll metrics and
   * should be called sparingly.
   */
  _scrollToLabel(labelIndex: number) {
    const selectedLabel = this._labelWrappers ? this._labelWrappers.toArray()[labelIndex] : null;

    if (!selectedLabel) { return; }

    // The view length is the visible width of the tab labels.
    const viewLength = this._tabListContainer.nativeElement.offsetWidth;

    let labelBeforePos: number, labelAfterPos: number;
    if (this._getLayoutDirection() == 'ltr') {
      labelBeforePos = selectedLabel.getOffsetLeft();
      labelAfterPos = labelBeforePos + selectedLabel.getOffsetWidth();
    } else {
      labelAfterPos = this._tabList.nativeElement.offsetWidth - selectedLabel.getOffsetLeft();
      labelBeforePos = labelAfterPos - selectedLabel.getOffsetWidth();
    }

    const beforeVisiblePos = this.scrollDistance;
    const afterVisiblePos = this.scrollDistance + viewLength;

    if (labelBeforePos < beforeVisiblePos) {
      // Scroll header to move label to the before direction
      this.scrollDistance -= beforeVisiblePos - labelBeforePos + EXAGGERATED_OVERSCROLL;
    } else if (labelAfterPos > afterVisiblePos) {
      // Scroll header to move label to the after direction
      this.scrollDistance += labelAfterPos - afterVisiblePos + EXAGGERATED_OVERSCROLL;
    }
  }

  /**
   * Evaluate whether the pagination controls should be displayed. If the scroll width of the
   * tab list is wider than the size of the header container, then the pagination controls should
   * be shown.
   *
   * This is an expensive call that forces a layout reflow to compute box and scroll metrics and
   * should be called sparingly.
   */
  _checkPaginationEnabled() {
    const isEnabled =
        this._tabList.nativeElement.scrollWidth > this._elementRef.nativeElement.offsetWidth;

    if (!isEnabled) {
      this.scrollDistance = 0;
    }

    if (isEnabled !== this._showPaginationControls) {
      this._changeDetectorRef.markForCheck();
    }

    this._showPaginationControls = isEnabled;
  }

  /**
   * Evaluate whether the before and after controls should be enabled or disabled.
   * If the header is at the beginning of the list (scroll distance is equal to 0) then disable the
   * before button. If the header is at the end of the list (scroll distance is equal to the
   * maximum distance we can scroll), then disable the after button.
   *
   * This is an expensive call that forces a layout reflow to compute box and scroll metrics and
   * should be called sparingly.
   */
  _checkScrollingControls() {
    // Check if the pagination arrows should be activated.
    this._disableScrollBefore = this.scrollDistance == 0;
    this._disableScrollAfter = this.scrollDistance == this._getMaxScrollDistance();
    this._changeDetectorRef.markForCheck();
  }

  /**
   * Determines what is the maximum length in pixels that can be set for the scroll distance. This
   * is equal to the difference in width between the tab list container and tab header container.
   *
   * This is an expensive call that forces a layout reflow to compute box and scroll metrics and
   * should be called sparingly.
   */
  _getMaxScrollDistance(): number {
    const lengthOfTabList = this._tabList.nativeElement.scrollWidth;
    const viewLength = this._tabListContainer.nativeElement.offsetWidth;
    return (lengthOfTabList - viewLength) || 0;
  }

  /** Tells the ink-bar to align itself to the current label wrapper */
  _alignInkBarToSelectedTab(): void {
    const selectedLabelWrapper = this._labelWrappers && this._labelWrappers.length ?
        this._labelWrappers.toArray()[this.selectedIndex].elementRef.nativeElement :
        null;

    this._inkBar.alignToElement(selectedLabelWrapper!);
  }
}
