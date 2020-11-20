/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Directionality} from '@angular/cdk/bidi';
import {
  CdkStep,
  CdkStepper,
  StepContentPositionState,
  MAT_STEPPER_GLOBAL_OPTIONS,
  StepperOptions
} from '@angular/cdk/stepper';
import {AnimationEvent} from '@angular/animations';
import {
  AfterContentInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ContentChild,
  ContentChildren,
  Directive,
  ElementRef,
  EventEmitter,
  forwardRef,
  Inject,
  Input,
  Optional,
  Output,
  QueryList,
  SkipSelf,
  TemplateRef,
  ViewChildren,
  ViewEncapsulation,
} from '@angular/core';
import {FormControl, FormGroupDirective, NgForm} from '@angular/forms';
import {DOCUMENT} from '@angular/common';
import {ErrorStateMatcher} from '@angular/material/core';
import {takeUntil} from 'rxjs/operators';

import {MatStepHeader} from './step-header';
import {MatStepLabel} from './step-label';
import {matStepperAnimations} from './stepper-animations';
import {MatStepperIcon, MatStepperIconContext} from './stepper-icon';

// TODO(devversion): workaround for https://github.com/angular/material2/issues/12760
export const _CdkStepper = CdkStepper;

@Component({
  moduleId: module.id,
  selector: 'mat-step',
  templateUrl: 'step.html',
  providers: [{provide: ErrorStateMatcher, useExisting: MatStep}],
  encapsulation: ViewEncapsulation.None,
  exportAs: 'matStep',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MatStep extends CdkStep implements ErrorStateMatcher {
  /** Content for step label given by `<ng-template matStepLabel>`. */
  @ContentChild(MatStepLabel) stepLabel: MatStepLabel;

  /** @breaking-change 8.0.0 remove the `?` after `stepperOptions` */
  constructor(@Inject(forwardRef(() => MatStepper)) stepper: MatStepper,
              @SkipSelf() private _errorStateMatcher: ErrorStateMatcher,
              @Optional() @Inject(MAT_STEPPER_GLOBAL_OPTIONS) stepperOptions?: StepperOptions) {
    super(stepper, stepperOptions);
  }

  /** Custom error state matcher that additionally checks for validity of interacted form. */
  isErrorState(control: FormControl | null, form: FormGroupDirective | NgForm | null): boolean {
    const originalErrorState = this._errorStateMatcher.isErrorState(control, form);

    // Custom error state checks for the validity of form that is not submitted or touched
    // since user can trigger a form change by calling for another step without directly
    // interacting with the current form.
    const customErrorState = !!(control && control.invalid && this.interacted);

    return originalErrorState || customErrorState;
  }
}


@Directive({
  selector: '[matStepper]'
})
export class MatStepper extends _CdkStepper implements AfterContentInit {
  /** The list of step headers of the steps in the stepper. */
  @ViewChildren(MatStepHeader) _stepHeader: QueryList<MatStepHeader>;

  /** Steps that the stepper holds. */
  @ContentChildren(MatStep) _steps: QueryList<MatStep>;

  /** Custom icon overrides passed in by the consumer. */
  @ContentChildren(MatStepperIcon) _icons: QueryList<MatStepperIcon>;

  /** Event emitted when the current step is done transitioning in. */
  @Output() readonly animationDone: EventEmitter<void> = new EventEmitter<void>();

  /** Consumer-specified template-refs to be used to override the header icons. */
  _iconOverrides: {[key: string]: TemplateRef<MatStepperIconContext>} = {};

  ngAfterContentInit() {
    const icons = this._icons.toArray();
    icons.forEach(({name, templateRef}) => this._iconOverrides[name] = templateRef);

    // Mark the component for change detection whenever the content children query changes
    this._steps.changes.pipe(takeUntil(this._destroyed)).subscribe(() => this._stateChanged());
  }

  _animationDone(event: AnimationEvent) {
    if ((event.toState as StepContentPositionState) === 'current') {
      this.animationDone.emit();
    }
  }
}

@Component({
  moduleId: module.id,
  selector: 'mat-horizontal-stepper',
  exportAs: 'matHorizontalStepper',
  templateUrl: 'stepper-horizontal.html',
  styleUrls: ['stepper.css'],
  inputs: ['selectedIndex'],
  host: {
    'class': 'mat-stepper-horizontal',
    '[class.mat-stepper-label-position-end]': 'labelPosition == "end"',
    '[class.mat-stepper-label-position-bottom]': 'labelPosition == "bottom"',
    'aria-orientation': 'horizontal',
    'role': 'tablist',
  },
  animations: [matStepperAnimations.horizontalStepTransition],
  providers: [{provide: MatStepper, useExisting: MatHorizontalStepper}],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MatHorizontalStepper extends MatStepper {
  /** Whether the label should display in bottom or end position. */
  @Input()
  labelPosition: 'bottom' | 'end' = 'end';
}

@Component({
  moduleId: module.id,
  selector: 'mat-vertical-stepper',
  exportAs: 'matVerticalStepper',
  templateUrl: 'stepper-vertical.html',
  styleUrls: ['stepper.css'],
  inputs: ['selectedIndex'],
  host: {
    'class': 'mat-stepper-vertical',
    'aria-orientation': 'vertical',
    'role': 'tablist',
  },
  animations: [matStepperAnimations.verticalStepTransition],
  providers: [{provide: MatStepper, useExisting: MatVerticalStepper}],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MatVerticalStepper extends MatStepper {
  constructor(
    @Optional() dir: Directionality,
    changeDetectorRef: ChangeDetectorRef,
    // @breaking-change 8.0.0 `elementRef` and `_document` parameters to become required.
    elementRef?: ElementRef<HTMLElement>,
    @Inject(DOCUMENT) _document?: any) {
    super(dir, changeDetectorRef, elementRef, _document);
    this._orientation = 'vertical';
  }
}
