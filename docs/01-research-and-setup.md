# 커플 앨범 앱 — 기존 앱 조사 · 실현 가능성 · 개발환경 세팅

> 작성일: 2026-10-11
> 대상: Android(갤럭시) 1대 + iPhone 1대, 두 사람 전용

## 0. 요구사항 정리

1. 클라우드를 이용한 사진/동영상 실시간 동기화 및 공유
2. 앱에서 앨범을 만들면 **두 사람의 폰 기본 갤러리에 같은 이름의 앨범**이 생성됨
3. 각자 폰에서 그 앨범에 넣은 사진/동영상만 자동 업로드 → 상대 폰의 같은 앨범에 자동 저장
   (= "선택한 로컬 앨범 ↔ 상대 로컬 앨범" 양방향 동기화)

핵심은 **"클라우드 공유 앨범"이 아니라 "양쪽 폰의 기본 갤러리 앨범끼리 동기화"** 라는 점이다.

---

## 1. 기존 앱 조사 결과

| 앱 | 안드↔iOS | 특정 로컬 앨범만 자동 업로드 | 상대 폰 **로컬 갤러리 앨범**에 자동 저장 | 비고 |
|---|---|---|---|---|
| Google 포토 공유 앨범 | O | X (수동 추가) | X | 앱 안에서만 보임 |
| Google 포토 파트너 공유 | O | X (전체/인물 기준) | △ (상대 '라이브러리'에 저장, 기기 앨범 아님) | |
| Google 포토 기기 폴더 백업(안드) | – | O | X | 내 계정 백업일 뿐, 공유 아님 |
| iCloud 공유 앨범 | △ (안드는 웹 링크로 열람) | X | X | 안드로이드 앱 없음 |
| 네이버 MYBOX | O | △ (폴더 단위 백업) | X | 받은 쪽 갤러리 반영 안 됨 |
| 사이사이 / Coupled 등 커플앱 | O | X | X | 앱 내부 앨범에 수동 업로드 방식 |
| Syncthing / Möbius Sync | O | 안드 O / iOS X | iOS X | iOS는 '사진 앱 앨범'에 접근 불가 |
| Les Pas (+Nextcloud) | 안드만 | O | 안드만 O | 개인 Nextcloud 서버 필요, iOS 없음 |
| Sync with Files (iOS) | iOS만 | O | X | 단방향, 파일 앱으로만 복사 |

**결론: 요구사항 2·3(양쪽 기본 갤러리 앨범끼리 자동 양방향 동기화)을 크로스플랫폼으로 만족하는 앱은 찾지 못했다.**
기존 서비스는 모두 "클라우드 쪽 앨범을 앱 안에서 보는" 구조이고, 상대 폰의 *로컬 갤러리 앨범*에 자동으로 써 주지 않는다.

---

## 2. 직접 제작 가능 여부

**가능하다.** 단, iOS 쪽의 백그라운드 제약 때문에 "실시간"의 정도가 방향별로 다르다.

### Android (갤럭시)
| 기능 | 구현 방법 | 난이도 |
|---|---|---|
| 앨범 생성 | 삼성 갤러리의 앨범 = 폴더. `MediaStore`에 `RELATIVE_PATH = "Pictures/<앨범명>"`으로 파일을 넣으면 앨범으로 표시 | 쉬움 |
| 앨범에 옮긴 파일 감지 | `ContentObserver`(MediaStore) + WorkManager `addContentUriTrigger`, 포그라운드 서비스(선택) | 보통 |
| 업로드 | WorkManager (네트워크 조건, 재시도) | 보통 |
| 상대가 올린 파일 수신 | FCM 푸시 → WorkManager로 다운로드 → MediaStore로 해당 폴더에 저장 | 보통 |
| 주의 | 삼성 배터리 최적화("절전 앱/딥 슬립") 예외 등록 안내 필요. Android 14+ '일부 사진만 허용' 시 동작 불가 → 전체 접근 권한 요청 | |

→ **거의 실시간 양방향 가능.**

