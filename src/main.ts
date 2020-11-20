import {COMPILER_OPTIONS, CompilerFactory, createPlatformFactory, enableProdMode, NgModuleRef, PLATFORM_INITIALIZER} from '@angular/core';

import { AppModule } from './app/app.module';
import { environment } from './environments/environment';
import {platformBrowserDynamic} from '@angular/platform-browser-dynamic';
import {Injector, StaticProvider} from "./app/packages/angular/core/src/di";
import {PLATFORM_ID} from "./app/packages/angular/core/src/application_tokens";
import {PlatformRef} from "./app/packages/angular/core/src/application_ref";
import {TestabilityRegistry} from "./app/packages/angular/core/src/testability/testability";
import {Console} from "./app/packages/angular/core/src/console";
import {enableDebugTools} from '@angular/platform-browser';

if (environment.production) {
  enableProdMode();
}

const platform = platformBrowserDynamic();

platform.bootstrapModule(AppModule)
  .catch(err => console.log(err));