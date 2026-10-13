import { api } from './api';

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

export function imageFiles(list: DataTransfer | null): File[] {
  if (!list) return [];
  return [...list.files].filter((f) => f.type in EXT_BY_TYPE);
}

/** 이미지를 from 파일에 딸린 assets/ 에 올리고, from 기준 상대 경로를 돌려준다 */
export async function uploadImage(file: Blob, from: string): Promise<string> {
  const ext = EXT_BY_TYPE[file.type];
  if (!ext) throw new Error(`지원하지 않는 이미지 형식입니다: ${file.type || '알 수 없음'}`);
  return api.upload(from, file, ext);
}

/** 이미지 참조들을 커서 위치에 별도 줄로 넣고 새 값을 돌려준다 */
export function insertImageRefs(ta: HTMLTextAreaElement, refs: string[]): string {
  const before = ta.value.slice(0, ta.selectionStart);
  const after = ta.value.slice(ta.selectionEnd);
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  const tail = after === '' || after.startsWith('\n') ? '' : '\n';
  return insertAtCaret(ta, `${lead}${refs.map((r) => `![](${r})`).join('\n')}${tail}`);
}

/** textarea 의 커서 위치에 text 를 넣고 새 값을 돌려준다 */
export function insertAtCaret(ta: HTMLTextAreaElement, text: string): string {
  const start = ta.selectionStart;
  ta.setRangeText(text, start, ta.selectionEnd, 'end');
  return ta.value;
}
