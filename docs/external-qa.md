# LINK 외부 QA 실행 안내

외부 QA용 프런트엔드는 별도 Vercel 프로젝트에 빌드하고, 결제 API만 Render에 배포합니다. 브라우저는 한 Vercel HTTPS 주소를 사용합니다. 이 구성은 프로젝트 팀이 배포와 비용을 승인한 뒤 적용합니다.

## Render

| 설정 | 값 |
| --- | --- |
| 워크스페이스 | Hobby |
| 서비스 | Web Service, 권장 표시 이름 `link-kakaopay-qa` |
| 저장소와 브랜치 | `minjun45/link-mvp-web`, 승인된 `feature/kakaopay-test-payment` 커밋 |
| 런타임과 리전 | Native Node, Singapore |
| 인스턴스 | Starter 한 개 |
| 루트 디렉터리 | 저장소 루트 |
| Build Command | `npm ci --omit=dev --ignore-scripts` |
| Start Command | `npm run qa:render` |
| 영속 디스크 | 1GB, `/var/data` |
| Health Check Path | `/healthz` |
| Auto Deploy | Off |

| Render 설정 이름 | 값과 용도 |
| --- | --- |
| `NODE_VERSION` | `24.22.3`. 2026년 11월 11일 공지된 보안 릴리스. 서버는 이 버전 이상의 Node 24.x만 허용 |
| `LINK_QA_ORIGIN` | `https://link-external-qa.vercel.app`. 끝 슬래시 없이 입력 |
| `LINK_QA_DB_PATH` | `/var/data/link.sqlite` |
| `KAKAOPAY_DEV_SECRET_KEY` | 비밀. 개발자센터의 `Secret key(dev)`를 Render 대시보드에 직접 입력 |
| `LINK_QA_ACCESS_KEY` | 비밀. 공개 모드에서도 필수. 무작위 base64url 또는 64자리 무작위 16진수로 만들고 승인된 QA 담당자에게만 전달 |
| `LINK_QA_PUBLIC_ACCESS` | Render 전용 선택 설정. 정확히 `true`인 경우 공개하며, 값이 없거나 그 밖의 값이면 키 인증 적용 |

`PORT`와 `RENDER_EXTERNAL_URL`은 Render가 제공하므로 덮어쓰지 않습니다. 테스트 CID `TC0ONETIME`은 서버에 고정돼 있습니다. 키 형식 검사는 개발 키의 유효성이나 소유권을 확인하지 않으므로 개발자센터에서 키 종류와 앱을 확인합니다.