### iOS (아이폰)
| 기능 | 구현 방법 | 난이도 |
|---|---|---|
| 앨범 생성 | PhotoKit `PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle:)` | 쉬움 |
| 앨범에 추가된 사진 감지 | 앱 실행 중: `PHPhotoLibraryChangeObserver` / 앱 재실행 시: `PHPhotoLibrary.fetchPersistentChanges(since:)`(iOS 16+) 로 놓친 변경 확인 | 보통 |
| 백그라운드 업로드 | **iOS 26.1+ Background Resource Upload 확장**(백업 앱용 공식 API, 앱이 꺼져 있어도 시스템이 업로드 수행) + 보조로 `BGProcessingTask` | 어려움 |
| 상대가 올린 파일 수신·저장 | 사일런트 푸시/BGAppRefresh로 백그라운드 `URLSession` 다운로드 → 사진 앨범에 저장. **iOS가 깨워 주는 시점은 시스템 재량**이므로, 보장 시점은 "앱을 열었을 때" | 어려움 |

→ **아이폰 → 갤럭시**: iOS 26.1 이상이면 백그라운드 업로드로 준실시간 가능
→ **갤럭시 → 아이폰**: 클라우드에는 즉시 올라가고 아이폰엔 푸시 알림이 즉시 감. 아이폰 **사진 앱 앨범에 저장되는 것은 iOS가 백그라운드 시간을 줄 때 또는 앱을 열 때**(열면 수 초 내 반영). 이것은 Apple 정책상 어떤 앱도 우회할 수 없는 한계.

### 설계상 꼭 정해야 할 것
- **루프 방지**: 상대에게서 받아 저장한 파일이 다시 업로드되지 않도록 파일 해시(SHA-256)/원격 ID 매핑을 로컬 DB(Room / SwiftData)에 기록
- **삭제 동기화 여부**: 한쪽에서 앨범에서 빼면 상대 쪽도 지울지(권장: 처음엔 삭제 비동기화, 추가만 동기화)
- **원본 화질**: iPhone HEIC/Live Photo, 갤럭시 모션포토 → 원본 그대로 저장할지 JPEG 변환할지
- **저장 용량/비용**: 동영상 위주면 월 수십 GB 가능 → 스토리지 선택에 영향

---

## 3. 아키텍처 및 기술 스택 (권장)

```
┌──────────────┐        ┌──────────────────────────┐        ┌──────────────┐
│ Android 앱    │ ─업로드→│ Firebase                 │←업로드─ │ iOS 앱        │
│ Kotlin/Compose│        │  Auth (Google/Apple 로그인)│        │ Swift/SwiftUI│
│ MediaStore    │ ←FCM── │  Firestore (앨범·미디어 메타)│ ─APNs→ │ PhotoKit     │
│ WorkManager   │        │  Cloud Storage (원본 파일)  │        │ Upload Ext.  │
└──────────────┘        │  Cloud Functions (푸시 발송) │        └──────────────┘
                        └──────────────────────────┘
```

**왜 Flutter/React Native가 아니라 네이티브(Kotlin + Swift)인가?**
이 앱의 난이도 90%는 OS 고유의 백그라운드 사진 감지/업로드/저장이다. iOS 업로드 확장(App Extension)은 Swift로만 작성 가능하고, 크로스플랫폼 프레임워크는 백그라운드 실행에서 오히려 제약이 많다. UI는 단순(앨범 목록, 동기화 상태, 설정)하므로 두 번 만들어도 부담이 작다.

**백엔드: Firebase** — 로그인·DB·파일 저장·푸시를 한 번에 해결, 양 플랫폼 SDK가 성숙.
- 2024-10 이후 Cloud Storage for Firebase는 **Blaze(종량제) 요금제 필수**. 2인 사용이면 무료 사용량(5GB 저장 등) 근처 → 월 수백~수천 원 수준. 예산 알림을 꼭 설정.
- 동영상이 많아 용량이 커지면 Cloudflare R2(10GB 무료, 송신비 무료)로 스토리지만 교체 가능하도록 업로드 계층을 추상화해 둘 것.

**Firestore 데이터 모델(초안)**
```
couples/{coupleId}            members: [uidA, uidB], inviteCode
couples/{coupleId}/albums/{albumId}
    name, createdBy, createdAt
couples/{coupleId}/albums/{albumId}/media/{mediaId}
    storagePath, sha256, mimeType, width, height, takenAt,
    uploadedBy, uploadedAt, originalFilename
users/{uid}                   fcmTokens: [...], platform
```
Security Rules로 `members`에 포함된 uid만 읽기/쓰기 허용.

