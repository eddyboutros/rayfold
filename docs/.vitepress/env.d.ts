declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent;
  export default component;
}

declare module "*.css";

declare module "*?raw" {
  const text: string;
  export default text;
}
