import { useAux } from './workspace';
import { useStudy } from './study';

/** 대화상자·팝업 페이지·포스트잇 편집·복습 화면 중 하나라도 열려 있으면 맵 위의 키 입력을 받지 않는다 */
export function isOverlayOpen(): boolean {
  const a = useAux.getState();
  const s = useStudy.getState();
  return a.dialog !== null || a.page !== null || a.noteEditing !== null || s.setup !== null || s.session !== null;
}

/** 가리기 모드 중에는 노드를 고칠 수 없다 */
export function isEditLocked(): boolean {
  return useStudy.getState().hide !== null;
}
