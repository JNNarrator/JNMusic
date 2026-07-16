/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
declare module 'pinia' {
  import { DefineStoreOptions } from 'pinia'
  export function defineStore<
    Id extends string,
    S extends Record<string, any>,
    G extends Record<string, (...args: any[]) => any>,
    A extends Record<string, (...args: any[]) => any>
  >(
    id: Id,
    storeSetup: () => S & G & A,
    options?: DefineStoreOptions<Id, S, G, A>
  ): ReturnType<typeof import('pinia')['defineStore']>
}
