import {DOWN_ARROW, TAB, UP_ARROW, LEFT_ARROW, RIGHT_ARROW} from '@angular/cdk/keycodes';
import {take} from 'rxjs/operators';
import {QueryList} from '@angular/core';
import {fakeAsync, tick} from '@angular/core/testing';
import {createKeyboardEvent} from '@angular/cdk/testing';
import {ActiveDescendantKeyManager} from './activedescendant-key-manager';
import {FocusKeyManager} from './focus-key-manager';
import {ListKeyManager} from './list-key-manager';
import {FocusOrigin} from '../focus-monitor/focus-monitor';
import {Subject} from 'rxjs';


class FakeFocusable {
  /** Whether the item is disabled or not. */
  disabled = false;
  /** Test property that can be used to test the `skipPredicate` functionality. */
  skipItem = false;
  constructor(private _label = '') {}
  focus(_focusOrigin?: FocusOrigin) {}
  getLabel() { return this._label; }
}

class FakeHighlightable {
  disabled = false;
  setActiveStyles() {}
  setInactiveStyles() {}
}

class FakeQueryList<T> extends QueryList<T> {
  changes = new Subject<FakeQueryList<T>>();
  items: T[];
  get length() { return this.items.length; }
  set length(_) { /* Empty setter for base class constructor */  }
  get first() { return this.items[0]; }
  toArray() { return this.items; }
  some() { return this.items.some.apply(this.items, arguments); }
  notifyOnChanges() { this.changes.next(this); }
}


