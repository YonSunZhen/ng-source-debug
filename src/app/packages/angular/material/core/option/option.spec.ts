import {async, ComponentFixture, TestBed} from '@angular/core/testing';
import {Component, DebugElement} from '@angular/core';
import {By} from '@angular/platform-browser';
import {dispatchFakeEvent} from '@angular/cdk/testing';
import {MatOption, MatOptionModule} from './index';

describe('MatOption component', () => {

  beforeEach(async(() => {
    TestBed.configureTestingModule({
      imports: [MatOptionModule],
      declarations: [BasicOption]
    }).compileComponents();
  }));

  it('should complete the `stateChanges` stream on destroy', () => {
    const fixture = TestBed.createComponent(BasicOption);
    fixture.detectChanges();

    const optionInstance: MatOption =
        fixture.debugElement.query(By.directive(MatOption)).componentInstance;
    const completeSpy = jasmine.createSpy('complete spy');
    const subscription = optionInstance._stateChanges.subscribe(undefined, undefined, completeSpy);

    fixture.destroy();
    expect(completeSpy).toHaveBeenCalled();
    subscription.unsubscribe();
  });

  it('should not emit to `onSelectionChange` if selecting an already-selected option', () => {
    const fixture = TestBed.createComponent(BasicOption);
    fixture.detectChanges();

    const optionInstance: MatOption =
        fixture.debugElement.query(By.directive(MatOption)).componentInstance;

    optionInstance.select();
    expect(optionInstance.selected).toBe(true);

    const spy = jasmine.createSpy('selection change spy');
    const subscription = optionInstance.onSelectionChange.subscribe(spy);

    optionInstance.select();
    fixture.detectChanges();

    expect(optionInstance.selected).toBe(true);
    expect(spy).not.toHaveBeenCalled();

    subscription.unsubscribe();
  });

  it('should not emit to `onSelectionChange` if deselecting an unselected option', () => {
    const fixture = TestBed.createComponent(BasicOption);
    fixture.detectChanges();

    const optionInstance: MatOption =
        fixture.debugElement.query(By.directive(MatOption)).componentInstance;

    optionInstance.deselect();
    expect(optionInstance.selected).toBe(false);

    const spy = jasmine.createSpy('selection change spy');
    const subscription = optionInstance.onSelectionChange.subscribe(spy);

    optionInstance.deselect();
    fixture.detectChanges();

    expect(optionInstance.selected).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    subscription.unsubscribe();
  });

  it('should be able to set a custom id', () => {
    const fixture = TestBed.createComponent(BasicOption);

    fixture.componentInstance.id = 'custom-option';
    fixture.detectChanges();

    const optionInstance = fixture.debugElement.query(By.directive(MatOption)).componentInstance;

    expect(optionInstance.id).toBe('custom-option');
  });

  describe('ripples', () => {
    let fixture: ComponentFixture<BasicOption>;
    let optionDebugElement: DebugElement;
    let optionNativeElement: HTMLElement;
    let optionInstance: MatOption;

    beforeEach(() => {
      fixture = TestBed.createComponent(BasicOption);
      fixture.detectChanges();

      optionDebugElement = fixture.debugElement.query(By.directive(MatOption));
      optionNativeElement = optionDebugElement.nativeElement;
      optionInstance = optionDebugElement.componentInstance;
    });

    it('should show ripples by default', () => {
      expect(optionInstance.disableRipple).toBeFalsy('Expected ripples to be enabled by default');
      expect(optionNativeElement.querySelectorAll('.mat-ripple-element').length)
        .toBe(0, 'Expected no ripples to show up initially');

      dispatchFakeEvent(optionNativeElement, 'mousedown');
      dispatchFakeEvent(optionNativeElement, 'mouseup');

      expect(optionNativeElement.querySelectorAll('.mat-ripple-element').length)
        .toBe(1, 'Expected one ripple to show up after a fake click.');
    });

    it('should not show ripples if the option is disabled', () => {
      expect(optionNativeElement.querySelectorAll('.mat-ripple-element').length)
        .toBe(0, 'Expected no ripples to show up initially');

      fixture.componentInstance.disabled = true;
      fixture.detectChanges();

      dispatchFakeEvent(optionNativeElement, 'mousedown');
      dispatchFakeEvent(optionNativeElement, 'mouseup');

      expect(optionNativeElement.querySelectorAll('.mat-ripple-element').length)
        .toBe(0, 'Expected no ripples to show up after click on a disabled option.');
    });

  });

});

@Component({
  template: `<mat-option [id]="id" [disabled]="disabled"></mat-option>`
})
class BasicOption {
  disabled: boolean;
  id: string;
}
