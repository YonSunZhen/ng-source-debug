/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import '@angular/core/test/bundling/util/src/reflect_metadata';

import {CommonModule} from '@angular/common';
import {Component, ElementRef, NgModule, ɵPlayState as PlayState, ɵPlayer as Player, ɵPlayerHandler as PlayerHandler, ɵaddPlayer as addPlayer, ɵrenderComponent as renderComponent} from '@angular/core';

@Component({
  selector: 'animation-world',
  template: `
    <nav>
      <button (click)="doAnimate()">Populate List</button>
    </nav>
    <div class="list">
      <div *ngFor="let item of items" class="record" [class]="makeClass(item)">
        {{ item }}
      </div>
    </div>
  `,
})
class AnimationWorldComponent {
  items: any[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  private _hostElement: HTMLElement;

  constructor(element: ElementRef) { this._hostElement = element.nativeElement; }

  makeClass(index: number) { return `record-${index}`; }

  doAnimate() {
    const elements = this._hostElement.querySelectorAll('div.record') as any as HTMLElement[];
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      const delay = i * 100;
      const player = buildAnimationPlayer(element, 'fadeInOut', `500ms ease-out ${delay}ms both`);
      addPlayer(element, player);
    }
  }
}

@NgModule({declarations: [AnimationWorldComponent], imports: [CommonModule]})
class AnimationWorldModule {
}


function buildAnimationPlayer(element: HTMLElement, animationName: string, time: string): Player {
  return new SimpleKeyframePlayer(element, animationName, time);
}

class SimpleKeyframePlayer implements Player {
  state = PlayState.Pending;
  parent: Player|null = null;
  private _animationStyle: string;
  private _listeners: {[stateName: string]: (() => any)[]} = {};
  constructor(private _element: HTMLElement, private _animationName: string, time: string) {
    this._animationStyle = `${time} ${_animationName}`;
  }
  private _start() {
    this._element.style.animation = this._animationStyle;
    const animationFn = (event: AnimationEvent) => {
      if (event.animationName == this._animationName) {
        this._element.removeEventListener('animationend', animationFn);
        this.finish();
      }
    };
    this._element.addEventListener('animationend', animationFn);
  }
  addEventListener(state: PlayState|string, cb: () => any): void {
    const key = state.toString();
    const arr = this._listeners[key] = (this._listeners[key] || []);
    arr.push(cb);
  }
  play(): void {
    if (this.state <= PlayState.Pending) {
      this._start();
    }
    if (this.state != PlayState.Running) {
      setAnimationPlayState(this._element, 'running');
      this.state = PlayState.Running;
      this._emit(this.state);
    }
  }
  pause(): void {
    if (this.state != PlayState.Paused) {
      setAnimationPlayState(this._element, 'paused');
      this.state = PlayState.Paused;
      this._emit(this.state);
    }
  }
  finish(): void {
    if (this.state < PlayState.Finished) {
      this._element.style.animation = '';
      this.state = PlayState.Finished;
      this._emit(this.state);
    }
  }
  destroy(): void {
    if (this.state < PlayState.Destroyed) {
      this.finish();
      this.state = PlayState.Destroyed;
      this._emit(this.state);
    }
  }
  capture(): any {}
  private _emit(state: PlayState) {
    const arr = this._listeners[state.toString()] || [];
    arr.forEach(cb => cb());
  }
}

function setAnimationPlayState(element: HTMLElement, state: string) {
  element.style.animationPlayState = state;
}

class AnimationDebugger implements PlayerHandler {
  private _players: Player[] = [];

  flushPlayers() {
    this._players.forEach(player => {
      if (!player.parent) {
        player.play();
      }
    });
    this._players.length = 0;
  }

  queuePlayer(player: Player): void { this._players.push(player); }
}

const playerHandler = new AnimationDebugger();
renderComponent(AnimationWorldComponent, {playerHandler});
