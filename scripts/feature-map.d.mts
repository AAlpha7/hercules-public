export const FEATURE_MAP_DOC: string;

export type FeatureMapAnchor = {
  anchor: string;
  file: string;
  dynamic: boolean;
};

export type FeatureMapScene = {
  name: string;
  steps: string[];
  anchors: string[];
  taskIds: string[];
};

export type FeatureMapModel = {
  anchors: FeatureMapAnchor[];
  scenes: FeatureMapScene[];
  fixtureTaskIds: string[];
  unknownAnchors: string[];
  unknownTaskIds: string[];
};

export function collectFeatureMap(repoRoot: string): Promise<FeatureMapModel>;
export function renderFeatureMap(model: FeatureMapModel): string;
