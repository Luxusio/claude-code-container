# Contributing Guide

claude-code-container(ccc) 개발 가이드입니다.

## 개발 환경 설정

### 요구사항

- Node.js 22+
- Docker
- npm

### 설치

```bash
# 저장소 클론
git clone https://github.com/your-username/claude-code-container.git
cd claude-code-container

# 의존성 설치
npm install

# TypeScript 컴파일
npm run build

# 전역으로 개발 버전 설치 (심볼릭 링크)
npm link
```

`npm link` 후 터미널 어디서나 `ccc` 명령어를 사용할 수 있습니다.

## 아키텍처

### 디렉토리 구조

```
~/.ccc/
├── claude/             # Claude credentials (컨테이너에 마운트)
├── locks/              # 세션 락 파일 (세션별 UUID)
│   ├── my-project-a1b2c3d4e5f6-uuid1.lock
│   └── my-project-a1b2c3d4e5f6-uuid2.lock
└── mise/               # 공유 mise 캐시
```

### 컨테이너 구조

```
Container (ccc-<project>-<hash>):
├── /project/<project>-<hash>   # 실제 프로젝트 경로 마운트
├── /claude                      # ~/.ccc/claude 마운트
└── /home/ccc/.local/share/mise  # mise 캐시 마운트
```

### 이미지 빌드

첫 `ccc` 실행 시:
1. `ccc` 이미지가 없으면 Dockerfile로 빌드
2. 이미지로 프로젝트별 컨테이너 생성

Dockerfile 포함 내용:
- ubuntu:24.04 기반
- curl, git, ca-certificates, unzip 설치
- Chromium (headless 테스트용, `CHROME_BIN` 환경변수 설정)
- mise 설치 및 설정
- 글로벌 도구 설치: maven, gradle, yarn, pnpm
- claude-code native 바이너리 (프로젝트 node 버전과 독립)

### 세션 라이프사이클

1. **시작**: `ccc` 실행 → 컨테이너 생성/시작 + 세션 락 파일 생성
2. **실행 중**: 동일 프로젝트에 여러 세션 가능 (다른 락 파일)
3. **종료**: 락 파일 삭제 → 활성 세션 없으면 컨테이너 자동 중지
4. **크래시 복구**: 다음 `ccc` 실행 시 스테일 락 파일 정리

컨테이너 이름이 경로 해시 기반으로 고정되어 `claude --continue`, `--resume` 정상 작동.

### 환경변수 전달

1. **호스트 환경변수 자동 전달**: 시스템 변수(PATH, HOME, LC_* 등) 제외하고 전부 전달
2. **세션별**: `ccc --env KEY=VALUE`

### 시그널 핸들링

- SIGINT (Ctrl+C), SIGTERM, SIGHUP: 정리 후 종료
- 정상 종료: 락 파일 삭제, 다른 세션 없으면 컨테이너 중지

## 프로젝트 구조

```
claude-code-container/
├── src/
│   ├── index.ts          # CLI 메인 진입점
│   └── scanner.ts        # mise용 프로젝트 도구 감지
├── dist/                 # 컴파일된 JavaScript (gitignore)
├── Dockerfile            # 컨테이너 이미지 정의
├── package.json
├── tsconfig.json
├── CLAUDE.md             # Claude Code 지침
├── CONTRIBUTING.md       # 이 파일
└── README.md             # 사용자 문서
```

## 개발 워크플로우

```bash
# 코드 수정 후 빌드
npm run build

# ccc 명령어 테스트 (심볼릭 링크라 자동 반영)
ccc --help
ccc status
```

### 개발 버전 제거

```bash
npm unlink -g claude-code-container
```

## 빌드 명령어

| 명령어 | 설명 |
|--------|------|
| `npm install` | 의존성 설치 |
| `npm run build` | TypeScript 컴파일 |
| `npm link` | 전역 개발 설치 |

## 코드 스타일

- TypeScript ES2022 타겟
- 간결하고 최소한의 코드 유지
- 프로젝트별 컨테이너 + 경로 해시 기반 이름
- 락 파일로 세션 추적 및 크래시 복구

## 주요 컴포넌트

### 컨테이너 관리

- `startProjectContainer()`: 프로젝트 컨테이너 생성/시작
- `stopProjectContainer()`: 컨테이너 중지
- `removeProjectContainer()`: 컨테이너 삭제
- `buildImage()`: Dockerfile로 이미지 빌드

### 세션 관리

- `createSessionLock()`: 세션 락 파일 생성
- `removeSessionLock()`: 락 파일 삭제
- `hasOtherActiveSessions()`: 다른 활성 세션 확인
- `cleanupSession()`: 세션 정리 (락 삭제 + 컨테이너 중지 판단)
- `setupSignalHandlers()`: 시그널 핸들러 등록

### mise 통합

- `ensureMiseConfig()`: `.mise.toml` 존재 확인, 없으면 생성 제안
- `detectProjectToolsAndWriteMiseConfig()`: Claude로 프로젝트 분석하여 mise.toml 생성

## 테스트

```bash
# 프로젝트에서 Claude 실행 (컨테이너 자동 생성)
cd /path/to/project
ccc

# 상태 확인
ccc status

# 쉘 접속
ccc shell

# 정리
ccc rm
```

## 배포

### npm 배포

`main` 브랜치에 태그 푸시 시 자동 배포:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 문제 해결

### `ccc` 명령어를 찾을 수 없음

```bash
# npm link 재실행
npm link

# 또는 PATH 확인
npm config get prefix
```

### 빌드 에러

```bash
# node_modules 재설치
rm -rf node_modules dist
npm install
npm run build
```

### 컨테이너 문제

```bash
# 컨테이너 상태 확인
ccc status
docker ps -a | grep ccc-

# 컨테이너 로그 확인
docker logs ccc-<project>-<hash>

# 컨테이너 삭제 후 재시작
ccc rm
ccc
```

### 이미지 재빌드

```bash
ccc rm
docker rmi ccc
ccc  # 자동으로 새 이미지 빌드
```

### 스테일 세션 수동 정리

```bash
# 락 파일 확인
ls -la ~/.ccc/locks/

# 수동 정리 (필요시)
rm ~/.ccc/locks/*.lock
```
