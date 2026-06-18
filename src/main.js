import { bootstrapApp } from "./bootstrap.js";

bootstrapApp().catch(function (error) {
  console.error("App bootstrap failed:", error);
});

if (import.meta.hot) {
  import.meta.hot.accept();
}