describe('Key managers', () => {
  let itemList: FakeQueryList<any>;
  let fakeKeyEvents: {
    downArrow: KeyboardEvent,
    upArrow: KeyboardEvent,
    leftArrow: KeyboardEvent,
    rightArrow: KeyboardEvent,
    tab: KeyboardEvent,
    unsupported: KeyboardEvent
  };

  beforeEach(() => {
    itemList = new FakeQueryList<any>();
    fakeKeyEvents = {
      downArrow: createKeyboardEvent('keydown', DOWN_ARROW),
      upArrow: createKeyboardEvent('keydown', UP_ARROW),
      leftArrow: createKeyboardEvent('keydown', LEFT_ARROW),
      rightArrow: createKeyboardEvent('keydown', RIGHT_ARROW),
      tab: createKeyboardEvent('keydown', TAB),
      unsupported: createKeyboardEvent('keydown', 192) // corresponds to the tilde character (~)
    };
  });

  describe('ListKeyManager', () => {
    let keyManager: ListKeyManager<FakeFocusable>;

    beforeEach(() => {
      itemList.items = [
        new FakeFocusable('one'),
        new FakeFocusable('two'),
        new FakeFocusable('three')
      ];
      keyManager = new ListKeyManager<FakeFocusable>(itemList);

      // first item is already focused
      keyManager.setFirstItemActive();

      spyOn(keyManager, 'setActiveItem').and.callThrough();
    });

    it('should maintain the active item if the amount of items changes', () => {
      expect(keyManager.activeItemIndex).toBe(0);
      expect(keyManager.activeItem!.getLabel()).toBe('one');

      itemList.items.unshift(new FakeFocusable('zero'));
      itemList.notifyOnChanges();

      expect(keyManager.activeItemIndex).toBe(1);
      expect(keyManager.activeItem!.getLabel()).toBe('one');
    });

    describe('Key events', () => {

      it('should emit tabOut when the tab key is pressed', () => {
        const spy = jasmine.createSpy('tabOut spy');
        keyManager.tabOut.pipe(take(1)).subscribe(spy);
        keyManager.onKeydown(fakeKeyEvents.tab);

        expect(spy).toHaveBeenCalled();
      });

      it('should emit an event whenever the active item changes', () => {
        const spy = jasmine.createSpy('change spy');
        const subscription = keyManager.change.subscribe(spy);

        keyManager.onKeydown(fakeKeyEvents.downArrow);
        expect(spy).toHaveBeenCalledTimes(1);

        keyManager.onKeydown(fakeKeyEvents.upArrow);
        expect(spy).toHaveBeenCalledTimes(2);

        subscription.unsubscribe();
      });

      it('should activate the first item when pressing down on a clean key manager', () => {
        keyManager = new ListKeyManager<FakeFocusable>(itemList);

        expect(keyManager.activeItemIndex).toBe(-1, 'Expected active index to default to -1.');

        keyManager.onKeydown(fakeKeyEvents.downArrow);

        expect(keyManager.activeItemIndex).toBe(0, 'Expected first item to become active.');
      });

      it('should not prevent the default keyboard action when pressing tab', () => {
        expect(fakeKeyEvents.tab.defaultPrevented).toBe(false);

        keyManager.onKeydown(fakeKeyEvents.tab);

        expect(fakeKeyEvents.tab.defaultPrevented).toBe(false);
      });

      it('should not do anything for unsupported key presses', () => {
        keyManager.setActiveItem(1);

        expect(keyManager.activeItemIndex).toBe(1);
        expect(fakeKeyEvents.unsupported.defaultPrevented).toBe(false);

        keyManager.onKeydown(fakeKeyEvents.unsupported);

        expect(keyManager.activeItemIndex).toBe(1);
        expect(fakeKeyEvents.unsupported.defaultPrevented).toBe(false);
      });

      it('should ignore the horizontal keys when only in vertical mode', () => {
        keyManager.withVerticalOrientation().withHorizontalOrientation(null);

        expect(keyManager.activeItemIndex).toBe(0);

        keyManager.onKeydown(fakeKeyEvents.rightArrow);

        expect(keyManager.activeItemIndex).toBe(0);
        expect(fakeKeyEvents.rightArrow.defaultPrevented).toBe(false);
      });

      it('should ignore the horizontal keys when only in horizontal mode', () => {
        keyManager.withVerticalOrientation(false).withHorizontalOrientation('ltr');

        expect(keyManager.activeItemIndex).toBe(0);

        keyManager.onKeydown(fakeKeyEvents.downArrow);

        expect(keyManager.activeItemIndex).toBe(0);
        expect(fakeKeyEvents.downArrow.defaultPrevented).toBe(false);
      });

      describe('with `vertical` direction', () => {
        beforeEach(() => {
          keyManager.withVerticalOrientation();
          this.nextKeyEvent = createKeyboardEvent('keydown', DOWN_ARROW);
          this.prevKeyEvent = createKeyboardEvent('keydown', UP_ARROW);
        });

        runDirectionalKeyTests.call(this);
      });

      describe('with `ltr` direction', () => {
        beforeEach(() => {
          keyManager.withHorizontalOrientation('ltr');
          this.nextKeyEvent = createKeyboardEvent('keydown', RIGHT_ARROW);
          this.prevKeyEvent = createKeyboardEvent('keydown', LEFT_ARROW);
        });

        runDirectionalKeyTests.call(this);
      });

      describe('with `rtl` direction', () => {
        beforeEach(() => {
          keyManager.withHorizontalOrientation('rtl');
          this.nextKeyEvent = createKeyboardEvent('keydown', LEFT_ARROW);
          this.prevKeyEvent = createKeyboardEvent('keydown', RIGHT_ARROW);
        });

        runDirectionalKeyTests.call(this);
      });

      /**
       * Defines the directional key tests that should be run in a particular context. Note that
       * parameters have to be passed in via Jasmine's context object (`this` inside a `beforeEach`)
       * because this function has to run before any `beforeEach`, `beforeAll` etc. hooks.
       */
      function runDirectionalKeyTests() {
        it('should set subsequent items as active when the next key is pressed', () => {
          keyManager.onKeydown(this.nextKeyEvent);

          expect(keyManager.activeItemIndex)
              .toBe(1, 'Expected active item to be 1 after one next key event.');
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(0);
          expect(keyManager.setActiveItem).toHaveBeenCalledWith(1);
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(2);

          keyManager.onKeydown(this.nextKeyEvent);
          expect(keyManager.activeItemIndex)
              .toBe(2, 'Expected active item to be 2 after two next key events.');
          expect(keyManager.setActiveItem).toHaveBeenCalledWith(2);
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(0);
        });

        it('should set first item active when the next key is pressed if no active item', () => {
          keyManager.setActiveItem(-1);
          keyManager.onKeydown(this.nextKeyEvent);

          expect(keyManager.activeItemIndex)
              .toBe(0, 'Expected active item to be 0 after next key if active item was null.');
          expect(keyManager.setActiveItem).toHaveBeenCalledWith(0);
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(1);
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(2);
        });

        it('should set previous items as active when the previous key is pressed', () => {
          keyManager.onKeydown(this.nextKeyEvent);

          expect(keyManager.activeItemIndex)
              .toBe(1, 'Expected active item to be 1 after one next key event.');
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(0);
          expect(keyManager.setActiveItem).toHaveBeenCalledWith(1);

          keyManager.onKeydown(this.prevKeyEvent);
          expect(keyManager.activeItemIndex)
              .toBe(0, 'Expected active item to be 0 after one next and one previous key event.');
          expect(keyManager.setActiveItem).toHaveBeenCalledWith(0);
        });

        it('should do nothing when the prev key is pressed if no active item and not wrap', () => {
          keyManager.setActiveItem(-1);
          keyManager.onKeydown(this.prevKeyEvent);

          expect(keyManager.activeItemIndex)
              .toBe(-1, 'Expected nothing to happen if prev event occurs and no active item.');
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(0);
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(1);
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(2);
        });

        it('should skip disabled items', () => {
          itemList.items[1].disabled = true;

          // Next event should skip past disabled item from 0 to 2
          keyManager.onKeydown(this.nextKeyEvent);
          expect(keyManager.activeItemIndex)
              .toBe(2, 'Expected active item to skip past disabled item on next event.');
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(0);
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(1);
          expect(keyManager.setActiveItem).toHaveBeenCalledWith(2);

          // Previous event should skip past disabled item from 2 to 0
          keyManager.onKeydown(this.prevKeyEvent);
          expect(keyManager.activeItemIndex)
              .toBe(0, 'Expected active item to skip past disabled item on up arrow.');
          expect(keyManager.setActiveItem).toHaveBeenCalledWith(0);
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(1);
        });

        it('should work normally when disabled property does not exist', () => {
          itemList.items[0].disabled = undefined;
          itemList.items[1].disabled = undefined;
          itemList.items[2].disabled = undefined;

          keyManager.onKeydown(this.nextKeyEvent);
          expect(keyManager.activeItemIndex)
              .toBe(1, 'Expected active item to be 1 after one next event when disabled not set.');
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(0);
          expect(keyManager.setActiveItem).toHaveBeenCalledWith(1);
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(2);

          keyManager.onKeydown(this.nextKeyEvent);
          expect(keyManager.activeItemIndex)
              .toBe(2, 'Expected active item to be 2 after two next events when disabled not set.');
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(0);
          expect(keyManager.setActiveItem).toHaveBeenCalledWith(2);
        });

        it('should not move active item past either end of the list', () => {
          keyManager.onKeydown(this.nextKeyEvent);
          keyManager.onKeydown(this.nextKeyEvent);
          expect(keyManager.activeItemIndex)
              .toBe(2, `Expected last item of the list to be active.`);

          // This next event would move active item past the end of the list
          keyManager.onKeydown(this.nextKeyEvent);
          expect(keyManager.activeItemIndex)
              .toBe(2, `Expected active item to remain at the end of the list.`);

          keyManager.onKeydown(this.prevKeyEvent);
          keyManager.onKeydown(this.prevKeyEvent);
          expect(keyManager.activeItemIndex)
              .toBe(0, `Expected first item of the list to be active.`);

          // This prev event would move active item past the beginning of the list
          keyManager.onKeydown(this.prevKeyEvent);
          expect(keyManager.activeItemIndex)
              .toBe(0, `Expected active item to remain at the beginning of the list.`);
        });

        it('should not move active item to end when the last item is disabled', () => {
          itemList.items[2].disabled = true;
          keyManager.onKeydown(this.nextKeyEvent);
          expect(keyManager.activeItemIndex)
              .toBe(1, `Expected second item of the list to be active.`);

          // This next key event would set active item to the last item, which is disabled
          keyManager.onKeydown(this.nextKeyEvent);
          expect(keyManager.activeItemIndex)
              .toBe(1, `Expected the second item to remain active.`);
          expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(2);
        });

        it('should prevent the default keyboard action of handled events', () => {
          expect(this.nextKeyEvent.defaultPrevented).toBe(false);
          keyManager.onKeydown(this.nextKeyEvent);
          expect(this.nextKeyEvent.defaultPrevented).toBe(true);

          expect(this.prevKeyEvent.defaultPrevented).toBe(false);
          keyManager.onKeydown(this.prevKeyEvent);
          expect(this.prevKeyEvent.defaultPrevented).toBe(true);
        });
      }

    });

    describe('programmatic focus', () => {

      it('should setActiveItem()', () => {
        expect(keyManager.activeItemIndex)
            .toBe(0, `Expected first item of the list to be active.`);

        keyManager.setActiveItem(1);
        expect(keyManager.activeItemIndex)
            .toBe(1, `Expected activeItemIndex to be updated when setActiveItem() was called.`);
      });

      it('should be able to set the active item by reference', () => {
        expect(keyManager.activeItemIndex)
            .toBe(0, `Expected first item of the list to be active.`);

        keyManager.setActiveItem(itemList.items[2]);
        expect(keyManager.activeItemIndex)
            .toBe(2, `Expected activeItemIndex to be updated.`);
      });

      it('should be able to set the active item without emitting an event', () => {
        const spy = jasmine.createSpy('change spy');
        const subscription = keyManager.change.subscribe(spy);

        expect(keyManager.activeItemIndex).toBe(0);

        keyManager.updateActiveItem(2);

        expect(keyManager.activeItemIndex).toBe(2);
        expect(spy).not.toHaveBeenCalled();

        subscription.unsubscribe();
      });

      it('should expose the active item correctly', () => {
        keyManager.onKeydown(fakeKeyEvents.downArrow);

        expect(keyManager.activeItemIndex).toBe(1, 'Expected active item to be the second option.');
        expect(keyManager.activeItem)
            .toBe(itemList.items[1], 'Expected the active item to match the second option.');


        keyManager.onKeydown(fakeKeyEvents.downArrow);
        expect(keyManager.activeItemIndex).toBe(2, 'Expected active item to be the third option.');
        expect(keyManager.activeItem)
            .toBe(itemList.items[2], 'Expected the active item ID to match the third option.');
      });

      it('should setFirstItemActive()', () => {
        keyManager.onKeydown(fakeKeyEvents.downArrow);
        keyManager.onKeydown(fakeKeyEvents.downArrow);
        expect(keyManager.activeItemIndex)
            .toBe(2, `Expected last item of the list to be active.`);

        keyManager.setFirstItemActive();
        expect(keyManager.activeItemIndex)
            .toBe(0, `Expected setFirstItemActive() to set the active item to the first item.`);
      });

      it('should set the active item to the second item if the first one is disabled', () => {
        itemList.items[0].disabled = true;

        keyManager.setFirstItemActive();
        expect(keyManager.activeItemIndex)
            .toBe(1, `Expected the second item to be active if the first was disabled.`);
      });

      it('should setLastItemActive()', () => {
        expect(keyManager.activeItemIndex)
            .toBe(0, `Expected first item of the list to be active.`);

        keyManager.setLastItemActive();
        expect(keyManager.activeItemIndex)
            .toBe(2, `Expected setLastItemActive() to set the active item to the last item.`);
      });

      it('should set the active item to the second to last item if the last is disabled', () => {
        itemList.items[2].disabled = true;

        keyManager.setLastItemActive();
        expect(keyManager.activeItemIndex)
            .toBe(1, `Expected the second to last item to be active if the last was disabled.`);
      });

      it('should setNextItemActive()', () => {
        expect(keyManager.activeItemIndex)
            .toBe(0, `Expected first item of the list to be active.`);

        keyManager.setNextItemActive();
        expect(keyManager.activeItemIndex)
            .toBe(1, `Expected setNextItemActive() to set the active item to the next item.`);
      });

      it('should set the active item to the next enabled item if next is disabled', () => {
        itemList.items[1].disabled = true;
        expect(keyManager.activeItemIndex)
            .toBe(0, `Expected first item of the list to be active.`);

        keyManager.setNextItemActive();
        expect(keyManager.activeItemIndex)
            .toBe(2, `Expected setNextItemActive() to only set enabled items as active.`);
      });

      it('should setPreviousItemActive()', () => {
        keyManager.onKeydown(fakeKeyEvents.downArrow);
        expect(keyManager.activeItemIndex)
            .toBe(1, `Expected second item of the list to be active.`);

        keyManager.setPreviousItemActive();
        expect(keyManager.activeItemIndex)
            .toBe(0, `Expected setPreviousItemActive() to set the active item to the previous.`);
      });

      it('should skip disabled items when setPreviousItemActive() is called', () => {
        itemList.items[1].disabled = true;
        keyManager.onKeydown(fakeKeyEvents.downArrow);
        keyManager.onKeydown(fakeKeyEvents.downArrow);
        expect(keyManager.activeItemIndex)
            .toBe(2, `Expected third item of the list to be active.`);

        keyManager.setPreviousItemActive();
        expect(keyManager.activeItemIndex)
            .toBe(0, `Expected setPreviousItemActive() to skip the disabled item.`);
      });

      it('should not emit an event if the item did not change', () => {
        const spy = jasmine.createSpy('change spy');
        const subscription = keyManager.change.subscribe(spy);

        keyManager.setActiveItem(2);
        keyManager.setActiveItem(2);

        expect(spy).toHaveBeenCalledTimes(1);

        subscription.unsubscribe();
      });

    });

    describe('wrap mode', () => {

      it('should return itself to allow chaining', () => {
        expect(keyManager.withWrap())
            .toEqual(keyManager, `Expected withWrap() to return an instance of ListKeyManager.`);
      });

      it('should wrap focus when arrow keying past items while in wrap mode', () => {
        keyManager.withWrap();
        keyManager.onKeydown(fakeKeyEvents.downArrow);
        keyManager.onKeydown(fakeKeyEvents.downArrow);

        expect(keyManager.activeItemIndex).toBe(2, 'Expected last item to be active.');

        // this down arrow moves down past the end of the list
        keyManager.onKeydown(fakeKeyEvents.downArrow);
        expect(keyManager.activeItemIndex).toBe(0, 'Expected active item to wrap to beginning.');

        // this up arrow moves up past the beginning of the list
        keyManager.onKeydown(fakeKeyEvents.upArrow);
        expect(keyManager.activeItemIndex).toBe(2, 'Expected active item to wrap to end.');
      });

      it('should set last item active when up arrow is pressed if no active item', () => {
        keyManager.withWrap();
        keyManager.setActiveItem(-1);
        keyManager.onKeydown(fakeKeyEvents.upArrow);

        expect(keyManager.activeItemIndex)
            .toBe(2, 'Expected last item to be active on up arrow if no active item.');
        expect(keyManager.setActiveItem).not.toHaveBeenCalledWith(0);
        expect(keyManager.setActiveItem).toHaveBeenCalledWith(2);

        keyManager.onKeydown(fakeKeyEvents.downArrow);
        expect(keyManager.activeItemIndex)
            .toBe(0, 'Expected active item to be 0 after wrapping back to beginning.');
        expect(keyManager.setActiveItem).toHaveBeenCalledWith(0);
      });

      // This test should pass if all items are disabled and the down arrow key got pressed.
      // If the test setup crashes or this test times out, this test can be considered as failed.
      it('should not get into an infinite loop if all items are disabled', () => {
        keyManager.withWrap();
        keyManager.setActiveItem(0);

        itemList.items.forEach(item => item.disabled = true);

        keyManager.onKeydown(fakeKeyEvents.downArrow);
      });

      it('should be able to disable wrapping', () => {
        keyManager.withWrap();
        keyManager.setFirstItemActive();
        keyManager.onKeydown(fakeKeyEvents.upArrow);

        expect(keyManager.activeItemIndex).toBe(itemList.items.length - 1);

        keyManager.withWrap(false);
        keyManager.setFirstItemActive();
        keyManager.onKeydown(fakeKeyEvents.upArrow);

        expect(keyManager.activeItemIndex).toBe(0);
      });
    });

    describe('skip predicate', () => {

      it('should skip disabled items by default', () => {
        itemList.items[1].disabled = true;

        expect(keyManager.activeItemIndex).toBe(0);

        keyManager.onKeydown(fakeKeyEvents.downArrow);

        expect(keyManager.activeItemIndex).toBe(2);
      });

      it('should be able to skip items with a custom predicate', () => {
        keyManager.skipPredicate(item => item.skipItem);

        itemList.items[1].skipItem = true;

        expect(keyManager.activeItemIndex).toBe(0);

        keyManager.onKeydown(fakeKeyEvents.downArrow);

        expect(keyManager.activeItemIndex).toBe(2);
      });
    });

    describe('typeahead mode', () => {
      const debounceInterval = 300;

      beforeEach(() => {
        keyManager.withTypeAhead(debounceInterval);
        keyManager.setActiveItem(-1);
      });

      it('should throw if the items do not implement the getLabel method', () => {
        const invalidQueryList = new FakeQueryList();

        invalidQueryList.items = [{ disabled: false }];

        const invalidManager = new ListKeyManager(invalidQueryList);

        expect(() => invalidManager.withTypeAhead()).toThrowError(/must implement/);
      });

      it('should debounce the input key presses', fakeAsync(() => {
        keyManager.onKeydown(createKeyboardEvent('keydown', 79, undefined, 'o')); // types "o"
        keyManager.onKeydown(createKeyboardEvent('keydown', 78, undefined, 'n')); // types "n"
        keyManager.onKeydown(createKeyboardEvent('keydown', 69, undefined, 'e')); // types "e"

        expect(keyManager.activeItem).not.toBe(itemList.items[0]);

        tick(debounceInterval);

        expect(keyManager.activeItem).toBe(itemList.items[0]);
      }));

      it('should focus the first item that starts with a letter', fakeAsync(() => {
        keyManager.onKeydown(createKeyboardEvent('keydown', 84, undefined, 't')); // types "t"

        tick(debounceInterval);

        expect(keyManager.activeItem).toBe(itemList.items[1]);
      }));

      it('should focus the first item that starts with sequence of letters', fakeAsync(() => {
        keyManager.onKeydown(createKeyboardEvent('keydown', 84, undefined, 't')); // types "t"
        keyManager.onKeydown(createKeyboardEvent('keydown', 72, undefined, 'h')); // types "h"

        tick(debounceInterval);

        expect(keyManager.activeItem).toBe(itemList.items[2]);
      }));

      it('should cancel any pending timers if a navigation key is pressed', fakeAsync(() => {
        keyManager.onKeydown(createKeyboardEvent('keydown', 84, undefined, 't')); // types "t"
        keyManager.onKeydown(createKeyboardEvent('keydown', 72, undefined, 'h')); // types "h"
        keyManager.onKeydown(fakeKeyEvents.downArrow);

        tick(debounceInterval);

        expect(keyManager.activeItem).toBe(itemList.items[0]);
      }));

      it('should handle non-English input', fakeAsync(() => {
        itemList.items = [
          new FakeFocusable('едно'),
          new FakeFocusable('две'),
          new FakeFocusable('три')
        ];

        const keyboardEvent = createKeyboardEvent('keydown', 68, undefined, 'д');

        keyManager.onKeydown(keyboardEvent); // types "д"
        tick(debounceInterval);

        expect(keyManager.activeItem).toBe(itemList.items[1]);
      }));

      it('should handle non-letter characters', fakeAsync(() => {
        itemList.items = [
          new FakeFocusable('[]'),
          new FakeFocusable('321'),
          new FakeFocusable('`!?')
        ];

        keyManager.onKeydown(createKeyboardEvent('keydown', 192, undefined, '`')); // types "`"
        tick(debounceInterval);
        expect(keyManager.activeItem).toBe(itemList.items[2]);

        keyManager.onKeydown(createKeyboardEvent('keydown', 51, undefined, '3')); // types "3"
        tick(debounceInterval);
        expect(keyManager.activeItem).toBe(itemList.items[1]);

        keyManager.onKeydown(createKeyboardEvent('keydown', 219, undefined, '[')); // types "["
        tick(debounceInterval);
        expect(keyManager.activeItem).toBe(itemList.items[0]);
      }));

      it('should not focus disabled items', fakeAsync(() => {
        expect(keyManager.activeItem).toBeFalsy();

        itemList.items[0].disabled = true;
        keyManager.onKeydown(createKeyboardEvent('keydown', 79, undefined, 'o')); // types "o"
        tick(debounceInterval);

        expect(keyManager.activeItem).toBeFalsy();
      }));

      it('should start looking for matches after the active item', fakeAsync(() => {
        itemList.items = [
          new FakeFocusable('Bilbo'),
          new FakeFocusable('Frodo'),
          new FakeFocusable('Pippin'),
          new FakeFocusable('Boromir'),
          new FakeFocusable('Aragorn')
        ];

        keyManager.setActiveItem(1);
        keyManager.onKeydown(createKeyboardEvent('keydown', 66, undefined, 'b'));
        tick(debounceInterval);

        expect(keyManager.activeItem).toBe(itemList.items[3]);
      }));

      it('should wrap back around if there were no matches after the active item', fakeAsync(() => {
        itemList.items = [
          new FakeFocusable('Bilbo'),
          new FakeFocusable('Frodo'),
          new FakeFocusable('Pippin'),
          new FakeFocusable('Boromir'),
          new FakeFocusable('Aragorn')
        ];

        keyManager.setActiveItem(3);
        keyManager.onKeydown(createKeyboardEvent('keydown', 66, undefined, 'b'));
        tick(debounceInterval);

        expect(keyManager.activeItem).toBe(itemList.items[0]);
      }));

      it('should wrap back around if the last item is active', fakeAsync(() => {
        keyManager.setActiveItem(2);
        keyManager.onKeydown(createKeyboardEvent('keydown', 79, undefined, 'o'));
        tick(debounceInterval);

        expect(keyManager.activeItem).toBe(itemList.items[0]);
      }));

      it('should be able to select the first item', fakeAsync(() => {
        keyManager.setActiveItem(-1);
        keyManager.onKeydown(createKeyboardEvent('keydown', 79, undefined, 'o'));
        tick(debounceInterval);

        expect(keyManager.activeItem).toBe(itemList.items[0]);
      }));

      it('should not do anything if there is no match', fakeAsync(() => {
        keyManager.setActiveItem(1);
        keyManager.onKeydown(createKeyboardEvent('keydown', 87, undefined, 'w'));
        tick(debounceInterval);

        expect(keyManager.activeItem).toBe(itemList.items[1]);
      }));

    });

  });

  describe('FocusKeyManager', () => {
    let keyManager: FocusKeyManager<FakeFocusable>;

    beforeEach(() => {
      itemList.items = [new FakeFocusable(), new FakeFocusable(), new FakeFocusable()];
      keyManager = new FocusKeyManager<FakeFocusable>(itemList);

      // first item is already focused
      keyManager.setFirstItemActive();

      spyOn(itemList.items[0], 'focus');
      spyOn(itemList.items[1], 'focus');
      spyOn(itemList.items[2], 'focus');
    });

    it('should focus subsequent items when down arrow is pressed', () => {
      keyManager.onKeydown(fakeKeyEvents.downArrow);

      expect(itemList.items[0].focus).not.toHaveBeenCalled();
      expect(itemList.items[1].focus).toHaveBeenCalledTimes(1);
      expect(itemList.items[2].focus).not.toHaveBeenCalled();

      keyManager.onKeydown(fakeKeyEvents.downArrow);
      expect(itemList.items[0].focus).not.toHaveBeenCalled();
      expect(itemList.items[1].focus).toHaveBeenCalledTimes(1);
      expect(itemList.items[2].focus).toHaveBeenCalledTimes(1);
    });

    it('should focus previous items when up arrow is pressed', () => {
      keyManager.onKeydown(fakeKeyEvents.downArrow);

      expect(itemList.items[0].focus).not.toHaveBeenCalled();
      expect(itemList.items[1].focus).toHaveBeenCalledTimes(1);

      keyManager.onKeydown(fakeKeyEvents.upArrow);

      expect(itemList.items[0].focus).toHaveBeenCalledTimes(1);
      expect(itemList.items[1].focus).toHaveBeenCalledTimes(1);
    });

    it('should allow setting the focused item without calling focus', () => {
      expect(keyManager.activeItemIndex)
          .toBe(0, `Expected first item of the list to be active.`);

      keyManager.updateActiveItem(1);
      expect(keyManager.activeItemIndex)
          .toBe(1, `Expected activeItemIndex to update after calling updateActiveItemIndex().`);
      expect(itemList.items[1].focus).not.toHaveBeenCalledTimes(1);
    });

    it('should be able to set the focus origin', () => {
      keyManager.setFocusOrigin('mouse');

      keyManager.onKeydown(fakeKeyEvents.downArrow);
      expect(itemList.items[1].focus).toHaveBeenCalledWith('mouse');

      keyManager.onKeydown(fakeKeyEvents.downArrow);
      expect(itemList.items[2].focus).toHaveBeenCalledWith('mouse');

      keyManager.setFocusOrigin('keyboard');

      keyManager.onKeydown(fakeKeyEvents.upArrow);
      expect(itemList.items[1].focus).toHaveBeenCalledWith('keyboard');
    });

  });

  describe('ActiveDescendantKeyManager', () => {
    let keyManager: ActiveDescendantKeyManager<FakeHighlightable>;

    beforeEach(() => {
      itemList.items = [new FakeHighlightable(), new FakeHighlightable(), new FakeHighlightable()];
      keyManager = new ActiveDescendantKeyManager<FakeHighlightable>(itemList);

      // first item is already focused
      keyManager.setFirstItemActive();

      spyOn(itemList.items[0], 'setActiveStyles');
      spyOn(itemList.items[1], 'setActiveStyles');
      spyOn(itemList.items[2], 'setActiveStyles');

      spyOn(itemList.items[0], 'setInactiveStyles');
      spyOn(itemList.items[1], 'setInactiveStyles');
      spyOn(itemList.items[2], 'setInactiveStyles');
    });

    it('should set subsequent items as active with the DOWN arrow', () => {
      keyManager.onKeydown(fakeKeyEvents.downArrow);

      expect(itemList.items[1].setActiveStyles).toHaveBeenCalled();
      expect(itemList.items[2].setActiveStyles).not.toHaveBeenCalled();

      keyManager.onKeydown(fakeKeyEvents.downArrow);

      expect(itemList.items[2].setActiveStyles).toHaveBeenCalled();
    });

    it('should set previous items as active with the UP arrow', () => {
      keyManager.setLastItemActive();
      keyManager.onKeydown(fakeKeyEvents.upArrow);

      expect(itemList.items[1].setActiveStyles).toHaveBeenCalled();
      expect(itemList.items[0].setActiveStyles).not.toHaveBeenCalled();

      keyManager.onKeydown(fakeKeyEvents.upArrow);

      expect(itemList.items[0].setActiveStyles).toHaveBeenCalled();
    });

    it('should set inactive styles on previously active items', () => {
      keyManager.onKeydown(fakeKeyEvents.downArrow);
      expect(itemList.items[0].setInactiveStyles).toHaveBeenCalled();

      keyManager.onKeydown(fakeKeyEvents.upArrow);
      expect(itemList.items[1].setInactiveStyles).toHaveBeenCalled();
    });

  });


});
