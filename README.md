# ATS v9 — Upbit Automated Trading System

업비트 자동매매 봇. BTC 스윙 트레이딩 + 신규상장 스캘핑 + 글로벌 6거래소 아비트라지 모니터링.

## 구조

```
trading-bot.js          메인 엔트리 — 전략/엔진 오케스트레이션
├── strategy-a.js       Strategy A: BTC 1시간봉 스윙 (RSI+MACD+볼린저)
├── strategy-b.js       Strategy B: 업비트 신규상장 스캘핑
├── regime-engine.js    5단계 장세 판별 (BULL_STRONG ~ BEAR_STRONG)
├── calibration-engine.js  Kelly 기준 포지션 사이징 (자동 보정)
├── alpha-engine.js     체결강도 + 김프 + 변동성 적응
├── market-data-service.js  실시간 시세 + 기술 지표 계산
├── dashboard-server.js    웹 대시보드 (차트, 포지션, 수익률)
│
├── cross-exchange-arb.js  김프 기반 크로스 거래소 아비트라지 탐지
├── arb-executor.js        아비트라지 동시 매수/매도 실행
├── arb-data-logger.js     아비트라지 데이터 SQLite 기록
├── exchange-adapter.js    거래소 통합 어댑터 (Upbit/Binance/Bybit/OKX/Gate/Bithumb)
├── exchange-websocket.js  멀티 거래소 WebSocket 매니저
├── upbit-websocket.js     업비트 전용 WebSocket
│
├── data-aggregation-engine.js  OI/LS비율/Taker흐름/신규상장 감지
├── macro-signal-engine.js      김프/펀딩비/공포탐욕지수
├── config.js              환경변수 기반 설정 (전략 파라미터 외부화)
└── lib/indicators.js      공용 기술 지표 (RSI, EMA, MACD, ATR, BB)
```

## 전략 요약

### Strategy A — BTC 1h 스윙
- **진입**: RSI 과매도 + MACD 히스토그램 반전 + 볼린저 하단 근접 + 비하락장
- **익절**: Kelly 기반 목표가 (기본 +3.5%) + 2% 부분익절
- **손절**: ATR x2 트레일링 스탑 (기본 -1.5%)
- **자본 배분**: 전체의 60%

### Strategy B — 신규상장 스캘핑
- **진입**: 업비트 KRW 마켓 신규상장 감지 → 거래량 3x 폭증 + 가격 5%+ 상승 확인
- **익절**: +30% 목표 / +15% 부분익절
- **손절**: -8% 하드스탑 / 2시간 시간스탑
- **자본 배분**: 전체의 40% 중 10%씩

### 리스크 관리
- 일일 최대 손실: 자본의 0.6%
- 일일 최대 거래: 8회
- 연속 손실 제한: 3회 → 서킷브레이커
- 하락장(BEAR_STRONG) 자동 진입 차단

## 설치 및 실행

