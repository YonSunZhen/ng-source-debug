import {Direction, Directionality} from '@angular/cdk/bidi';
import {END, ENTER, HOME, LEFT_ARROW, RIGHT_ARROW, SPACE} from '@angular/cdk/keycodes';
import {PortalModule} from '@angular/cdk/portal';
import {ScrollingModule, ViewportRuler} from '@angular/cdk/scrolling';
import {dispatchFakeEvent, dispatchKeyboardEvent} from '@angular/cdk/testing';
import {CommonModule} from '@angular/common';
import {Component, ViewChild} from '@angular/core';
import {
  async,
  ComponentFixture,
  discardPeriodicTasks,
  fakeAsync,
  TestBed,
  tick,
} from '@angular/core/testing';
import {MatRippleModule} from '@angular/material/core';
import {By} from '@angular/platform-browser';
import {MatInkBar} from './ink-bar';
import {MatTabHeader} from './tab-header';
import {MatTabLabelWrapper} from './tab-label-wrapper';
import {Subject} from 'rxjs';
import {ObserversModule, MutationObserverFactory} from '@angular/cdk/observers';


describe('MatTabHeader', () => {
  let dir: Direction = 'ltr';
  let change = new Subject();
  let fixture: ComponentFixture<SimpleTabHeaderApp>;
  let appComponent: SimpleTabHeaderApp;

  beforeEach(async(() => {
    dir = 'ltr';
    TestBed.configureTestingModule({
      imports: [CommonModule, PortalModule, MatRippleModule, ScrollingModule, ObserversModule],
      declarations: [
        MatTabHeader,
        MatInkBar,
        MatTabLabelWrapper,
        SimpleTabHeaderApp,
      ],
      providers: [
        ViewportRuler,
        {provide: Directionality, useFactory: () => ({value: dir, change: change.asObservable()})},
      ]
    });

    TestBed.compileComponents();
  }));

  describe('focusing', () => {
    let tabListContainer: HTMLElement;

    beforeEach(() => {
      fixture = TestBed.createComponent(SimpleTabHeaderApp);
      fixture.detectChanges();

      appComponent = fixture.componentInstance;
      tabListContainer = appComponent.tabHeader._tabListContainer.nativeElement;
    });

    it('should initialize to the selected index', () => {
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(appComponent.selectedIndex);
    });

    it('should send focus change event', () => {
      appComponent.tabHeader.focusIndex = 2;
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(2);
    });

    it('should not set focus a disabled tab', () => {
      appComponent.tabHeader.focusIndex = 0;
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(0);

      // Set focus on the disabled tab, but focus should remain 0
      appComponent.tabHeader.focusIndex = appComponent.disabledTabIndex;
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(0);
    });

    it('should move focus right and skip disabled tabs', () => {
      appComponent.tabHeader.focusIndex = 0;
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(0);

      // Move focus right, verify that the disabled tab is 1 and should be skipped
      expect(appComponent.disabledTabIndex).toBe(1);
      dispatchKeyboardEvent(tabListContainer, 'keydown', RIGHT_ARROW);
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(2);

      // Move focus right to index 3
      dispatchKeyboardEvent(tabListContainer, 'keydown', RIGHT_ARROW);
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(3);
    });

    it('should move focus left and skip disabled tabs', () => {
      appComponent.tabHeader.focusIndex = 3;
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(3);

      // Move focus left to index 3
      dispatchKeyboardEvent(tabListContainer, 'keydown', LEFT_ARROW);
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(2);

      // Move focus left, verify that the disabled tab is 1 and should be skipped
      expect(appComponent.disabledTabIndex).toBe(1);
      dispatchKeyboardEvent(tabListContainer, 'keydown', LEFT_ARROW);
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(0);
    });

    it('should support key down events to move and select focus', () => {
      appComponent.tabHeader.focusIndex = 0;
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(0);

      // Move focus right to 2
      dispatchKeyboardEvent(tabListContainer, 'keydown', RIGHT_ARROW);
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(2);

      // Select the focused index 2
      expect(appComponent.selectedIndex).toBe(0);
      const enterEvent = dispatchKeyboardEvent(tabListContainer, 'keydown', ENTER);
      fixture.detectChanges();
      expect(appComponent.selectedIndex).toBe(2);
      expect(enterEvent.defaultPrevented).toBe(true);

      // Move focus right to 0
      dispatchKeyboardEvent(tabListContainer, 'keydown', LEFT_ARROW);
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(0);

      // Select the focused 0 using space.
      expect(appComponent.selectedIndex).toBe(2);
      const spaceEvent = dispatchKeyboardEvent(tabListContainer, 'keydown', SPACE);
      fixture.detectChanges();
      expect(appComponent.selectedIndex).toBe(0);
      expect(spaceEvent.defaultPrevented).toBe(true);
    });

    it('should move focus to the first tab when pressing HOME', () => {
      appComponent.tabHeader.focusIndex = 3;
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(3);

      const event = dispatchKeyboardEvent(tabListContainer, 'keydown', HOME);
      fixture.detectChanges();

      expect(appComponent.tabHeader.focusIndex).toBe(0);
      expect(event.defaultPrevented).toBe(true);
    });

    it('should skip disabled items when moving focus using HOME', () => {
      appComponent.tabHeader.focusIndex = 3;
      appComponent.tabs[0].disabled = true;
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(3);

      dispatchKeyboardEvent(tabListContainer, 'keydown', HOME);
      fixture.detectChanges();

      // Note that the second tab is disabled by default already.
      expect(appComponent.tabHeader.focusIndex).toBe(2);
    });

    it('should move focus to the last tab when pressing END', () => {
      appComponent.tabHeader.focusIndex = 0;
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(0);

      const event = dispatchKeyboardEvent(tabListContainer, 'keydown', END);
      fixture.detectChanges();

      expect(appComponent.tabHeader.focusIndex).toBe(3);
      expect(event.defaultPrevented).toBe(true);
    });

    it('should skip disabled items when moving focus using END', () => {
      appComponent.tabHeader.focusIndex = 0;
      appComponent.tabs[3].disabled = true;
      fixture.detectChanges();
      expect(appComponent.tabHeader.focusIndex).toBe(0);

      dispatchKeyboardEvent(tabListContainer, 'keydown', END);
      fixture.detectChanges();

      expect(appComponent.tabHeader.focusIndex).toBe(2);
    });

  });

  describe('pagination', () => {
    describe('ltr', () => {
      beforeEach(() => {
        dir = 'ltr';
        fixture = TestBed.createComponent(SimpleTabHeaderApp);
        fixture.detectChanges();

        appComponent = fixture.componentInstance;
      });

      it('should show width when tab list width exceeds container', () => {
        fixture.detectChanges();
        expect(appComponent.tabHeader._showPaginationControls).toBe(false);

        // Add enough tabs that it will obviously exceed the width
        appComponent.addTabsForScrolling();
        fixture.detectChanges();

        expect(appComponent.tabHeader._showPaginationControls).toBe(true);
      });

      it('should scroll to show the focused tab label', () => {
        appComponent.addTabsForScrolling();
        fixture.detectChanges();
        expect(appComponent.tabHeader.scrollDistance).toBe(0);

        // Focus on the last tab, expect this to be the maximum scroll distance.
        appComponent.tabHeader.focusIndex = appComponent.tabs.length - 1;
        fixture.detectChanges();
        expect(appComponent.tabHeader.scrollDistance)
            .toBe(appComponent.tabHeader._getMaxScrollDistance());

        // Focus on the first tab, expect this to be the maximum scroll distance.
        appComponent.tabHeader.focusIndex = 0;
        fixture.detectChanges();
        expect(appComponent.tabHeader.scrollDistance).toBe(0);
      });

      it('should show ripples for pagination buttons', () => {
        appComponent.addTabsForScrolling();
        fixture.detectChanges();

        expect(appComponent.tabHeader._showPaginationControls).toBe(true);

        const buttonAfter = fixture.debugElement.query(By.css('.mat-tab-header-pagination-after'));

        expect(fixture.nativeElement.querySelectorAll('.mat-ripple-element').length)
          .toBe(0, 'Expected no ripple to show up initially.');

        dispatchFakeEvent(buttonAfter.nativeElement, 'mousedown');
        dispatchFakeEvent(buttonAfter.nativeElement, 'mouseup');

        expect(fixture.nativeElement.querySelectorAll('.mat-ripple-element').length)
          .toBe(1, 'Expected one ripple to show up after mousedown');
      });

      it('should allow disabling ripples for pagination buttons', () => {
        appComponent.addTabsForScrolling();
        appComponent.disableRipple = true;
        fixture.detectChanges();

        expect(appComponent.tabHeader._showPaginationControls).toBe(true);

        const buttonAfter = fixture.debugElement.query(By.css('.mat-tab-header-pagination-after'));

        expect(fixture.nativeElement.querySelectorAll('.mat-ripple-element').length)
          .toBe(0, 'Expected no ripple to show up initially.');

        dispatchFakeEvent(buttonAfter.nativeElement, 'mousedown');
        dispatchFakeEvent(buttonAfter.nativeElement, 'mouseup');

        expect(fixture.nativeElement.querySelectorAll('.mat-ripple-element').length)
          .toBe(0, 'Expected no ripple to show up after mousedown');
      });

    });

    describe('rtl', () => {
      beforeEach(() => {
        dir = 'rtl';
        fixture = TestBed.createComponent(SimpleTabHeaderApp);
        appComponent = fixture.componentInstance;
        appComponent.dir = 'rtl';

        fixture.detectChanges();
      });

      it('should scroll to show the focused tab label', () => {
        appComponent.addTabsForScrolling();
        fixture.detectChanges();
        expect(appComponent.tabHeader.scrollDistance).toBe(0);

        // Focus on the last tab, expect this to be the maximum scroll distance.
        appComponent.tabHeader.focusIndex = appComponent.tabs.length - 1;
        fixture.detectChanges();
        expect(appComponent.tabHeader.scrollDistance)
            .toBe(appComponent.tabHeader._getMaxScrollDistance());

        // Focus on the first tab, expect this to be the maximum scroll distance.
        appComponent.tabHeader.focusIndex = 0;
        fixture.detectChanges();
        expect(appComponent.tabHeader.scrollDistance).toBe(0);
      });
    });

    it('should re-align the ink bar when the direction changes', fakeAsync(() => {
      fixture = TestBed.createComponent(SimpleTabHeaderApp);

      const inkBar = fixture.componentInstance.tabHeader._inkBar;
      spyOn(inkBar, 'alignToElement');

      fixture.detectChanges();

      change.next();
      fixture.detectChanges();
      tick(20); // Angular turns rAF calls into 16.6ms timeouts in tests.

      expect(inkBar.alignToElement).toHaveBeenCalled();
    }));

    it('should re-align the ink bar when the window is resized', fakeAsync(() => {
      fixture = TestBed.createComponent(SimpleTabHeaderApp);
      fixture.detectChanges();

      const inkBar = fixture.componentInstance.tabHeader._inkBar;

      spyOn(inkBar, 'alignToElement');

      dispatchFakeEvent(window, 'resize');
      tick(150);
      fixture.detectChanges();

      expect(inkBar.alignToElement).toHaveBeenCalled();
      discardPeriodicTasks();
    }));

    it('should update arrows when the window is resized', fakeAsync(() => {
      fixture = TestBed.createComponent(SimpleTabHeaderApp);

      const header = fixture.componentInstance.tabHeader;

      spyOn(header, '_checkPaginationEnabled');

      dispatchFakeEvent(window, 'resize');
      tick(10);
      fixture.detectChanges();

      expect(header._checkPaginationEnabled).toHaveBeenCalled();
      discardPeriodicTasks();
    }));

    it('should update the pagination state if the content of the labels changes', () => {
      const mutationCallbacks: Function[] = [];
      TestBed.overrideProvider(MutationObserverFactory, {
        useValue: {
          // Stub out the MutationObserver since the native one is async.
          create: function(callback: Function) {
            mutationCallbacks.push(callback);
            return {observe: () => {}, disconnect: () => {}};
          }
        }
      });

      fixture = TestBed.createComponent(SimpleTabHeaderApp);
      fixture.detectChanges();

      const tabHeaderElement: HTMLElement =
          fixture.nativeElement.querySelector('.mat-tab-header');
      const labels =
          Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('.label-content'));
      const extraText = new Array(100).fill('w').join();
      const enabledClass = 'mat-tab-header-pagination-controls-enabled';

      expect(tabHeaderElement.classList).not.toContain(enabledClass);

      labels.forEach(label => {
        label.style.width = '';
        label.textContent += extraText;
      });

      mutationCallbacks.forEach(callback => callback());
      fixture.detectChanges();

      expect(tabHeaderElement.classList).toContain(enabledClass);
    });

  });
});