**최소 지원 OS**
- Android: 10 (API 29) 이상 — `RELATIVE_PATH` 지원
- iOS: 16 이상 (persistent changes), 백그라운드 업로드는 26.1 이상에서 활성화

---

## 4. 개발환경 세팅 (상세)

### 4-0. 준비물 체크리스트

| 항목 | 필수 | 비용 | 비고 |
|---|---|---|---|
| **Mac** (Apple Silicon 권장, RAM 16GB+) | **iOS 빌드에 필수** | – | Xcode는 macOS 전용. 없다면 중고 M1/M2 Mac mini가 가장 저렴한 선택 |
| Windows/Mac PC (Android 개발) | 필수 | – | Mac 하나로 둘 다 가능 |
| Apple Developer Program | **사실상 필수** | 연 $99 (약 13만 원) | 무료 계정은 7일마다 재설치, 푸시 알림·일부 확장 기능 불가. TestFlight로 여자친구 폰에 배포하려면 필요 |
| Google Play Console | 선택 | 1회 $25 | 본인 폰에만 쓸 거면 APK 직접 설치로 충분 |
| Google 계정 (Firebase) | 필수 | Blaze 종량제 | 예산 알림 설정 |
| 갤럭시 실기기 + USB-C 케이블 | 필수 | – | |
| 아이폰 실기기 + 케이블 | 필수 | – | **사진 백그라운드 업로드 확장은 시뮬레이터에서 동작 안 함** |
| Git / GitHub | 필수 | 무료 | 이 저장소 |

### 4-1. 공통 도구

**macOS 기준**
```bash
# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install git node        # node: Firebase CLI / Cloud Functions 용 (LTS 사용)
brew install --cask android-studio
brew install --cask visual-studio-code   # 선택 (Firebase 규칙/Functions 편집용)

npm install -g firebase-tools
firebase login
```

**Windows 기준 (Android만)**
```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install Google.AndroidStudio
npm install -g firebase-tools
firebase login
```

Git 기본 설정:
```bash
git config --global user.name  "이름"
git config --global user.email "이메일"
git clone https://github.com/swkim1912/couple_album.git
```

### 4-2. Android 개발환경

1. **Android Studio 최신 안정 버전** 설치 → 첫 실행 시 Standard 설정 (JDK 17+ 번들 포함, 별도 JDK 설치 불필요)
2. `Settings > Languages & Frameworks > Android SDK`
   - SDK Platforms: 최신 Android(API 35 이상) + 테스트용 API 29
   - SDK Tools: Android SDK Build-Tools, Platform-Tools, Emulator, Google Play services
