import { enableProdMode } from '@angular/core';
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { AppModule } from './app/app.module';
import { environment } from './environments/environment';

if (environment.production) {
  enableProdMode();
}
// 关闭变更检测 , { ngZone: 'noop'}
platformBrowserDynamic().bootstrapModule(AppModule)
  .then(ref => {
    // tslint:disable: no-string-literal
    if (window['ngRef']) {
      window['ngRef'].destroy();
    }
    window['ngRef'] = ref;
  })
  .catch(err => console.error(err));
