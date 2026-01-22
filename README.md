# Claude Code Container (ccc)

Docker 컨테이너에서 Claude Code를 격리 실행합니다.

## 특징

- 프로젝트별 격리 컨테이너 (경로 해시 기반)
- 호스트 환경변수 자동 전달
- 세션 종료 시 컨테이너 자동 정리 (다른 세션 없을 때)
- mise 기반 도구 버전 관리
- Chromium 내장 (headless 테스트 지원)
- `--network host`로 포트 직접 접근

## 설치

```bash
git clone https://github.com/your-username/claude-code-container.git
cd claude-code-container

npm install
npm run build
npm link
```

## 빠른 시작

```bash
# 현재 프로젝트에서 Claude 실행 (컨테이너 자동 생성)
ccc

# 이전 세션 이어가기
ccc --continue
ccc --resume

# 컨테이너 쉘 접속
ccc shell

# 임의 명령어 실행
ccc npm install
ccc npm test
```

## 동작 방식

```
~/.ccc/
├── claude/       # Claude credentials (/claude로 마운트)
├── locks/        # 세션 락 파일 (세션별)
└── mise/         # 공유 mise 캐시
```

### 세션 라이프사이클

1. **시작**: 컨테이너 생성/시작 + 세션 락 파일 생성
2. **실행 중**: 같은 프로젝트에서 여러 세션 동시 실행 가능
3. **종료**: 락 파일 삭제, 해당 프로젝트의 다른 세션이 없으면 컨테이너 자동 중지
4. **크래시 복구**: 다음 실행 시 스테일 락 파일 정리

프로젝트 경로 해시 기반으로 컨테이너 이름이 고정되어 `claude --continue`, `--resume` 정상 작동.

## 명령어

```bash
ccc                        # Claude 실행
ccc shell                  # bash 쉘 접속
ccc <command>              # 임의 명령어 실행
ccc --env KEY=VALUE        # 추가 환경변수 설정
ccc stop                   # 현재 프로젝트 컨테이너 중지
ccc rm                     # 현재 프로젝트 컨테이너 삭제
ccc status                 # 전체 컨테이너 상태 확인
```

## 환경변수

### 호스트 환경변수 자동 전달

호스트의 환경변수가 컨테이너로 자동 전달됩니다.

```bash
export JIRA_API_KEY=xxx
ccc  # 컨테이너 안에서 JIRA_API_KEY 사용 가능
```

**제외 목록** (시스템 변수 충돌 방지):
- `PATH`, `HOME`, `USER`, `SHELL`, `PWD`
- `LC_ALL`, `LC_CTYPE`, `LANG`
- macOS 전용 변수 (`TERM_PROGRAM`, `ITERM_*` 등)

### 세션별 환경변수

```bash
ccc --env API_KEY=xxx --env DEBUG=true
```

## 원격 개발 (Remote Development)

저사양 PC에서 고사양 원격 PC의 리소스를 활용하여 개발할 수 있습니다.

### 필요 도구

- [Tailscale](https://tailscale.com/) - 네트워크 연결 (선택, 원격 접속 시 권장)
- [Mutagen](https://mutagen.io/) - 실시간 파일 동기화
- SSH 접속 가능한 원격 호스트

### 사용법

```bash
# MacBook에서 실행 - 첫 번째 (설정 저장됨)
ccc remote my-desktop
# Remote user [user]: john
# Remote path [/Users/me/myproject]: /home/john/myproject
# Config saved.
# Creating sync session...
# Waiting for initial sync... done
# Connecting to my-desktop...
# [이제 데스크탑에서 claude 실행 중]

# 이후에는 간단히
ccc remote

# claude 옵션 전달
ccc remote --continue
ccc remote --resume
```

### 아키텍처

Mutagen이 Docker 컨테이너에 직접 동기화합니다 (파일시스템 경유 없음). Windows/macOS에서 느린 볼륨 마운트를 우회하여 더 나은 성능을 제공합니다.

```
MacBook (노트북)                         Desktop (데스크탑)
┌─────────────────────┐                  ┌─────────────────────────┐
│  소스 코드 (원본)      │                  │  Docker Container       │
│                     │────Mutagen──────►│  /project/<id> (직접)    │
│                     │                  │                         │
│  ccc remote 실행     │──────SSH────────►│  docker exec claude     │
│  터미널 I/O           │◄─────────────────│                         │
└─────────────────────┘                  └─────────────────────────┘
```

### 명령어

```bash
ccc remote <host>       # 원격 연결 (첫 실행 시 설정)
ccc remote              # 저장된 설정으로 연결
ccc remote setup        # 설정 가이드
ccc remote check        # 연결/동기화 상태 확인
ccc remote terminate    # 동기화 세션 종료
```

### 요구사항

1. **원격 호스트에 ccc 설치**: Desktop에도 ccc가 설치되어 있어야 함
2. **SSH 키 인증**: 비밀번호 없이 SSH 접속 가능 권장
3. **Docker 실행 중**: Desktop에서 Docker가 실행 중이어야 함

## 도구 관리 (mise)

`.mise.toml`이 없는 프로젝트에서 첫 `ccc` 실행 시 도구 자동 감지 여부를 묻습니다.

```toml
# .mise.toml 예시
[tools]
node = "22"
java = "temurin-21"
yarn = "1.22.22"
```

**지원 도구**: node, java, python, go, rust, ruby, php, deno, bun

**전역 도구** (이미지에 포함): maven, gradle, yarn, pnpm

## 컨테이너 이미지

Ubuntu 24.04 기반, 포함 항목:
- mise (도구 버전 관리)
- claude-code CLI
- Chromium (headless 테스트용, `CHROME_BIN` 설정됨)
- maven, gradle, yarn, pnpm

이미지 재빌드:

```bash
ccc rm
docker rmi ccc
ccc  # 자동으로 새 이미지 빌드
```

## 리소스 제한

- **메모리/CPU**: 제한 없음 (호스트 리소스 공유)
- **프로세스**: 512개 제한

## 개발

### 빌드 및 테스트

```bash
npm install      # 의존성 설치
npm run build    # TypeScript 컴파일
npm test         # 테스트 실행 (vitest)
npm run test:watch  # 테스트 워치 모드
```

### 프로젝트 구조

```
src/
├── index.ts     # CLI 메인 진입점
├── remote.ts    # 원격 개발 기능
├── scanner.ts   # 프로젝트 도구 감지
└── utils.ts     # 공통 유틸리티
```

자세한 개발 가이드는 [CONTRIBUTING.md](CONTRIBUTING.md) 참고.

## 라이센스

MIT
