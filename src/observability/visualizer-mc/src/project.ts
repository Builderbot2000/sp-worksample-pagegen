import {makeProject} from '@motion-canvas/core';

// @ts-ignore — ?scene virtual modules are resolved by the Motion Canvas Vite plugin
import sceneMain from './scenes/scene-main?scene';

import runData from './data/run-data.json';

export default makeProject({
  name: runData.meta.name ?? runData.meta.runId,
  scenes: [sceneMain],
});
