# Claude Code Container (ccc)

Docker 컨테이너에서 Claude Code를 격리 실행합니다.

## 특징

- 단일 데몬 컨테이너로 모든 프로젝트 공유
- 세션 기반 프로젝트 마운팅 (자동 정리)
- 전역 환경변수 파일 지원
- mise 기반 도구 버전 관리
- `--network host`로 포트 직접 접근

## 설치

```bash
# 저장소 클론
git clone https://github.com/your-username/claude-code-container.git
cd claude-code-container

# 의존성 설치 및 빌드
npm install
npm run build

# 전역 설치
npm link
```

## 빠른 시작

```bash
# 현재 프로젝트에서 Claude 실행 (컨테이너 자동 시작)
ccc

# 컨테이너 쉘 접속
ccc shell

# 임의 명령어 실행
ccc npm install
ccc npm test
```

## 동작 방식

```
~/.ccc/
├── claude/       # Claude credentials
├── projects/     # 프로젝트 심볼릭 링크 (경로 해시 기반, 고정)
├── locks/        # 세션 락 파일 (세션별)
├── mise/         # 공유 mise 캐시
└── env           # 전역 환경변수
```

1. **첫 실행**: Dockerfile로 이미지 빌드 후 컨테이너 생성
2. **프로젝트별**: 경로 해시 기반 고정 심볼릭 링크 생성
3. **세션별**: UUID 락 파일로 동시 접속 관리
4. **종료 시**: 락 삭제, 활성 세션 없으면 심볼릭 링크 정리
5. **크래시 복구**: 다음 실행 시 스테일 심볼릭 링크 정리

컨테이너 경로가 고정되어 `claude --continue`, `--resume` 정상 작동.

## 명령어

### 컨테이너 관리

```bash
ccc start      # 데몬 컨테이너 시작
ccc stop       # 데몬 컨테이너 중지
ccc restart    # 데몬 컨테이너 재시작
ccc rm         # 데몬 컨테이너 삭제
ccc status     # 상태 확인
```

### 실행

```bash
ccc                        # 현재 프로젝트에서 Claude 실행
ccc shell                  # bash 쉘 접속
ccc <command>              # 임의 명령어 실행
ccc --env KEY=VALUE        # 환경변수 설정
```

## 환경변수

`~/.ccc/env` 파일을 편집하여 환경변수 추가:

```bash
# ~/.ccc/env
ANTHROPIC_API_KEY=sk-xxx
MY_CUSTOM_VAR=value
```

모든 세션에 적용됩니다.

## 도구 관리 (mise)

`.mise.toml`이 없는 프로젝트에서 첫 `ccc` 실행 시 도구 자동 감지 여부를 묻습니다.

**프로젝트별 도구**: node, java, python, go, rust, ruby, php, deno, bun

**전역 설치 도구** (이미지에 포함): maven, gradle, yarn, pnpm

`.mise.toml` 예시:
```toml
[tools]
node = "22"
python = "3.12"
```

## 리소스 제한

- **메모리/CPU**: 제한 없음 (호스트 리소스 공유)
- **프로세스**: 512개 제한

## 라이센스

MIT
