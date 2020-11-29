/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {createTNode, createTView} from '@angular/core/src/render3/instructions/shared';
import {TNodeType} from '@angular/core/src/render3/interfaces/node';
import {TViewType} from '@angular/core/src/render3/interfaces/view';
import {onlyInIvy} from '@angular/private/testing';

import {isShapeOf, ShapeOf} from './is_shape_of';
import {matchDomElement, matchDomText, matchObjectShape, matchTNode, matchTView} from './matchers';
import {dedent} from './utils';

describe('render3 matchers', () => {
  describe('matchObjectShape', () => {
    interface MyShape {
      propA: any;
      propB: any;
    }

    const myShape: MyShape = {propA: 'value', propB: 3};
    function isMyShape(obj: any): obj is MyShape {
      return isShapeOf<MyShape>(obj, ShapeOfMyShape);
    }
    const ShapeOfMyShape: ShapeOf<MyShape> = {propA: true, propB: true};
    function matchMyShape(expected?: Partial<MyShape>): jasmine.AsymmetricMatcher<MyShape> {
      return matchObjectShape('MyShape', isMyShape, expected);
    }

    it('should match', () => {
      expect(isMyShape(myShape)).toBeTrue();
      expect(myShape).toEqual(matchMyShape());
      expect(myShape).toEqual(matchMyShape({propA: 'value'}));
      expect({node: myShape}).toEqual({node: matchMyShape({propA: 'value'})});
    });

    it('should produce human readable errors', () => {
      const matcher = matchMyShape({propA: 'different'});
      expect(matcher.asymmetricMatch(myShape, [])).toEqual(false);
      expect(matcher.jasmineToString!()).toEqual(dedent`
        MyShape({
          propA: "value",
          ...
        }) != MyShape({
          propA: "different"
        }))`);
    });
  });

  describe('matchTView', () => {
    const tView = createTView(TViewType.Root, 1, null, 2, 3, null, null, null, null, null);
    it('should match', () => {
      expect(tView).toEqual(matchTView());
      expect(tView).toEqual(matchTView({type: TViewType.Root}));
      expect({node: tView}).toEqual({node: matchTView({type: TViewType.Root})});
    });
  });
  describe('matchTNode', () => {
    const tView = createTView(TViewType.Root, 1, null, 2, 3, null, null, null, null, null);
    const tNode = createTNode(tView, null, TNodeType.Element, 1, 'tagName', []);

    it('should match', () => {
      expect(tNode).toEqual(matchTNode());
      expect(tNode).toEqual(matchTNode({type: TNodeType.Element, tagName: 'tagName'}));
      expect({node: tNode}).toEqual({node: matchTNode({type: TNodeType.Element})});
    });
  });

  describe('matchDomElement', () => {
    const div = document.createElement('div');
    div.setAttribute('name', 'Name');
    it('should match', () => {
      expect(div).toEqual(matchDomElement());
      expect(div).toEqual(matchDomElement('div', {name: 'Name'}));
    });

    it('should produce human readable error', () => {
      const matcher = matchDomElement('div', {name: 'other'});
      expect(matcher.asymmetricMatch(div, [])).toEqual(false);
      expect(matcher.jasmineToString!()).toEqual(`[<DIV name="Name"> != <div name="other">]`);
    });
  });

  describe('matchDomText', () => {
    const text = document.createTextNode('myText');
    it('should match', () => {
      expect(text).toEqual(matchDomText());
      expect(text).toEqual(matchDomText('myText'));
    });

    it('should produce human readable error', () => {
      const matcher = matchDomText('other text');
      expect(matcher.asymmetricMatch(text, [])).toEqual(false);
      expect(matcher.jasmineToString!()).toEqual(`[#TEXT: "myText" != #TEXT: "other text"]`);
    });
  });
});