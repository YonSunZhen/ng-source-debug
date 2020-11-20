/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AttributeMarker, InitialStylingFlags, ViewEncapsulation} from '@angular/compiler/src/core';
import {setup} from '@angular/compiler/test/aot/test_util';
import {compile, expectEmit} from './mock_compile';

describe('compiler compliance: styling', () => {
  const angularFiles = setup({
    compileAngular: false,
    compileFakeCore: true,
    compileAnimations: false,
  });

  describe('@Component.styles', () => {
    it('should pass in the component metadata styles into the component definition and shim them using style encapsulation',
       () => {
         const files = {
           app: {
             'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  selector: "my-component",
                  styles: ["div.foo { color: red; }", ":host p:nth-child(even) { --webkit-transition: 1s linear all; }"],
                  template: "..."
                })
                export class MyComponent {
                }

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
           }
         };

         const template =
             'styles: ["div.foo[_ngcontent-%COMP%] { color: red; }", "[_nghost-%COMP%]   p[_ngcontent-%COMP%]:nth-child(even) { --webkit-transition: 1s linear all; }"]';
         const result = compile(files, angularFiles);
         expectEmit(result.source, template, 'Incorrect template');
       });

    it('should pass in styles, but skip shimming the styles if the view encapsulation signals not to',
       () => {
         const files = {
           app: {
             'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  selector: "my-component",
                  encapsulation: ${ViewEncapsulation.None},
                  styles: ["div.tall { height: 123px; }", ":host.small p { height:5px; }"],
                  template: "..."
                })
                export class MyComponent {
                }

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
           }
         };

         const template = 'div.tall { height: 123px; }", ":host.small p { height:5px; }';
         const result = compile(files, angularFiles);
         expectEmit(result.source, template, 'Incorrect template');
       });

    it('should pass in the component metadata styles into the component definition but skip shimming when style encapsulation is set to native',
       () => {
         const files = {
           app: {
             'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  encapsulation: ${ViewEncapsulation.Native},
                  selector: "my-component",
                  styles: ["div.cool { color: blue; }", ":host.nice p { color: gold; }"],
                  template: "..."
                })
                export class MyComponent {
                }

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
           }
         };

         const template = 'div.cool { color: blue; }", ":host.nice p { color: gold; }';
         const result = compile(files, angularFiles);
         expectEmit(result.source, template, 'Incorrect template');
       });
  });

  describe('@Component.animations', () => {
    it('should pass in the component metadata animations into the component definition', () => {
      const files = {
        app: {
          'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  selector: "my-component",
                  animations: [{name: 'foo123'}, {name: 'trigger123'}],
                  template: ""
                })
                export class MyComponent {
                }

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
        }
      };

      const template = `
        MyComponent.ngComponentDef = $r3$.ɵdefineComponent({
          type: MyComponent,
          selectors:[["my-component"]],
          factory:function MyComponent_Factory(t){
            return new (t || MyComponent)();
          },
          features: [$r3$.ɵPublicFeature],
          consts: 0,
          vars: 0,
          template:  function MyComponent_Template(rf, $ctx$) {
          },
          animations: [{name: "foo123"}, {name: "trigger123"}]
        });
      `;

      const result = compile(files, angularFiles);
      expectEmit(result.source, template, 'Incorrect template');
    });

    it('should include animations even if the provided array is empty', () => {
      const files = {
        app: {
          'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  selector: "my-component",
                  animations: [],
                  template: ""
                })
                export class MyComponent {
                }

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
        }
      };

      const template = `
        MyComponent.ngComponentDef = $r3$.ɵdefineComponent({
          type: MyComponent,
          selectors:[["my-component"]],
          factory:function MyComponent_Factory(t){
            return new (t || MyComponent)();
          },
          features: [$r3$.ɵPublicFeature],
          consts: 0,
          vars: 0,
          template:  function MyComponent_Template(rf, $ctx$) {
          },
          animations: []
        });
      `;

      const result = compile(files, angularFiles);
      expectEmit(result.source, template, 'Incorrect template');
    });

    it('should generate any animation triggers into the component template', () => {
      const files = {
        app: {
          'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  selector: "my-component",
                  template: \`
                    <div [@foo]='exp'></div>
                    <div @bar></div>
                    <div [@baz]></div>\`,
                })
                export class MyComponent {
                }

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
        }
      };

      const template = `
        const $e0_attrs$ = ["@foo", ""];
        const $e1_attrs$ = ["@bar", ""];
        const $e2_attrs$ = ["@baz", ""];
        …
        MyComponent.ngComponentDef = $r3$.ɵdefineComponent({
          …
          template:  function MyComponent_Template(rf, $ctx$) {
            if (rf & 1) {
              $r3$.ɵelement(0, "div", $e0_attrs$);
              $r3$.ɵelement(1, "div", $e1_attrs$);
              $r3$.ɵelement(2, "div", $e2_attrs$);
            }
            if (rf & 2) {
              $r3$.ɵelementAttribute(0, "@foo", $r3$.ɵbind(ctx.exp));
            }
          }
        });
      `;

      const result = compile(files, angularFiles);
      expectEmit(result.source, template, 'Incorrect template');
    });
  });

  describe('[style] and [style.prop]', () => {
    it('should create style instructions on the element', () => {
      const files = {
        app: {
          'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  selector: 'my-component',
                  template: \`<div [style]="myStyleExp"></div>\`
                })
                export class MyComponent {
                  myStyleExp = [{color:'red'}, {color:'blue', duration:1000}]
                }

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
        }
      };

      const template = `
          template: function MyComponent_Template(rf, $ctx$) {
            if (rf & 1) {
              $r3$.ɵelementStart(0, "div");
              $r3$.ɵelementStyling(null, null, $r3$.ɵdefaultStyleSanitizer);
              $r3$.ɵelementEnd();
            }
            if (rf & 2) {
              $r3$.ɵelementStylingMap(0, null, $ctx$.myStyleExp);
              $r3$.ɵelementStylingApply(0);
            }
          }
          `;

      const result = compile(files, angularFiles);
      expectEmit(result.source, template, 'Incorrect template');
    });

    it('should place initial, multi, singular and application followed by attribute style instructions in the template code in that order',
       () => {
         const files = {
           app: {
             'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  selector: 'my-component',
                  template: \`<div style="opacity:1"
                                   [attr.style]="'border-width: 10px'"
                                   [style.width]="myWidth"
                                   [style]="myStyleExp"
                                   [style.height]="myHeight"></div>\`
                })
                export class MyComponent {
                  myStyleExp = [{color:'red'}, {color:'blue', duration:1000}]
                  myWidth = '100px';
                  myHeight = '100px';
                }

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
           }
         };

         const template = `
          const $e0_attrs$ = [${AttributeMarker.SelectOnly}, "style"];
          const $e0_styling$ = ["opacity","width","height",${InitialStylingFlags.VALUES_MODE},"opacity","1"];
          …
          MyComponent.ngComponentDef = $r3$.ɵdefineComponent({
              type: MyComponent,
              selectors:[["my-component"]],
              factory:function MyComponent_Factory(t){
                return new (t || MyComponent)();
              },
              features: [$r3$.ɵPublicFeature],
              consts: 1,
              vars: 1,
              template:  function MyComponent_Template(rf, $ctx$) {
                if (rf & 1) {
                  $r3$.ɵelementStart(0, "div", $e0_attrs$);
                  $r3$.ɵelementStyling(null, $e0_styling$, $r3$.ɵdefaultStyleSanitizer);
                  $r3$.ɵelementEnd();
                }
                if (rf & 2) {
                  $r3$.ɵelementStylingMap(0, null, $ctx$.myStyleExp);
                  $r3$.ɵelementStylingProp(0, 1, $ctx$.myWidth);
                  $r3$.ɵelementStylingProp(0, 2, $ctx$.myHeight);
                  $r3$.ɵelementStylingApply(0);
                  $r3$.ɵelementAttribute(0, "style", $r3$.ɵbind("border-width: 10px"), $r3$.ɵsanitizeStyle);
                }
              }
            });
        `;

         const result = compile(files, angularFiles);
         expectEmit(result.source, template, 'Incorrect template');
       });

    it('should assign a sanitizer instance to the element style allocation instruction if any url-based properties are detected',
       () => {
         const files = {
           app: {
             'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  selector: 'my-component',
                  template: \`<div [style.background-image]="myImage">\`
                })
                export class MyComponent {
                  myImage = 'url(foo.jpg)';
                }

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
           }
         };

         const template = `
          const _c0 = ["background-image"];
          export class MyComponent {
              constructor() {
                  this.myImage = 'url(foo.jpg)';
              }
          }

          MyComponent.ngComponentDef = $r3$.ɵdefineComponent({
            type: MyComponent,
            selectors: [["my-component"]],
            factory: function MyComponent_Factory(t) {
              return new (t || MyComponent)();
            },
            features: [$r3$.ɵPublicFeature],
            consts: 1,
            vars: 0,
            template:  function MyComponent_Template(rf, ctx) {
              if (rf & 1) {
                $r3$.ɵelementStart(0, "div");
                $r3$.ɵelementStyling(null, _c0, $r3$.ɵdefaultStyleSanitizer);
                $r3$.ɵelementEnd();
              }
              if (rf & 2) {
                $r3$.ɵelementStylingProp(0, 0, ctx.myImage);
                $r3$.ɵelementStylingApply(0);
              }
            }
          });
        `;

         const result = compile(files, angularFiles);
         expectEmit(result.source, template, 'Incorrect template');
       });
  });

  describe('[class]', () => {
    it('should create class styling instructions on the element', () => {
      const files = {
        app: {
          'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  selector: 'my-component',
                  template: \`<div [class]="myClassExp"></div>\`
                })
                export class MyComponent {
                  myClassExp = {'foo':true}
                }

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
        }
      };

      const template = `
          template: function MyComponent_Template(rf, $ctx$) {
            if (rf & 1) {
              $r3$.ɵelementStart(0, "div");
              $r3$.ɵelementStyling();
              $r3$.ɵelementEnd();
            }
            if (rf & 2) {
              $r3$.ɵelementStylingMap(0,$ctx$.myClassExp);
              $r3$.ɵelementStylingApply(0);
            }
          }
          `;

      const result = compile(files, angularFiles);
      expectEmit(result.source, template, 'Incorrect template');
    });

    it('should place initial, multi, singular and application followed by attribute class instructions in the template code in that order',
       () => {
         const files = {
           app: {
             'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  selector: 'my-component',
                  template: \`<div class="grape"
                                   [attr.class]="'banana'"
                                   [class.apple]="yesToApple"
                                   [class]="myClassExp"
                                   [class.orange]="yesToOrange"></div>\`
                })
                export class MyComponent {
                  myClassExp = {a:true, b:true};
                  yesToApple = true;
                  yesToOrange = true;
                }

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
           }
         };

         const template = `
          const $e0_attrs$ = [${AttributeMarker.SelectOnly}, "class"];
          const $e0_cd$ = ["grape","apple","orange",${InitialStylingFlags.VALUES_MODE},"grape",true];
          …
          MyComponent.ngComponentDef = $r3$.ɵdefineComponent({
              type: MyComponent,
              selectors:[["my-component"]],
              factory:function MyComponent_Factory(t){
                return new (t || MyComponent)();
              },
              features: [$r3$.ɵPublicFeature],
              consts: 1,
              vars: 1,
              template:  function MyComponent_Template(rf, $ctx$) {
                if (rf & 1) {
                  $r3$.ɵelementStart(0, "div", $e0_attrs$);
                  $r3$.ɵelementStyling($e0_cd$);
                  $r3$.ɵelementEnd();
                }
                if (rf & 2) {
                  $r3$.ɵelementStylingMap(0, $ctx$.myClassExp);
                  $r3$.ɵelementClassProp(0, 1, $ctx$.yesToApple);
                  $r3$.ɵelementClassProp(0, 2, $ctx$.yesToOrange);
                  $r3$.ɵelementStylingApply(0);
                  $r3$.ɵelementAttribute(0, "class", $r3$.ɵbind("banana"));
                }
              }
            });
        `;

         const result = compile(files, angularFiles);
         expectEmit(result.source, template, 'Incorrect template');
       });

    it('should not generate the styling apply instruction if there are only static style/class attributes',
       () => {
         const files = {
           app: {
             'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  selector: 'my-component',
                  template: \`<div class="foo"
                                   style="width:100px"
                                   [attr.class]="'round'"
                                   [attr.style]="'height:100px'"></div>\`
                })
                export class MyComponent {}

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
           }
         };

         const template = `
          const $e0_attrs$ = [${AttributeMarker.SelectOnly}, "class", "style"];
          const $e0_cd$ = ["foo",${InitialStylingFlags.VALUES_MODE},"foo",true];
          const $e0_sd$ = ["width",${InitialStylingFlags.VALUES_MODE},"width","100px"];
          …
          MyComponent.ngComponentDef = $r3$.ɵdefineComponent({
              type: MyComponent,
              selectors:[["my-component"]],
              factory:function MyComponent_Factory(t){
                return new (t || MyComponent)();
              },
              features: [$r3$.ɵPublicFeature],
              consts: 1,
              vars: 2,
              template:  function MyComponent_Template(rf, $ctx$) {
                if (rf & 1) {
                  $r3$.ɵelementStart(0, "div", $e0_attrs$);
                  $r3$.ɵelementStyling($e0_cd$, $e0_sd$);
                  $r3$.ɵelementEnd();
                }
                if (rf & 2) {
                  $r3$.ɵelementAttribute(0, "class", $r3$.ɵbind("round"));
                  $r3$.ɵelementAttribute(0, "style", $r3$.ɵbind("height:100px"), $r3$.ɵsanitizeStyle);
                }
              }
            });
        `;

         const result = compile(files, angularFiles);
         expectEmit(result.source, template, 'Incorrect template');
       });
  });

  describe('[style] mixed with [class]', () => {
    it('should combine [style] and [class] bindings into a single instruction', () => {
      const files = {
        app: {
          'spec.ts': `
                import {Component, NgModule} from '@angular/core';

                @Component({
                  selector: 'my-component',
                  template: \`<div [style]="myStyleExp" [class]="myClassExp"></div>\`
                })
                export class MyComponent {
                  myStyleExp = [{color:'red'}, {color:'blue', duration:1000}]
                  myClassExp = 'foo bar apple';
                }

                @NgModule({declarations: [MyComponent]})
                export class MyModule {}
            `
        }
      };

      const template = `
          template: function MyComponent_Template(rf, $ctx$) {
            if (rf & 1) {
              $r3$.ɵelementStart(0, "div");
              $r3$.ɵelementStyling(null, null, $r3$.ɵdefaultStyleSanitizer);
              $r3$.ɵelementEnd();
            }
            if (rf & 2) {
              $r3$.ɵelementStylingMap(0, $ctx$.myClassExp, $ctx$.myStyleExp);
              $r3$.ɵelementStylingApply(0);
            }
          }
          `;

      const result = compile(files, angularFiles);
      expectEmit(result.source, template, 'Incorrect template');
    });

  });
});
