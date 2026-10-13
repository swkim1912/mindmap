export interface TreeEntry {
  name: string;
  path: string;
  kind: 'dir' | 'map';
  children?: TreeEntry[];
}
