import { ApplicationRef, ChangeDetectorRef, Component, ElementRef, NgZone, OnInit, SimpleChange } from '@angular/core';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit  {

  test = [
    {
      name: 1,
      checked: false
    },
    {
      name: 2,
      checked: true
    },
    {
      name: 3,
      checked: true
    }
  ];

  constructor(
    // ngZone: NgZone,
    // private applicationRef: ApplicationRef,
    private cdr: ChangeDetectorRef
  ) {
    // ngZone.onMicrotaskEmpty.subscribe(() => {
    //   console.log('should check now');
    // });
    // setTimeout(() => {}, 3000);
    // fetch('').then(() => {});
  }

  ngOnInit() {

  }

  ngOnChange(change: SimpleChange) {
    console.log('这里是调试2');
    console.log(change);

  }

  // 开启变更检测
  // tick() {
  //   this.applicationRef.tick();
  // }

  click() {
    // this.test[0].checked = !this.test[0].checked;
    console.log('这里是调试1');
    this.test[0].checked = true;
    console.log(this.test);
    // 不更新试图
    this.test = JSON.parse(JSON.stringify(this.test));

    // 更新视图
    // this.test = [
    //   {
    //     name: 1,
    //     checked: true
    //   },
    //   {
    //     name: 2,
    //     checked: true
    //   },
    //   {
    //     name: 3,
    //     checked: true
    //   }
    // ];

    // 不更新试图
    // this.applicationRef.tick();

    // this.cdr.detectChanges();
  }

}
