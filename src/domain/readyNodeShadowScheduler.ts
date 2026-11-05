/**
 * Domain — ready-node / resource scheduler in shadow mode (adaptive-task-graph step 4).
 * Pure advisory scheduler: dependency-ready + resource-safe recommendations only.
 * Never dispatches, mutates graphs, merges, deploys, or widens permissions.
 */
export * from './readyNodeShadowTypes.js';
export * from './readyNodeShadowCore.js';
