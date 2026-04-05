// Type declarations for Motion Canvas Vite virtual scene modules.
// Each *.tsx file imported with the ?scene query returns a Scene² object.

declare module '*.tsx?scene' {
  import type {Scene} from '@motion-canvas/core';
  const scene: Scene;
  export default scene;
}
