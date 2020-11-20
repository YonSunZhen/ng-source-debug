import {Platform} from '@angular/cdk/platform';
import {Component, PLATFORM_ID, ViewChild} from '@angular/core';
import {async, ComponentFixture, TestBed} from '@angular/core/testing';
import {A11yModule, FocusTrap, CdkTrapFocus} from '../index';


describe('FocusTrap', () => {

  beforeEach(async(() => {
    TestBed.configureTestingModule({
      imports: [A11yModule],
      declarations: [
        FocusTrapWithBindings,
        SimpleFocusTrap,
        FocusTrapTargets,
        FocusTrapWithSvg,
        FocusTrapWithoutFocusableElements,
        FocusTrapWithAutoCapture,
      ],
    });

    TestBed.compileComponents();
  }));

  describe('with default element', () => {
    let fixture: ComponentFixture<SimpleFocusTrap>;
    let focusTrapInstance: FocusTrap;

    beforeEach(() => {
      fixture = TestBed.createComponent(SimpleFocusTrap);
      fixture.detectChanges();
      focusTrapInstance = fixture.componentInstance.focusTrapDirective.focusTrap;
    });

    it('wrap focus from end to start', () => {
      // Because we can't mimic a real tab press focus change in a unit test, just call the
      // focus event handler directly.
      const result = focusTrapInstance.focusFirstTabbableElement();

      expect(document.activeElement.nodeName.toLowerCase())
          .toBe('input', 'Expected input element to be focused');
      expect(result).toBe(true, 'Expected return value to be true if focus was shifted.');
    });

    it('should wrap focus from start to end', () => {
      // Because we can't mimic a real tab press focus change in a unit test, just call the
      // focus event handler directly.
      const result = focusTrapInstance.focusLastTabbableElement();

      const platformId = TestBed.get(PLATFORM_ID);
      // In iOS button elements are never tabbable, so the last element will be the input.
      const lastElement = new Platform(platformId).IOS ? 'input' : 'button';

      expect(document.activeElement.nodeName.toLowerCase())
          .toBe(lastElement, `Expected ${lastElement} element to be focused`);

      expect(result).toBe(true, 'Expected return value to be true if focus was shifted.');
    });

    it('should return false if it did not manage to find a focusable element', () => {
      fixture.destroy();

      const newFixture = TestBed.createComponent(FocusTrapWithoutFocusableElements);
      newFixture.detectChanges();

      const focusTrap = newFixture.componentInstance.focusTrapDirective.focusTrap;
      const result = focusTrap.focusFirstTabbableElement();

      expect(result).toBe(false);
    });

    it('should be enabled by default', () => {
      expect(focusTrapInstance.enabled).toBe(true);
    });

  });

  describe('with bindings', () => {
    let fixture: ComponentFixture<FocusTrapWithBindings>;

    beforeEach(() => {
      fixture = TestBed.createComponent(FocusTrapWithBindings);
      fixture.detectChanges();
    });

    it('should clean up its anchor sibling elements on destroy', () => {
      const rootElement = fixture.debugElement.nativeElement as HTMLElement;

      expect(rootElement.querySelectorAll('div.cdk-visually-hidden').length).toBe(2);

      fixture.componentInstance.renderFocusTrap = false;
      fixture.detectChanges();

      expect(rootElement.querySelectorAll('div.cdk-visually-hidden').length).toBe(0);
    });

    it('should set the appropriate tabindex on the anchors, based on the disabled state', () => {
      const anchors = Array.from(
        fixture.debugElement.nativeElement.querySelectorAll('div.cdk-visually-hidden')
      ) as HTMLElement[];

      expect(anchors.every(current => current.getAttribute('tabindex') === '0')).toBe(true);

      fixture.componentInstance._isFocusTrapEnabled = false;
      fixture.detectChanges();

      expect(anchors.every(current => current.getAttribute('tabindex') === '-1')).toBe(true);
    });
  });

  describe('with focus targets', () => {
    let fixture: ComponentFixture<FocusTrapTargets>;
    let focusTrapInstance: FocusTrap;

    beforeEach(() => {
      fixture = TestBed.createComponent(FocusTrapTargets);
      fixture.detectChanges();
      focusTrapInstance = fixture.componentInstance.focusTrapDirective.focusTrap;
    });

    it('should be able to set initial focus target', () => {
      // Because we can't mimic a real tab press focus change in a unit test, just call the
      // focus event handler directly.
      focusTrapInstance.focusInitialElement();
      expect(document.activeElement.id).toBe('middle');
    });

    it('should be able to prioritize the first focus target', () => {
      // Because we can't mimic a real tab press focus change in a unit test, just call the
      // focus event handler directly.
      focusTrapInstance.focusFirstTabbableElement();
      expect(document.activeElement.id).toBe('first');
    });

    it('should be able to prioritize the last focus target', () => {
      // Because we can't mimic a real tab press focus change in a unit test, just call the
      // focus event handler directly.
      focusTrapInstance.focusLastTabbableElement();
      expect(document.activeElement.id).toBe('last');
    });
  });

  describe('special cases', () => {
    it('should not throw when it has a SVG child', () => {
      let fixture = TestBed.createComponent(FocusTrapWithSvg);

      fixture.detectChanges();

      let focusTrapInstance = fixture.componentInstance.focusTrapDirective.focusTrap;

      expect(() => focusTrapInstance.focusFirstTabbableElement()).not.toThrow();
      expect(() => focusTrapInstance.focusLastTabbableElement()).not.toThrow();
    });
  });

  describe('with autoCapture', () => {
    it('should automatically capture and return focus on init / destroy', async(() => {
      const fixture = TestBed.createComponent(FocusTrapWithAutoCapture);
      fixture.detectChanges();

      const buttonOutsideTrappedRegion = fixture.nativeElement.querySelector('button');
      buttonOutsideTrappedRegion.focus();
      expect(document.activeElement).toBe(buttonOutsideTrappedRegion);

      fixture.componentInstance.showTrappedRegion = true;
      fixture.detectChanges();

      fixture.whenStable().then(() => {
        expect(document.activeElement.id).toBe('auto-capture-target');

        fixture.destroy();
        expect(document.activeElement).toBe(buttonOutsideTrappedRegion);
      });
    }));
  });
});


