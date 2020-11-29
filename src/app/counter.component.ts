import { Component, ChangeDetectorRef } from '@angular/core';
@Component({
  // tslint:disable-next-line: component-selector
  selector: 'counter',
  template: `
    <div>{{ count }}</div>
    <button (click)="add()">add</button>
    <button (click)="minus()">minus</button>
  `
})
export class CounterComponent {
  constructor(private cdr: ChangeDetectorRef) {}
  count = 0;
  add() {
    this.count += 1;
    // 变更检测更近一层
    this.cdr.detectChanges();
  }
  minus() {
    this.count -= 1;
    this.cdr.detectChanges();
  }
}
