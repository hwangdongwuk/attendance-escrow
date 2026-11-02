# attendance-escrow — 출석 보증금 에스크로

블록체인기술과응용 팀과제. 스터디 출석 보증금을 스마트컨트랙트 에스크로로 운영한다.

- 체인: Sepolia 테스트넷 / 컨트랙트: Hardhat 2 + Solidity 0.8.24 / 프론트: HTML + ethers.js / 호스팅: GitHub Pages (https://hwangdongwuk.github.io/attendance-escrow/), 플랜 B AWS S3
- 구상안: `팀과제_에스크로_개발구상안_v0.2_20261022.pdf` (OneDrive 학교 폴더)
- 필수 기능 7: 생성, 예치, 회차 열기, 증빙 해시 제출, 상호 확인, 정산, 만료 반환(closeExpired)

## 폴더
| 폴더 | 내용 |
|---|---|
| contracts/ | StudyEscrow.sol(에스크로), AttendanceSBT.sol(출석 SBT, ERC-5192), MockSDT.sol(테스트 토큰) |
| test/ | Hardhat 테스트 (목표 18개) |
| scripts/ | deploy.js (MockSDT → AttendanceSBT → StudyEscrow 배포, web/config.js·abi.js 생성) |
| web/ | 모바일 웹 프론트. index.html + config.js/abi.js(deploy.js가 생성). `npm run deploy:pages`로 gh-pages 브랜치에 배포 |

## 실행
```
npm install
npm test                 # 로컬 Hardhat 네트워크에서 테스트
npm run compile
npx hardhat node         # 로컬 노드 (별도 터미널)
npm run deploy:local     # 로컬 노드에 배포, web/config.js 갱신
npm run deploy:sepolia   # .env 필요
npm run verify -- <주소> <생성자인자>
```

## 환경변수
`.env.example`을 복사해 `.env`를 만든다. `.env`는 git에 올라가지 않는다.

## 프론트 보기
- 공개 주소: https://hwangdongwuk.github.io/attendance-escrow/ (gh-pages 브랜치 = web/ 폴더. 바꾼 뒤 `npm run deploy:pages`로 다시 올린다)
- 로컬: `npx hardhat node` 실행 후 `npm run deploy:local`, 이어서 `web/` 폴더를 정적 서버로 연다(예: `cd web && python -m http.server 8080`).
- 현재 `web/config.js`는 로컬 체인(chainId 31337) 주소다. Sepolia 배포 후 `npm run deploy:sepolia`가 다시 생성한다.