interface Tab {
  label: string;
  disabled?: boolean;
}

@Component({
  template: `
  <div [dir]="dir">
    <mat-tab-header [selectedIndex]="selectedIndex" [disableRipple]="disableRipple"
               (indexFocused)="focusedIndex = $event"
               (selectFocusedIndex)="selectedIndex = $event">
      <div matTabLabelWrapper class="label-content" style="min-width: 30px; width: 30px"
           *ngFor="let tab of tabs; let i = index"
           [disabled]="!!tab.disabled"
           (click)="selectedIndex = i">
         {{tab.label}}
      </div>
    </mat-tab-header>
  </div>
  `,
  styles: [`
    :host {
      width: 130px;
    }
  `]
})
class SimpleTabHeaderApp {
  disableRipple: boolean = false;
  selectedIndex: number = 0;
  focusedIndex: number;
  disabledTabIndex = 1;
  tabs: Tab[] = [{label: 'tab one'}, {label: 'tab one'}, {label: 'tab one'}, {label: 'tab one'}];
  dir: Direction = 'ltr';

  @ViewChild(MatTabHeader) tabHeader: MatTabHeader;

  constructor() {
    this.tabs[this.disabledTabIndex].disabled = true;
  }

  addTabsForScrolling() {
    this.tabs.push({label: 'new'}, {label: 'new'}, {label: 'new'}, {label: 'new'});
  }
}
