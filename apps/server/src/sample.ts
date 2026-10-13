/** 처음 실행할 때 만들어지는 예시 데이터 (예시/ 폴더) */

export const SAMPLE_MAP = `---
id: map_sample
title: 운영체제
layout: mindmap
---

# 운영체제 ^root

- 프로세스 관리 ^a1b2
  - 프로세스 vs 스레드 {color=red tags=시험} ^c3d4
    > 📌 스레드는 코드/데이터/힙을 공유하고,
    > 스택만 따로 가진다.
    - 프로세스 :: 실행 중인 프로그램, 독립된 메모리 공간 ^e5f6
    - 스레드 :: 프로세스 내 실행 흐름 ^g7h8
  - CPU 스케줄링 [[예시/운영체제/pages/스케줄링]] {collapsed} ^i9j0
    - 선점형: ==RR==, SRTF ^k1l2
    - 비선점형: FCFS, SJF ^k3l4
- 메모리 관리 {color=blue} ^m3n4
  > 📌 **페이지 테이블** 은 가상→물리 주소 변환표.
  > 수식: $EAT = (1-p) ma + p t$
  > - TLB 적중률이 핵심
  - 페이징 ^o5p6
    - 내부 단편화 발생 ^o7p8
  - 세그멘테이션 ^o9p0
    - 외부 단편화 발생 ^q1r2
- 유효 접근 시간 $EAT = (1-p)\\cdot ma + p \\cdot t$ ^q7r8
`;

export const SAMPLE_PAGE = `---
title: "CPU 스케줄링"
---

# CPU 스케줄링

프로세스에 CPU를 **언제, 얼마나** 줄지 정하는 정책. 관련 개념: [[자료구조.mm#^h1|해시 테이블]], 맵으로 돌아가기: [[예시/운영체제.mm]]

| 알고리즘 | 선점 | 특징 |
|---|---|---|
| FCFS | 아니오 | 단순, ==호위 효과== |
| RR | 예 | 시간 할당량 $q$ 마다 교대 |

평균 대기 시간: $$W = \\frac{1}{n}\\sum_{i=1}^{n} w_i$$

\`\`\`python
def round_robin(procs, q):
    t = 0
    while procs:
        p = procs.pop(0)
        run = min(p.burst, q)
        t += run
        p.burst -= run
        if p.burst > 0:
            procs.append(p)
    return t
\`\`\`
`;

export const SAMPLE_MAP_2 = `---
id: map_ds
title: 자료구조
layout: logic-right
---

# 자료구조 ^root

- 해시 테이블 ^h1
  - 충돌 해결: 체이닝, 개방 주소법 ^h2
- 트리 ^t1
  - 이진 탐색 트리 ^t2
`;
