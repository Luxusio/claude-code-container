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

### 개발 워크플로우

```bash
# 코드 수정 후 빌드
npm run build

# ccc 명령어 테스트 (심볼릭 링크라 자동 반영)
ccc --help
```

### 개발 버전 제거

```bash
npm unlink -g claude-code-container
```

## 프로젝트 구조

```
claude-code-container/
├── src/
│   └── index.ts          # CLI 메인 진입점
├── dist/                 # 컴파일된 JavaScript (gitignore)
├── .github/workflows/
│   ├── docker.yml        # Docker Hub 배포
│   └── npm.yml           # npm 배포
├── package.json
├── tsconfig.json
├── CLAUDE.md             # Claude Code 지침
├── CONTRIBUTING.md       # 이 파일
└── README.md             # 사용자 문서
```

## 빌드 명령어

| 명령어 | 설명 |
|--------|------|
| `npm install` | 의존성 설치 |
| `npm run build` | TypeScript 컴파일 |
| `npm link` | 전역 개발 설치 |

## 코드 스타일

- TypeScript ES2015 타겟
- 간결하고 최소한의 코드 유지
- 컨테이너/이미지 자동 정리 구현

## Docker 관련

### 지원하는 명령어

`docker compose`와 `docker-compose` 둘 다 지원해야 합니다.

### 보안 설정

생성되는 docker-compose.yml에 포함되는 보안 옵션:

- `read_only: true` - 읽기 전용 파일시스템
- `cap_drop: [ALL]` - 모든 Linux capability 제거
- `security_opt: [no-new-privileges:true]`
- 리소스 제한 (CPU, 메모리, PIDs)

## 테스트

```bash
# 로컬에서 직접 테스트
ccc init          # 프로젝트 초기화
ccc               # 컨테이너 실행
```

## 배포

### npm 배포

`main` 브랜치에 태그 푸시 시 자동 배포:

```bash
git tag v1.0.0
git push origin v1.0.0
```

### Docker Hub 배포

`.github/workflows/docker.yml`에서 자동 처리됩니다.

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