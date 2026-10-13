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
  - CPU 스케줄링 {collapsed} ^i9j0
    - 선점형: ==RR==, SRTF ^k1l2
    - 비선점형: FCFS, SJF ^k3l4
- 메모리 관리 {color=blue} ^m3n4
  - 페이징 ^o5p6
    - 내부 단편화 발생 ^o7p8
  - 세그멘테이션 ^o9p0
    - 외부 단편화 발생 ^q1r2
- 유효 접근 시간 $EAT = (1-p)\\cdot ma + p \\cdot t$ ^q7r8
`;
