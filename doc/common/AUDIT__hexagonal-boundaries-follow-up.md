# CCC hexagonal 경계 평가와 후속 작업

평가 기준일: 2026-10-13. 상태: 당시 관찰을 보존한 역사 기록.

2026-10-22 갱신: 아래의 현재형 표현과 후속 목록은 평가 당시 상태다. 이후 컨테이너 생성의 네이티브 실행은 adapter로, Windows 복구 판단은 application으로 분리됐고 공유 잠금의 프로세스 사실도 정규화됐다. 이 문서를 현재 미완료 목록으로 사용하지 않는다. 최신 완료 판단에는 기존 ADR·계약·이행 계획과 해당 변경의 실제 검증 범위를 적용한다.

현재 CCC는 application과 ports를 통한 의존성 역전, domain의 판단 로직 분리 등 hexagonal 아키텍처의 기반을 갖췄다. 다만 확인한 컨테이너 수명주기와 공유 잠금 경로에는 정책, 플랫폼 구현, 의존성 조립이 섞여 있다. 경계 분리가 완료된 상태로 평가하기는 어렵다. Hexagonal에는 모든 프로젝트에 적용되는 단 하나의 최선 형태가 없으며, 변경의 격리와 검증 가능성을 기준으로 개선해야 한다.

이 평가는 해당 경로를 중심으로 한 검토이며 저장소 전체의 적합성 판정은 아니다. 기존 [목표 아키텍처 ADR](ADR__ccc-target-architecture.md), [아키텍처 계약](SPEC__ccc-architecture-contracts.md), [이행 계획](PLAN__ccc-architecture-migration.md)을 기준으로 후속 작업을 연결한다.

## 유지할 구조

- `src/application/container-create-lifecycle.ts`는 주입된 포트를 통해 생성, 검증, 실패 시 보상 처리를 조율한다. 외부 실행 구현을 직접 가져오지 않는 구조를 유지한다.
- `src/domain`, `src/ports`, `src/adapters`, `src/composition`의 기존 분리를 활용한다. 함수 주입과 판별 가능한 결과 타입으로 필요한 경계를 표현할 수 있다.
- 컨테이너 ID 고정, 파일시스템 소스 검증, 잠금 소유권 확인, 실패 시 정리 등 기존 안전 조건을 유지한다.

## 확인한 개선 지점

| 위치 | 현재 관찰 | 후속 방향 |
| --- | --- | --- |
| `src/docker.ts` | 평가 당시 약 2,800줄이며 마운트 검증 정책, 런타임 관측, 수명주기 조율과 의존성 연결이 함께 남아 있다. | 판단과 상태 전이는 domain 또는 application으로, Docker 호출과 응답 해석은 adapter로, 구현체 연결은 composition으로 분리한다. |
| `src/composition/container-create-lifecycle.ts` | `spawnSync`로 생성과 제거를 수행하고 종료 상태 및 출력을 해석한다. | 네이티브 실행과 응답 해석을 adapter로 이동하고 composition은 연결에 집중하도록 검토한다. |
| `src/ports/container-create-lifecycle.ts` | `fixSsh`, `syncGit`, `syncMcp`, `finish` 등 세부 절차가 하나의 포트 묶음에 들어 있다. | 각 기능의 변경 이유와 응집도를 검토한다. 유스케이스에 필요한 절차는 유지하되 역할이 다른 기능은 분리한다. 포트 수만으로 품질을 판단하지 않는다. |
| `packages/device-lab/providers/application/shared-mutation-lock.mjs` | Windows 시작 토큰의 문자열 형식과 시각 해석이 application에 들어 있다. | adapter가 플랫폼 관측을 정규화하고 내부 정책은 정규화된 사실로 잠금 회수 여부를 판단하도록 바꾼다. |

## 이번 장애 수정과 남은 경계 작업

Docker Desktop이 `/var/run/docker.sock`의 bind 소스를 `/run/host-services/docker.proxy.sock`으로 기록하면서 생성 검증이 실패했다. 기본 소켓을 사용하는 Docker Desktop에 한해 해당 별칭을 인정하고, 실제 연결 대상이 현재 Docker 데몬인지 검증하도록 수정했다. 별칭의 플랫폼 해석과 내부 검증 정책을 어디서 나눌지는 후속 검토 대상이다.

