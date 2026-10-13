export interface TreeEntry {
  name: string;
  path: string;
  kind: 'dir' | 'map';
  children?: TreeEntry[];
}

export interface SearchHit {
  kind: 'map' | 'page' | 'node';
  path: string;
  nodeId: string | null;
  title: string;
  context: string;
  snippet: string;
}

export interface BacklinkSource {
  kind: 'map' | 'page';
  path: string;
  title: string;
  nodeId: string | null;
  nodeText: string | null;
}

export interface Backlinks {
  file: BacklinkSource[];
  nodes: Record<string, BacklinkSource[]>;
}