3. **갤럭시 개발자 모드 켜기**
   - 설정 → 휴대전화 정보 → 소프트웨어 정보 → **빌드번호 7번 탭**
   - 설정 → 개발자 옵션 → **USB 디버깅 ON**
   - (선택) 무선 디버깅 ON → Android Studio `Pair Devices Using Wi-Fi`
   - Windows는 [삼성 USB 드라이버](https://developer.samsung.com/android-usb-driver) 설치
4. 연결 확인
   ```bash
   adb devices      # 기기가 'device' 로 표시되면 성공
   ```
5. 프로젝트 생성: `New Project > Empty Activity (Compose)`
   - Name: `CoupleAlbum`, Package: `com.<본인ID>.couplealbum`
   - Location: `couple_album/android`
   - Minimum SDK: **API 29**, Build configuration: **Kotlin DSL**
6. 주요 의존성(`app/build.gradle.kts`, 버전은 BoM/최신으로)
   ```kotlin
   plugins {
       id("com.google.gms.google-services")
       id("com.google.devtools.ksp")
   }
   dependencies {
       implementation(platform("com.google.firebase:firebase-bom:<최신>"))
       implementation("com.google.firebase:firebase-auth")
       implementation("com.google.firebase:firebase-firestore")
       implementation("com.google.firebase:firebase-storage")
       implementation("com.google.firebase:firebase-messaging")
       implementation("androidx.work:work-runtime-ktx:<최신>")
       implementation("androidx.room:room-ktx:<최신>")
       ksp("androidx.room:room-compiler:<최신>")
       implementation("io.coil-kt.coil3:coil-compose:<최신>")   // 썸네일 표시
       implementation("androidx.credentials:credentials:<최신>") // Google 로그인
   }
   ```
7. `AndroidManifest.xml` 권한
   ```xml
   <uses-permission android:name="android.permission.INTERNET"/>
   <uses-permission android:name="android.permission.READ_MEDIA_IMAGES"/>
   <uses-permission android:name="android.permission.READ_MEDIA_VIDEO"/>
   <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32"/>
   <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC"/>
   <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>
   <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"/>
   ```
8. **디버그 SHA-1 확인** (Firebase / Google 로그인 등록용)
   ```bash
   cd couple_album/android
   ./gradlew signingReport
   ```

### 4-3. iOS 개발환경 (Mac 필수)

1. **App Store에서 최신 Xcode** 설치 (용량 큼, 40GB+ 여유 공간 확보) → 최초 실행 시 iOS 플랫폼 컴포넌트 설치
   ```bash
   sudo xcode-select -s /Applications/Xcode.app
   xcodebuild -version
   ```
2. **Apple Developer Program 가입** (developer.apple.com, 승인까지 보통 1~2일)
3. Xcode → `Settings > Accounts` → Apple ID 추가 → Team 확인
4. **아이폰 준비**
   - 케이블 연결 → "이 컴퓨터를 신뢰" → Xcode `Window > Devices and Simulators`에 표시 확인
   - 아이폰 설정 → 개인정보 보호 및 보안 → **개발자 모드 ON** (재부팅)
   - iOS 26.1 이상으로 업데이트 (백그라운드 업로드 확장 사용)
5. 프로젝트 생성: `File > New > Project > iOS App`
   - Product Name: `CoupleAlbum`, Interface: **SwiftUI**, Language: **Swift**, Storage: **SwiftData**
   - Bundle ID: `com.<본인ID>.couplealbum`
   - Location: `couple_album/ios`
   - Minimum Deployments: iOS 16 이상
6. **Capabilities** (`Target > Signing & Capabilities > + Capability`)
   - Push Notifications
   - Background Modes: ☑ Remote notifications, ☑ Background fetch, ☑ Background processing
   - Sign in with Apple (Apple 로그인 사용 시)
   - App Groups: `group.com.<본인ID>.couplealbum` (앱 ↔ 업로드 확장 간 데이터 공유)
7. **Info.plist 키**
   ```xml
   <key>NSPhotoLibraryUsageDescription</key>
   <string>커플 앨범에 넣은 사진을 상대방과 동기화하기 위해 사진 접근이 필요합니다.</string>
   <key>NSPhotoLibraryAddUsageDescription</key>
   <string>상대방이 공유한 사진을 앨범에 저장합니다.</string>
   <key>BGTaskSchedulerPermittedIdentifiers</key>
   <array>
       <string>com.<본인ID>.couplealbum.sync</string>
   </array>
   ```
8. **사진 백그라운드 업로드 확장 타깃 추가**
   - `File > New > Target > Generic Extension` → 이름 `PhotoUploadExtension`
   - 확장 포인트 ID: `com.apple.photos.background-upload`
   - 같은 App Group 추가
   - 참고: [Uploading asset resources in the background (Apple)](https://developer.apple.com/documentation/photokit/uploading-asset-resources-in-the-background)
   - ⚠️ 시뮬레이터 미지원 → 실기기에서만 테스트
9. **Firebase SDK 추가**: `File > Add Package Dependencies` → `https://github.com/firebase/firebase-ios-sdk`
   - FirebaseAuth, FirebaseFirestore, FirebaseStorage, FirebaseMessaging 선택
10. **APNs 키 발급** (푸시용)
    - developer.apple.com → Certificates, IDs & Profiles → Keys → `+` → Apple Push Notifications service 체크 → **.p8 파일 다운로드**(1회만 가능, 안전하게 보관) / Key ID, Team ID 메모

### 4-4. Firebase 프로젝트 세팅

1. [console.firebase.google.com](https://console.firebase.google.com) → 프로젝트 생성 `couple-album` (Analytics는 꺼도 됨)
2. **요금제 Blaze로 업그레이드** → Google Cloud 콘솔 `결제 > 예산 및 알림`에서 월 예산(예: 5,000원) 알림 설정
3. **Android 앱 등록**: 패키지명 + 디버그 SHA-1 입력 → `google-services.json` → `android/app/`에 복사
4. **iOS 앱 등록**: Bundle ID 입력 → `GoogleService-Info.plist` → Xcode 프로젝트에 드래그(타깃 체크)
5. **Authentication** → 로그인 방법: Google, Apple 활성화 (또는 처음엔 이메일/비밀번호로 간단히 시작)
6. **Firestore Database** 생성 → 위치 `asia-northeast3 (서울)` → 프로덕션 모드
7. **Storage** 생성 → 같은 리전(서울)
8. **Cloud Messaging** → 프로젝트 설정 → Cloud Messaging → Apple 앱 구성 → APNs 인증 키(.p8), Key ID, Team ID 업로드
9. 로컬에서 규칙/Functions 관리용 초기화
   ```bash
   cd couple_album
   mkdir firebase && cd firebase
   firebase init   # Firestore, Storage, Functions(TypeScript), Emulators 선택
   firebase emulators:start   # 로컬 테스트
   ```
   Cloud Function 예시 역할: `media` 문서가 생성되면 상대방 FCM 토큰으로 사일런트 + 일반 푸시 발송

### 4-5. 비밀정보 / Git 관리

`.gitignore`에 추가 (저장소가 공개라면 특히 중요):
```
# Android
android/.gradle/
android/build/
android/app/build/
android/local.properties
*.keystore
*.jks

# iOS
ios/**/xcuserdata/
ios/DerivedData/
*.p8

# Firebase
firebase/functions/node_modules/
firebase/.firebase/
```
`google-services.json`, `GoogleService-Info.plist`는 비밀키는 아니지만, **공개 저장소라면 커밋하지 말고** Security Rules + App Check로 보호할 것.

### 4-6. 배포 (두 사람만 쓰는 방법)
- **갤럭시**: Android Studio에서 바로 Run, 또는 `./gradlew assembleRelease`로 서명된 APK 설치
- **아이폰**: Xcode에서 실기기에 바로 Run(개발용) → 안정화 후 **TestFlight** 내부 테스터로 여자친구 Apple ID 초대(빌드 90일 유효, 갱신 업로드). 앱스토어 공개 심사는 불필요.

---

## 5. 권장 저장소 구조

```
couple_album/
├── android/        # Android Studio 프로젝트 (Kotlin, Compose)
├── ios/            # Xcode 프로젝트 (Swift, SwiftUI) + PhotoUploadExtension
├── firebase/       # firestore.rules, storage.rules, functions/
└── docs/           # 설계 문서
```

## 6. 개발 단계 제안 (마일스톤)

1. **M1** Firebase 연결 + 로그인 + 커플 연결(초대 코드)
2. **M2** 앨범 생성 → Firestore 기록 → 양쪽 폰 갤러리에 같은 이름 앨범 생성
3. **M3** Android: 폴더 감지 → 업로드 / 수신 → 폴더 저장 (양방향 Android 단독 검증)
4. **M4** iOS: 앱 실행 중 감지·업로드, 실행 시 수신·저장
5. **M5** iOS 백그라운드 업로드 확장 + 사일런트 푸시 수신
6. **M6** 루프 방지·중복 제거·재시도·진행률 UI·배터리 최적화 안내

## 참고 자료
- [Apple: Uploading asset resources in the background](https://developer.apple.com/documentation/photokit/uploading-asset-resources-in-the-background)
- [9to5Mac: iOS 26.1 third-party photo backup in background](https://9to5mac.com/2025/10/24/ios-26-1-third-party-photos-backup-background/)
- [Les Pas (F-Droid)](https://f-droid.org/packages/site.leos.apps.lespas/)
- [Sync with Files (App Store)](https://apps.apple.com/sa/app/sync-with-files/id6754183905)
- [사이사이 - 커플 앨범 (Google Play)](https://play.google.com/store/apps/details?id=kr.s2s2)