`kjkim1`의 수명주기 잠금은 종료된 소유자의 PID를 `OpenConsole`이 재사용하면서 남았다. 잠금에는 기존 프로세스 identity가 없었고, PID 생존 여부만으로는 회수할 수 없었다. Windows 비동기 획득 경로에서 현재 프로세스의 시작 시각이 잠금 생성 시각보다 1초를 초과해 늦으면 회수하도록 수정했다. 실제 잠금은 이 코드로 자동 회수한 뒤 획득 및 해제했다.

잠금 수정은 동작상의 원인을 해결했지만 Windows 시작 토큰 해석이 application에 추가됐다. 다음 리팩터링에서 이 해석을 adapter로 이동한다. 프로세스 관측이 불가능하거나 시작 시각을 확정할 수 없는 경우에는 잠금을 보호하며, 실제 소유자가 살아 있는 잠금도 보호해야 한다. 동기 획득과 wait budget을 사용하는 경로의 처리 차이는 후속 검토 시 명시적으로 확인한다.

수정 당시 관련 테스트 파일 2개에서 440개 테스트가 통과했고, 소스 및 테스트 타입 검사가 통과했다. 실제 `ccc true` 실행도 컨테이너 생성과 초기화를 완료했다. 이 결과는 해당 수정의 검증이며 저장소 전체의 아키텍처 완성도를 증명하지 않는다.

## 이어서 진행할 순서

추가 장애 확인에서 Codex는 `installation_id`에 `fchmod`를 호출하므로 그룹 읽기 및 쓰기 권한만으로는 충분하지 않았다. Windows SID 소유권과 컨테이너 사용자를 확인한 뒤 확인된 이전 UID/GID의 루트 실행 상태 파일과 mutable 디렉터리를 정규화하는 경로를 `src/adapters/windows-credential-access.ts`에 추가했다. 데몬 패키지가 없는 경우에는 설치된 공식 CLI 패키지를 검증해 공유 볼륨에 준비하며, 이전 컨테이너의 `/tmp/codex-daemon-<uid>`를 가리키는 끊어진 제어 소켓 링크는 사용 중인 다른 서버를 보호하면서 격리한다. 새 컨테이너에서 데몬 시작과 resume UI 초기화를 확인했다. 이 adapter에 모인 관측, 회수 정책, 파일 변경 책임도 후속 경계 분리 대상이다.

1. 기존 ADR, 계약, 이행 계획과 현재 변경 상태를 읽고 이번 항목이 기존 작업 패킷에 어떻게 연결되는지 확인한다.
2. 공유 잠금의 Windows 시작 토큰 해석을 우선 분리한다. 프로세스 시작 사실과 관측 실패를 표현할 포트 결과를 정하고 host 및 provider 구현의 의미를 일치시킨다.
3. `docker.ts`에서 마운트 소스 관측과 허용 정책의 책임을 분리한다. Docker Desktop 별칭, 사용자 지정 소켓, 다른 데몬 연결 거부를 함께 유지한다.
4. 컨테이너 생성 composition의 네이티브 실행을 adapter로 이동한다. application의 생성 및 보상 처리 순서는 유지한다.
5. 생성 포트의 역할을 검토하고 서로 다른 변경 이유를 가진 기능을 필요한 만큼 분리한다.

한 번에 하나의 관찰 가능한 동작을 옮긴다. 파일 수나 줄 수 감소를 완료 기준으로 삼지 않는다.

## 완료 판단과 검증

- Domain과 application이 OS 명령, Docker 응답 형식, Windows 시작 토큰 형식을 직접 해석하지 않는다.
- Composition은 정책 판단 및 네이티브 실행 구현을 보유하지 않고 필요한 구현체를 연결한다.
- 포트는 유스케이스에 필요한 기능과 관측 결과를 표현하며 외부 구현의 세부 형식에 결합되지 않는다.
- 잠금 테스트는 PID 재사용 회수, 원래 소유자 보호, 관측 실패 보호, 잘못된 시작 시각 보호를 확인한다.
- 컨테이너 테스트는 Desktop 별칭 허용과 다른 데몬 거부, 생성 검증 실패 시 보상 처리를 확인한다.
- 관련 아키텍처 계약 테스트, 타입 검사, 변경 동작의 회귀 테스트와 실제 Windows 실행으로 의미 보존을 확인한다.

시작 시 확인할 테스트는 `src/__tests__/architecture/session-guard-identity.test.ts`, `src/__tests__/shared-mutation-lock.test.ts`, `src/__tests__/docker.test.ts`, `src/__tests__/architecture/container-create-lifecycle-facade.test.ts`다.
