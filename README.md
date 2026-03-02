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
sudo node scripts/install.js   # Windows는 sudo 제외
```

Docker 이미지 빌드 시 GitHub API rate limit에 걸리면 토큰을 전달합니다:

```bash
export GITHUB_TOKEN=github_pat_xxx
sudo -E node scripts/install.js
```

**제거:** `sudo node scripts/install.js --uninstall`

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
└── locks/        # 세션 락 파일 (세션별)

Docker Volume:
└── ccc-mise-cache  # mise 캐시 (named volume, macOS/Windows 성능 최적화)
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

### 컨테이너/데스크탑 환경변수 분리

ccc는 컨테이너 안에서 `container=docker`를 자동으로 설정합니다 (systemd 표준 변수).
이를 활용해 mise.toml `[env]`에서 환경별로 다른 .env 파일을 로드할 수 있습니다.

```toml
# mise.toml
[tools]
node = "22"

[env]
_.file = ".env"
_.source = "{{ env.container != '' | iif('.env.ccc', '/dev/null') }}"
```

| 파일 | 로드 환경 | 용도 |
|------|----------|------|
| `.env` | 항상 | 공통 환경변수 |
| `.env.ccc` | 컨테이너만 | 컨테이너 전용 환경변수 |

```bash
# .env - 공통
API_KEY=xxx
LOG_LEVEL=debug

# .env.ccc - 컨테이너 전용 (같은 키로 오버라이드 가능)
DB_HOST=host.docker.internal
API_URL=http://host.docker.internal:3000
```

## SSH 접근

컨테이너에서 Git SSH(private repo clone, 플러그인 설치 등)가 필요할 때 자동으로 호스트의 SSH 설정을 사용합니다.

### 자동 마운트 (설정 불필요)

| 항목 | macOS (Docker Desktop) | Linux |
|------|----------------------|-------|
| SSH 키 (`~/.ssh`) | 읽기전용 마운트 | 읽기전용 마운트 |
| SSH Agent | Docker Desktop 내장 소켓 자동 | `$SSH_AUTH_SOCK` 자동 감지 |

### SSH 인증이 안 될 때

```bash
# 1. 호스트에서 SSH agent에 키가 등록되어 있는지 확인
ssh-add -l

# 키가 없으면 등록
ssh-add ~/.ssh/id_ed25519   # 또는 id_rsa

# 2. 컨테이너 재생성 (새 마운트 적용)
ccc rm
ccc
```

### 확인 방법

```bash
ccc shell
ssh-add -l                          # agent 키 목록
ssh -T git@github.com               # GitHub 접속 테스트
ssh -T git@gitlab.example.com       # GitLab 접속 테스트
```

## Worktree 워크스페이스 (`ccc @<branch>`)

`ccc @<branch>` 명령으로 브랜치별 격리 작업 환경을 만들 수 있습니다. 현재 디렉토리의 git 레포들에 `git worktree`를 자동 생성하고, claude를 그 워크스페이스에서 실행합니다.

### 구조

```
~/projects/
├── my-project/          # 원본 (git repos + 기타 파일)
│   ├── backend/         # git repo
│   ├── frontend/        # git repo
│   └── shared/          # 일반 디렉토리
└── my-project--feature/ # 워크스페이스 (자동 생성)
    ├── backend/         # git worktree (feature 브랜치)
    ├── frontend/        # git worktree (feature 브랜치)
    └── shared -> ../my-project/shared  # 심링크
```

git 레포는 `git worktree`로, 나머지 항목은 심링크로 연결됩니다.

### 명령어

```bash
# 워크스페이스 생성 + claude 실행
ccc @feature

# 이미 있으면 기존 워크스페이스 재사용
ccc @feature --continue

# 워크스페이스 목록 + 컨테이너 상태 확인
ccc @

# 워크스페이스 제거 (컨테이너 + worktree 함께 삭제)
ccc @feature rm

# 수정 중인 worktree도 강제 제거
ccc @feature rm -f
```

### 브랜치 처리

- **로컬 브랜치 있음**: 해당 브랜치로 worktree 생성
- **리모트에만 있음**: `origin/<branch>` 기반으로 로컬 브랜치 생성
- **없음**: HEAD 기준으로 새 브랜치 생성

브랜치명의 `/`는 디렉토리명에서 `-`로 변환됩니다 (예: `feature/login` → `my-project--feature-login/`).

### 병렬 작업

각 워크스페이스는 독립 컨테이너를 가지므로 동시에 실행 가능합니다.

```bash
# 터미널 1
cd ~/projects/my-project && ccc @feature --continue

# 터미널 2 (동시에)
cd ~/projects/my-project && ccc @bugfix --continue
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