### 요구사항
- **Node.js 18 이상** — [nodejs.org](https://nodejs.org) 에서 다운로드
- **업비트 API 키** — 발급 방법은 아래 참조

### 1단계: 다운로드

```bash
git clone https://github.com/tnvjaosldka97-rgb/upbit-trading-bot.git
cd upbit-trading-bot
```

또는 GitHub에서 **Code → Download ZIP** 으로 다운로드 후 압축 해제.

### 2단계: 패키지 설치

```bash
npm install
```

### 3단계: 환경변수 설정

`.env.example` 파일을 복사해서 `.env` 파일 생성:

```bash
cp .env.example .env
```

Windows에서는:
```cmd
copy .env.example .env
```

`.env` 파일을 열어서 아래 내용 수정:

```env
# 업비트에서 발급받은 키 입력
UPBIT_ACCESS_KEY=여기에_액세스키_입력
UPBIT_SECRET_KEY=여기에_시크릿키_입력

# 운용 설정
INITIAL_CAPITAL=100000    # 시작 자본 (원)
BOT_MODE=CALIBRATION      # CALIBRATION=보정모드 | LIVE=실전모드
DRY_RUN=true              # true=시뮬레이션 | false=실거래
```

### 4단계: 실행

```bash
node trading-bot.js
```

실행되면 대시보드 접속: **http://localhost:4020**

### npm 스크립트

| 명령어 | 설명 |
|--------|------|
| `npm start` | 기본 실행 (CALIBRATION 모드) |
| `npm run dry` | 시뮬레이션 모드 (실거래 없음, 신호만 확인) |
| `npm run live` | 실거래 모드 (주의: 실제 매수/매도 실행) |

## 업비트 API 키 발급

1. [업비트](https://upbit.com) 로그인
2. **마이페이지 → Open API 관리** 이동
3. **API 키 발급하기** 클릭
4. 권한 체크:
   - [x] 자산조회
   - [x] 주문하기
   - [ ] 출금하기 (체크 안 함)
5. **IP 허용 등록** — 봇을 돌릴 PC/서버의 **공인 IP** 입력
   - 공인 IP 확인: 브라우저에서 `whatismyip.com` 접속
6. 발급된 Access Key, Secret Key를 `.env`에 입력

## 환경변수 전체 목록

| 변수명 | 기본값 | 설명 |
|--------|--------|------|
| `UPBIT_ACCESS_KEY` | (필수) | 업비트 API 액세스 키 |
| `UPBIT_SECRET_KEY` | (필수) | 업비트 API 시크릿 키 |
| `INITIAL_CAPITAL` | 100000 | 시작 자본 (원) |
| `BOT_MODE` | CALIBRATION | CALIBRATION / LIVE |
| `DRY_RUN` | true | true=시뮬 / false=실거래 |
| `PORT` | 4020 | 대시보드 포트 |
| `ARB_ENABLED` | true | 아비트라지 모니터링 on/off |
| `A_RSI_OVERSOLD` | 35 | Strategy A RSI 과매도 기준 |
| `A_DEFAULT_TARGET` | 0.035 | Strategy A 목표 수익률 |
| `A_DEFAULT_STOP` | -0.015 | Strategy A 손절 기준 |
| `B_TARGET_RATE` | 0.30 | Strategy B 목표 수익률 |
| `B_STOP_RATE` | -0.08 | Strategy B 손절 기준 |
| `DEFAULT_USD_KRW` | 1400 | USD/KRW 기본 환율 (폴백) |

전체 설정은 `config.js` 참조.

## 주의사항

- **처음에는 반드시 `DRY_RUN=true`로 실행하세요.** 최소 1~2주 관찰 후 소액으로 전환.
- 실거래 시 손실이 발생할 수 있습니다. 투자 판단은 본인 책임입니다.
- API 키는 절대 외부에 노출하지 마세요. `.env` 파일은 `.gitignore`에 포함되어 있습니다.

## LIVE 전환 체크리스트

`DRY_RUN=true`로 부팅하면 자동으로 preflight 점검이 실행됩니다. 결과를 보고 모든 항목이 PASS인지 확인하세요.

```
[TradingBot]   현재 공인 IP: xxx.xxx.xxx.xxx
[TradingBot]   → 이 IP를 Upbit "Open API 관리 > IP 허용 등록"에 추가해야 합니다.
[TradingBot] --- preflight results ---
[TradingBot]   [PASS] Public IP (xxx.xxx.xxx.xxx)
[TradingBot]   [PASS] API keys (.env)
[TradingBot]   [PASS] clock skew (xxx ms)
[TradingBot]   [PASS] KRW balance (xxx)
[TradingBot]   [PASS] balance >= 50% of INITIAL_CAPITAL
[TradingBot]   [PASS] Upbit API public
```

### 1단계: Upbit IP 화이트리스트 등록
1. 봇 부팅 시 표시된 공인 IP를 복사
2. https://upbit.com/mypage/open_api_management 접속
3. 발급된 API 키의 "IP 허용 등록"에 위 IP 추가
4. 봇 재기동 후 KRW balance가 PASS로 바뀌는지 확인

### 2단계: Telegram 알림 (선택)
1. [@BotFather](https://t.me/BotFather)에서 봇 생성 → 토큰 복사
2. 만든 봇에게 아무 메시지 1회 전송 (chat_id 자동 감지용)
3. `.env`에 `TELEGRAM_TOKEN=...` 추가
4. 봇 재기동 → 활성화 메시지 수신 확인

### 3단계: LIVE 모드 전환
```env
BOT_MODE=LIVE
DRY_RUN=false
```
- preflight 모든 항목 PASS여야 봇이 시작됨
- 한 항목이라도 FAIL이면 자동으로 abort

### 4단계: 모니터링
- **대시보드**: http://localhost:4020 (Trade Journal 섹션에서 sim/live 거래 모두 확인)
- **JSON API**:
  - `/api/status` — 전체 상태
  - `/api/trades?limit=50` — 최근 거래 (SQLite trades.db)
  - `/api/trade-stats` — 전략별 승률/PnL/일별 차트
  - `/api/calibration` — Kelly 캘리브레이션
  - `/api/arb` — 아비트라지 모니터링 상태
- **Telegram**: 진입/청산/부분청산/레짐 전환/서킷브레이커 자동 알림

### 5단계: 서킷 브레이커 (자동 안전장치)
다음 조건 중 하나 발생 시 봇이 자동으로 그날 거래 중단:
- 일일 손실 ≥ 자본의 0.6%
- 일일 거래 ≥ 8회
- 연속 손실 ≥ 3회

발동 시 Telegram에 즉시 알림 전송.