@Component({
  template: `
    <div cdkTrapFocus>
      <input>
      <button>SAVE</button>
    </div>
    `
})
class SimpleFocusTrap {
  @ViewChild(CdkTrapFocus) focusTrapDirective: CdkTrapFocus;
}

@Component({
  template: `
    <button type="button">Toggle</button>
    <div *ngIf="showTrappedRegion" cdkTrapFocus cdkTrapFocusAutoCapture>
      <input id="auto-capture-target">
      <button>SAVE</button>
    </div>
    `
})
class FocusTrapWithAutoCapture {
  @ViewChild(CdkTrapFocus) focusTrapDirective: CdkTrapFocus;
  showTrappedRegion = false;
}


@Component({
  template: `
    <div *ngIf="renderFocusTrap" [cdkTrapFocus]="_isFocusTrapEnabled">
      <input>
      <button>SAVE</button>
    </div>
    `
})
class FocusTrapWithBindings {
  @ViewChild(CdkTrapFocus) focusTrapDirective: CdkTrapFocus;
  renderFocusTrap = true;
  _isFocusTrapEnabled = true;
}


@Component({
  template: `
    <div cdkTrapFocus>
      <input>
      <button>before</button>
      <button id="first" cdkFocusRegionStart></button>
      <button id="middle" cdkFocusInitial></button>
      <button id="last" cdkFocusRegionEnd></button>
      <button>after</button>
      <input>
    </div>
    `
})
class FocusTrapTargets {
  @ViewChild(CdkTrapFocus) focusTrapDirective: CdkTrapFocus;
}


@Component({
  template: `
    <div cdkTrapFocus>
      <svg xmlns="http://www.w3.org/2000/svg">
        <circle cx="100" cy="100" r="100"/>
      </svg>
    </div>
    `
})
class FocusTrapWithSvg {
  @ViewChild(CdkTrapFocus) focusTrapDirective: CdkTrapFocus;
}

@Component({
  template: `
    <div cdkTrapFocus>
      <p>Hello</p>
    </div>
    `
})
class FocusTrapWithoutFocusableElements {
  @ViewChild(CdkTrapFocus) focusTrapDirective: CdkTrapFocus;
}
