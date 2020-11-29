/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import '@angular/compiler';
import {ɵwhenRendered as whenRendered} from '@angular/core';
import {withBody} from '@angular/private/testing';
import * as path from 'path';

const PACKAGE = 'angular/packages/core/test/bundling/forms';
const BUNDLES = ['bundle.js', 'bundle.min_debug.js', 'bundle.min.js'];

describe('functional test for forms', () => {
  BUNDLES.forEach((bundle) => {
    describe(`using ${bundle} bundle`, () => {
      it('should render template form', withBody('<app-root></app-root>', async () => {
           require(path.join(PACKAGE, bundle));
           await (window as any).waitForApp;

           // Template forms
           const templateFormsComponent = (window as any).templateFormsComponent;
           await whenRendered(templateFormsComponent);

           const templateForm = document.querySelector('app-template-forms')!;

           // Check for inputs
           const iputs = templateForm.querySelectorAll('input');
           expect(iputs.length).toBe(5);

           // Check for button
           const templateButtons = templateForm.querySelectorAll('button');
           expect(templateButtons.length).toBe(1);
           expect(templateButtons[0]).toBeDefined();

           // Make sure button click works
           const templateFormSpy = spyOn(templateFormsComponent, 'addCity');
           templateButtons[0].click();
           expect(templateFormSpy).toHaveBeenCalled();

           // Reactive forms
           const reactiveFormsComponent = (window as any).reactiveFormsComponent;
           await whenRendered(reactiveFormsComponent);

           const reactiveForm = document.querySelector('app-reactive-forms')!;

           // Check for inputs
           const inputs = reactiveForm.querySelectorAll('input');
           expect(inputs.length).toBe(5);

           // Check for button
           const reactiveButtons = reactiveForm.querySelectorAll('button');
           expect(reactiveButtons.length).toBe(1);
           expect(reactiveButtons[0]).toBeDefined();

           // Make sure button click works
           const reactiveFormSpy = spyOn(reactiveFormsComponent, 'addCity').and.callThrough();
           reactiveButtons[0].click();
           expect(reactiveFormSpy).toHaveBeenCalled();
           expect(reactiveFormsComponent.addresses.length).toBe(2);
         }));
    });
  });
});