디스크가 런타임에 실제로 마운트되어 있고 쓰기 가능할 때만 기동합니다. DB 및 SQLite 보조 파일은 같은 디스크에 둡니다. 디스크는 빌드 단계에서 사용할 수 없으며, 단일 인스턴스에서 결제 중 재배포하면 일시 중단될 수 있습니다. [Render Web Services](https://render.com/docs/web-services) · [Render 영속 디스크](https://render.com/docs/disks) · [Render Health Check](https://render.com/docs/health-checks) · [Render Node 버전](https://render.com/docs/node-version) · [Node.js 24.22.3 보안 릴리스](https://nodejs.org/en/blog/release/v24.22.3)

## 운영 중인 QA에서 접속 키 입력 끄기

현재 QA 주소는 `https://link-external-qa.vercel.app`, Render 서비스 주소는 `https://link-kakaopay-qa.onrender.com`입니다.

1. Render의 기존 QA 서비스에서 `LINK_QA_PUBLIC_ACCESS`를 추가하고 값을 정확히 `true`로 저장합니다. `LINK_QA_ORIGIN`에는 위 Vercel 주소를 끝 슬래시 없이 사용하고, 기존 키와 디스크 설정은 유지합니다.
2. **Manual Deploy → Deploy a specific commit**에서 공개 모드를 포함하는 승인된 전체 SHA를 선택합니다. 저장 시 자동 배포되는 옵션을 선택했다면 실제 배포 SHA를 확인합니다. Vercel에 환경변수를 추가하거나 수동 배포할 필요는 없습니다. Git 푸시는 Vercel 프로젝트의 브랜치 설정에 따라 자동 배포를 만들 수 있습니다.
3. Render `/healthz`가 200인지, 새 시크릿 창에서 QA 주문 화면이 접속 키 입력 없이 열리는지 확인합니다. 기존 `/qa-access` 바로가기도 QA 루트로 돌아와야 합니다. 기존 브라우저에서 주문번호와 미확정 결제를 확인하고, 다른 프로필에서 상대 주문 정보가 보이지 않는지 확인합니다.
4. 키 인증으로 돌아가려면 Render에서 값을 `false`로 바꾸거나 변수를 제거한 뒤 같은 버전을 재배포합니다. 새 프로필에서는 다시 키 화면이 표시됩니다. 기존 익명 브라우저 쿠키와 같은 SQLite 디스크를 유지하면, 입장 후 기존 주문이나 미확정 결제를 확인할 수 있습니다.

공개 모드에서는 링크를 아는 누구나 테스트 주문을 시작할 수 있습니다. 호스트·Origin·CSRF 검사는 브라우저에서 출처가 다른 요청을 막는 데 쓰이며, Render 주소로 브라우저 헤더를 흉내 내는 자동화까지 구분하지 못합니다. 공개 모드에서는 새 세션을 인스턴스당 분당 30개로 제한합니다. 초과한 세션 생성 요청은 기존 세션의 API 한도를 소모하지 않습니다. 기존 전체·세션·카카오페이 요청 한도와 결제 동시 처리 한도도 적용됩니다. 이 한도는 프로세스 재시작 시 초기화됩니다.

새 세션 한도를 먼저 소진하면 신규 참여자도 대기할 수 있고 정상 세션을 대량으로 확보한 자동화는 공유 한도나 디스크 용량에 영향을 줄 수 있습니다. QA 운영 시간에만 켜고 Render 응답 오류·429와 디스크 사용량을 확인합니다. 반복적인 이용 지연이나 남용 징후가 있으면 키 인증을 복구합니다. 실제 서비스의 부하 테스트는 하지 않습니다.

## 별도 QA Vercel 프로젝트

1. 외부 QA에 적합한 Vercel 팀 플랜과 GitHub 연결 권한을 확인합니다. Hobby는 개인·비상업용에 한정됩니다. 팀 플랜이나 비용 승인이 필요하면 프로젝트 생성 전에 확인합니다.
2. Vercel의 **Add New → Project → Import Git Repository**에서 같은 공개 저장소를 새 프로젝트로 가져옵니다. 기본 `main` 브랜치의 일반 빌드 `npm run build`와 출력 `dist`로 먼저 배포합니다. 첫 배포는 모의 결제이며, **Settings → Domains**에서 새 프로젝트의 기본 Production `.vercel.app` HTTPS 주소를 확인합니다. 기존 LINK 프로젝트의 설정은 유지합니다.
3. Render에서 **New → Web Service**를 열어 위 설정과 승인된 기능 브랜치를 사용합니다. `LINK_QA_ORIGIN`에 앞에서 확인한 Vercel 주소를 입력하고 개발 키와 무작위 QA 접근 키를 대시보드에 직접 입력합니다. 영속 디스크를 연결하고 **Manual Deploy → Deploy a specific commit**으로 승인된 전체 SHA를 선택합니다. 진행이 완료되면 실제 `onrender.com` 주소와 `/healthz`의 HTTP 200을 확인합니다.
4. 새 Vercel 프로젝트의 **Settings → Environments → Production → Branch Tracking**에서 `feature/kakaopay-test-payment`를 선택합니다. **Build and Deployment**에서 Framework Preset **Other**, Node **24.x**, Install Command `npm ci`, Build Command `npm run qa:vercel`, Output Directory 오버라이드 비활성으로 설정합니다. 설정 저장 뒤에도 최종 QA 빌드를 시작하기 전에 아래 두 값이 준비되어 있어야 합니다. Build Output API가 `.vercel/output`을 사용합니다.

   | Vercel 설정 이름 | 값 |
   | --- | --- |
   | `LINK_QA_ORIGIN` | QA 프로젝트에 지정된 고정 HTTPS origin. Render에 입력한 값과 동일 |
   | `LINK_QA_RENDER_ORIGIN` | 해당 Render Web Service에 부여된 `onrender.com` HTTPS origin |

5. 두 값은 이 QA 프로젝트의 **Production** 환경에만 설정하고 **Automatically expose System Environment Variables**를 켭니다. QA 빌드는 Production 여부, Git 브랜치, Vercel의 Production 도메인과 `LINK_QA_ORIGIN`이 일치하는지 확인한 뒤에만 산출물을 생성합니다. **Deployments → Create Deployment**에서 승인된 SHA를 가리키는 `feature/kakaopay-test-payment` 브랜치를 선택해 Production 대상으로 배포합니다. 최초 연결에서는 양쪽 배포 SHA를 확인합니다. 이후 백엔드만 업데이트할 때는 기존 Vercel 빌드를 그대로 사용할 수 있습니다. 새 시크릿 창에서 비공개 모드는 접속 키 화면, 공개 모드는 주문 화면으로 연결되는지 확인합니다.
6. 카카오페이 개발자센터의 같은 테스트 애플리케이션에 정확한 QA HTTPS 웹 origin을 등록합니다. 서버가 그 origin 아래 성공·취소·실패 복귀 경로를 생성하므로 복귀 시 도메인과 쿠키를 확인합니다. 모바일 브리지에서 돌아오지 않으면 결제를 시작한 브라우저 탭에서 안내를 따릅니다.

`/api/*`, `/checkout/*`, `/return/*`와 QA 접속·복귀 안내를 Render로 전달하는 규칙을 정적 산출물 라우팅 앞에 둡니다. 결제 응답은 캐시를 금지하고 같은 출처의 호스트 전용 쿠키를 사용합니다. Render는 설정된 두 호스트와 고정 QA Origin을 확인하며 전달된 프록시 헤더로 복귀 URL이나 권한을 결정하지 않습니다. [Vercel 외부 Rewrite](https://vercel.com/docs/routing/rewrites) · [Build Output API 설정](https://vercel.com/docs/build-output-api/configuration) · [Vercel Git 배포](https://vercel.com/docs/deployments/git) · [Vercel 시스템 환경변수](https://vercel.com/docs/environment-variables/system-environment-variables) · [Vercel 배포 보호](https://vercel.com/docs/deployment-protection) · [Vercel Hobby 이용약관](https://vercel.com/legal/terms) · [카카오페이 연동 가이드](https://developers.kakaopay.com/docs/payment/online/common)

## 공유 전 통합 검증

- [ ] Render `/healthz`가 준비된 상태에서 200을 반환하고, 디스크가 문제일 때 새 결제 준비가 거부되는지 확인
- [ ] 두 실제 HTTPS 도메인에서 Rewrite, `Origin`, `Location`, `Set-Cookie`, 비캐시 헤더 확인. 비공개 모드에서 입장 쿠키 없는 결제 API 401, 두 모드 모두 서로 다른 QA 브라우저의 상대 거래·주문 조회 404
- [ ] 외부 시크릿 창과 PC가 꺼진 상태에서 QA 주소 접속. 기존 Production 주소와 모의 주문 별도로 확인
- [ ] PC에서 테스트 결제 승인·취소·실패·미확정 처리. 승인 후 서버 재시작하고 같은 브라우저에서 같은 거래와 주문번호 복구
- [ ] Android Chrome·iPhone Safari에서 같은 기기 카카오톡 연결과 LINK 복귀. TalkBack·VoiceOver 및 가능한 SenseReader에서 상태 안내, 완료 제목 초점, 주문 현황과 픽업 확인
- [ ] 플랫폼 로그를 테스트 거래 한 건으로 점검. 복귀 요청 쿼리나 토큰이 일반 테스터·외부 로그 수집기에 노출되지 않아야 함. 필요하면 로그 포워딩을 끄고 접근 권한·보존을 제한
- [ ] GitHub, Render, Vercel 계정 MFA와 저장소 접근 범위를 점검. 비공개 모드에서는 승인된 참여자에게 키를 별도로 전달하고, 공개 모드에서는 운영 시간과 키 인증 복구 조건을 확인

접근 키는 입장만 제한합니다. 결제와 주문은 서로 다른 익명 세션으로 분리되며, 호스트를 변경하거나 쿠키를 지우면 기존 세션을 되찾을 수 없습니다. 승인 결과가 불확실하면 같은 거래를 조회합니다. TID 없는 준비 유실은 동일 세션에서 새 거래를 차단합니다. 카카오페이 자체의 결제 화면이나 운영용 인증 접근성은 실기기 테스트에서 확인합니다.

## 비용과 종료

Render Hobby 월 구독료는 $0, Starter는 월 $7 수준이며 실행 시간으로 비례 과금됩니다. 영속 디스크는 월 $0.25/GB 정가입니다. 14일 Starter 한 개와 1GB 기준으로 약 $3.5를 예산으로 잡고, 세금·추가 사용량·계정별 과금과 Vercel 구독료는 대시보드에서 확인합니다. 신규 Render Hobby는 워크스페이스 공용 월 송신량 5GB를 포함하며 초과분은 공식 정책상 GB당 $0.15입니다. [Render 요금](https://render.com/pricing) · [Render 워크스페이스 플랜](https://render.com/docs/new-workspace-plans) · [Vercel 요금](https://vercel.com/pricing)

배포 실패 시 승인된 이전 코드로 되돌리고 같은 디스크에서 미확정 거래를 먼저 확인합니다. 완료된 거래가 누락될 수 있으므로, 거래 대조 없이 이전 시점 DB 스냅샷으로 덮어쓰지 않습니다.

2026년 12월 4일 전후 종료 시 미확정 건을 확인하고 필요한 최소 QA 결과만 보존합니다. 팀 승인 후 QA Vercel 주소와 연결, Render 서비스·디스크, QA 접근 키, 카카오페이 테스트 도메인과 임시 권한을 정리하고 잔여 과금을 확인합니다. 기존 GitHub 저장소와 Vercel Production은 계속 사용합니다.
